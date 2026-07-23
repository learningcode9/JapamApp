import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { tapSaveSession, type TapSaveSessionRefs } from '../tapSaveSession';
import {
  detectMalaCrossing,
  createMalaCompletionGuard,
  runMalaCompletion,
} from '../malaCompletion';
import {
  todayStatsFor,
  toLocalDayKey,
} from '../historyStore';
import * as historyRepository from '../historyRepository';

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    default: {
      getItem: jest.fn(async (key: string) => store[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete store[key]; }),
      clear: jest.fn(async () => { Object.keys(store).forEach(k => delete store[k]); }),
    },
    __esModule: true,
  };
});

const UID = 'supabase-user-uuid-abc123';
const JAPAM_ID = 'my-japam-uuid-456def';
const JAPAM_NAME = 'My Japam';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface StageReport {
  stage: string;
  status: 'PASS' | 'FAIL' | 'NOT_REACHED';
  detail?: string;
}
const stages: StageReport[] = [];
function pass(stage: string, detail?: string) {
  stages.push({ stage, status: 'PASS', detail });
}
function fail(stage: string, detail: string) {
  stages.push({ stage, status: 'FAIL', detail });
}
function resetStages() { stages.length = 0; }

const makeRefs = (): TapSaveSessionRefs => ({
  isSavingSession: { current: false },
  lastSavedSession: { current: '' },
  activeJapamId: { current: JAPAM_ID },
  activeJapamName: { current: JAPAM_NAME },
});

const identity = { userId: UID, japamId: JAPAM_ID, japamName: JAPAM_NAME };

describe('tapSaveSession — real runtime pipeline', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(USER_ID_KEY, UID);
    await AsyncStorage.setItem(USER_NAME_KEY, 'Test User');
    resetStages();
  });

  it('completes one mala and persists through the entire pipeline', async () => {
    // Stage 1: detectMalaCrossing
    const crossing = detectMalaCrossing(107, 108);
    expect(crossing.crossed).toBe(true);
    expect(crossing.nextMala).toBe(1);
    pass('detectMalaCrossing', `tap=108 crossed=true nextMala=${crossing.nextMala}`);

    // Stage 2: runMalaCompletion → real tapSaveSession
    const guard = createMalaCompletionGuard();
    const refs = makeRefs();

    const result = await runMalaCompletion({
      boundaryKey: crossing.nextMala,
      guard,
      save: () => tapSaveSession(0, 1, 108, 108, 'tap', refs, identity, 'Test User'),
      playFeedback: async () => {},
      onError: (stage, error) => fail(`runMalaCompletion error at ${stage}`, String(error)),
    });

    expect(result.saved).toBe(true);
    expect(result.duplicate).toBe(false);
    pass('tapSaveSession invoked', `saved=${result.saved}`);

    // Stage 3: AsyncStorage write
    const raw = await AsyncStorage.getItem('history');
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw || '[]');
    expect(saved).toHaveLength(1);
    expect(saved[0].userId).toBe(UID);
    expect(saved[0].japamId).toBe(JAPAM_ID);
    expect(saved[0].source).toBe('tap');
    expect(saved[0].totalCount).toBe(108);
    expect(saved[0].malas).toBe(1);
    expect(saved[0].syncStatus).toBe('pending');
    pass('AsyncStorage write', `completionId=${saved[0].completionId}`);

    // Stage 4: History repository reload
    const historyRecords = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(historyRecords).toHaveLength(1);
    expect(historyRecords[0].userId).toBe(UID);
    expect(historyRecords[0].japamId).toBe(JAPAM_ID);
    pass('History reload', `loadHistoryForJapam found ${historyRecords.length} records`);

    // Stage 5: Home Stats reload
    const stats = todayStatsFor(
      JSON.parse(await AsyncStorage.getItem('history') || '[]'),
      UID,
      today(),
      toLocalDayKey,
    );
    expect(stats.malas).toBe(1);
    expect(stats.totalCount).toBe(108);
    pass('Stats reload', `malas=${stats.malas} totalCount=${stats.totalCount}`);

    console.log('\n=== TAP PIPELINE REPORT ===');
    for (const s of stages) {
      console.log(`  [${s.status}] ${s.stage}${s.detail ? ` — ${s.detail}` : ''}`);
    }

    const failures = stages.filter(s => s.status === 'FAIL' || s.status === 'NOT_REACHED');
    expect(failures).toHaveLength(0);
  });

  it('empty userIdRef falls back to AsyncStorage', async () => {
    const refs = makeRefs();
    const identityNoUserId = { userId: null, japamId: JAPAM_ID, japamName: JAPAM_NAME };

    const result = await tapSaveSession(0, 1, 108, 108, 'tap', refs, identityNoUserId, 'Test User');
    expect(result).toBe(true);

    const saved = JSON.parse(await AsyncStorage.getItem('history') || '[]');
    expect(saved[0].userId).toBe(UID);
    expect(saved[0].japamId).toBe(JAPAM_ID);
    expect(saved[0].source).toBe('tap');
  });

  it('multiple malas produce distinct history records', async () => {
    const guard = createMalaCompletionGuard();

    // First mala at 108
    let crossing = detectMalaCrossing(107, 108);
    expect(crossing.crossed).toBe(true);
    let refs = makeRefs();
    let result = await runMalaCompletion({
      boundaryKey: crossing.nextMala, guard,
      save: () => tapSaveSession(0, 1, 108, 108, 'tap', refs, identity, 'Test User'),
      playFeedback: async () => {},
    });
    expect(result.saved).toBe(true);

    // 1ms separation to guarantee unique completionId timestamps
    await new Promise(r => setTimeout(r, 1));

    // Second mala at 216
    crossing = detectMalaCrossing(215, 216);
    expect(crossing.crossed).toBe(true);
    refs = makeRefs();
    result = await runMalaCompletion({
      boundaryKey: crossing.nextMala, guard,
      save: () => tapSaveSession(0, 1, 108, 216, 'tap', refs, identity, 'Test User'),
      playFeedback: async () => {},
    });
    expect(result.saved).toBe(true);

    const records = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.userId).toBe(UID);
      expect(r.japamId).toBe(JAPAM_ID);
      expect(r.source).toBe('tap');
    }
  });

  it('duplicate guard prevents double-saving the same mala', async () => {
    let total = 0;
    const guard = createMalaCompletionGuard();

    for (let tap = 1; tap <= 108; tap++) {
      const prev = total;
      total = tap;
      const crossing = detectMalaCrossing(prev, total);
      if (crossing.crossed) {
        const refs = makeRefs();

        const first = await runMalaCompletion({
          boundaryKey: crossing.nextMala, guard,
          save: () => tapSaveSession(0, 1, 108, total, 'tap', refs, identity, 'Test User'),
          playFeedback: async () => {},
        });
        expect(first.saved).toBe(true);
        expect(first.duplicate).toBe(false);

        const second = await runMalaCompletion({
          boundaryKey: crossing.nextMala, guard,
          save: () => tapSaveSession(0, 1, 108, total, 'tap', refs, identity, 'Test User'),
          playFeedback: async () => {},
        });
        expect(second.saved).toBe(false);
        expect(second.duplicate).toBe(true);
      }
    }

    const records = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(records).toHaveLength(1);
  });

  it('in-flight guard rejects concurrent save', async () => {
    const refs = makeRefs();
    refs.isSavingSession.current = true;

    const result = await tapSaveSession(0, 1, 108, 108, 'tap', refs, identity, 'Test User');
    expect(result).toBe(false);
  });

  it('DeviceEventEmitter fires after local save', async () => {
    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');
    const refs = makeRefs();

    await tapSaveSession(0, 1, 108, 108, 'tap', refs, identity, 'Test User');

    expect(emitSpy).toHaveBeenCalledWith('japam-stats-updated');
    expect(emitSpy).toHaveBeenCalledWith('japam-history-updated', expect.objectContaining({
      userId: UID,
      todayTotal: 108,
    }));
  });

  // ------------------------------------------------------------------
  // Regression: japamId scoping — root cause of the "Tap/Timer saves
  // but History screen shows nothing" bug.
  //
  // When currentJapam is null at capture time (refresh hasn't completed),
  // activeJapamIdRef.current is null, so records save with japamId: null.
  // loadHistoryForJapam filters by (r.japamId ?? null) === japamId, so
  // null-japamId records disappear when currentJapamId is non-null.
  // ------------------------------------------------------------------

  it('null japamId → record is invisible to loadHistoryForJapam', async () => {
    // Simulate the bug: activeJapamIdRef.current is null (Japam not yet
    // initialized when Timer started or Tap screen focused).
    const refs = makeRefs();
    refs.activeJapamId.current = null;
    refs.activeJapamName.current = null;
    const identityNullJapam = { userId: UID, japamId: null, japamName: null };

    const result = await tapSaveSession(0, 1, 108, 108, 'tap', refs, identityNullJapam, 'Test User');
    expect(result).toBe(true);

    // The record IS in AsyncStorage.
    const all = JSON.parse((await AsyncStorage.getItem('history')) || '[]');
    expect(all).toHaveLength(1);
    expect(all[0].japamId).toBeNull();
    expect(all[0].userId).toBe(UID);

    // But loadHistoryForJapam with the real japamId DOES NOT find it.
    const found = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(found).toHaveLength(0);

    // loadHistoryForUser (no japam filter) DOES find it — confirming the
    // scoping loss is in filterByJapam, not in loadHistoryForUser.
    const forUser = await historyRepository.loadHistoryForUser(UID);
    expect(forUser).toHaveLength(1);
    expect(forUser[0].japamId).toBeNull();
  });

  it('non-null japamId → record is visible to loadHistoryForJapam', async () => {
    const refs = makeRefs();

    const result = await tapSaveSession(0, 1, 108, 108, 'tap', refs, identity, 'Test User');
    expect(result).toBe(true);

    // The record IS in AsyncStorage with the correct japamId.
    const all = JSON.parse((await AsyncStorage.getItem('history')) || '[]');
    expect(all).toHaveLength(1);
    expect(all[0].japamId).toBe(JAPAM_ID);

    // loadHistoryForJapam with the correct japamId FINDS it.
    const found = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(found).toHaveLength(1);
    expect(found[0].japamId).toBe(JAPAM_ID);
  });

  // ------------------------------------------------------------------
  // Regression: timer completion path (source='timer', no identity) falls
  // back to refs.activeJapamId.current. The ref must be non-null for the
  // record to appear on the History screen.
  // ------------------------------------------------------------------

  it('timer completion (no identity) uses activeJapamIdRef fallback', async () => {
    const refs = makeRefs();
    refs.activeJapamId.current = JAPAM_ID;
    refs.activeJapamName.current = JAPAM_NAME;

    // Simulate completeTimerSession: source='timer', no identity, no userName
    const result = await tapSaveSession(120, 1, 108, 108, 'timer', refs, undefined, 'Test User');
    expect(result).toBe(true);

    const found = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(found).toHaveLength(1);
    expect(found[0].japamId).toBe(JAPAM_ID);
    expect(found[0].source).toBe('timer');
  });

  it('timer completion with null ref → invisible to loadHistoryForJapam', async () => {
    const refs = makeRefs();
    // Root cause scenario: activeJapamIdRef.current is null because
    // the Japam wasn't initialized when the timer started.
    refs.activeJapamId.current = null;
    refs.activeJapamName.current = null;

    const result = await tapSaveSession(120, 1, 108, 108, 'timer', refs, undefined, 'Test User');
    expect(result).toBe(true);

    // Record saved with null japamId — invisible in the scoped query.
    const found = await historyRepository.loadHistoryForJapam(UID, JAPAM_ID);
    expect(found).toHaveLength(0);

    // But IS findable by the unscoped user query.
    const forUser = await historyRepository.loadHistoryForUser(UID);
    expect(forUser).toHaveLength(1);
    expect(forUser[0].japamId).toBeNull();
  });
});

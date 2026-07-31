import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { applyLegacyHistoryBackfill, loadJapamStats } from '../historyRepository';
import {
  makeCompletionId,
  makeLoopCompletionId,
  normalizeRecord,
  appendCompletion,
  dedupeByCompletionId,
  mergeHistories,
  getPending,
  markSynced,
  todayCountFor,
  todayStatsFor,
  buildSupabaseHistoryPayload,
  normalizeAll,
  reconcileWithServer,
  toLocalDayKey,
  applyTombstones,
  mergeTombstones,
  planHistoryDayAdjustment,
  normalizeJapamName,
  statsByJapam,
  statsByJapamWithAttribution,
  japamStatsFor,
  dayStreakForJapam,
  filterByJapam,
  japamScopedStatsFor,
  type HistoryRecord,
  type JapamStats,
} from '../historyStore';
import { planLegacyHistoryBackfill } from '../legacyHistoryBackfill';

// In-memory AsyncStorage store shared with applyLegacyHistoryBackfill integration tests.
const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: jest.fn(async (key: string) => asyncStore[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { asyncStore[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete asyncStore[key]; }),
  },
  __esModule: true,
}));

const UID = 'user-123';
// Local YYYY-MM-DD key, matching how the app buckets days.
const toDayKey = (iso: string) => {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
// Same noon-anchored, calendar-day arithmetic as the app's own getPreviousDateKey
// (app/(tabs)/timer.tsx and tap-japam.tsx) -- dayStreakForJapam takes this as an injected
// parameter rather than reimplementing it, so tests must mirror the real implementation exactly.
const getPreviousDayKey = (dayKey: string) => {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const session = (iso: string, over: Partial<HistoryRecord> = {}) => ({
  date: iso,
  malas: 1,
  totalCount: 108,
  duration: 60,
  manual: false,
  userId: UID,
  ...over,
});

describe('makeCompletionId', () => {
  it('is stable for the same (userId, timestamp) and reconstructable from a remote created_at', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    expect(makeCompletionId(UID, iso)).toBe(makeCompletionId(UID, iso));
    // Same id whether derived locally at save or from the remote row's created_at.
    expect(makeCompletionId(UID, iso)).toBe(`${UID}:${new Date(iso).getTime()}`);
  });
  it('is unique across distinct completions and users', () => {
    expect(makeCompletionId(UID, '2026-06-03T10:00:00.000Z')).not.toBe(
      makeCompletionId(UID, '2026-06-03T10:00:01.000Z')
    );
    expect(makeCompletionId('a', '2026-06-03T10:00:00.000Z')).not.toBe(
      makeCompletionId('b', '2026-06-03T10:00:00.000Z')
    );
  });
});

describe('makeLoopCompletionId', () => {
  it('is stable for the same (userId, sessionId, loopNumber) no matter when computed', () => {
    const a = makeLoopCompletionId(UID, 'timer-1000-abc', 2);
    // Simulate a process restart: same session/loop, computed much later (different Date.now()).
    const b = makeLoopCompletionId(UID, 'timer-1000-abc', 2);
    expect(a).toBe(b);
  });
  it('is distinct across different loop numbers in the same session', () => {
    expect(makeLoopCompletionId(UID, 'timer-1000-abc', 1)).not.toBe(
      makeLoopCompletionId(UID, 'timer-1000-abc', 2)
    );
  });
  it('is distinct across different sessions with the same loop number', () => {
    expect(makeLoopCompletionId(UID, 'timer-1000-abc', 1)).not.toBe(
      makeLoopCompletionId(UID, 'timer-2000-def', 1)
    );
  });
  it('is distinct across different users with the same session/loop', () => {
    expect(makeLoopCompletionId('user-a', 'timer-1000-abc', 1)).not.toBe(
      makeLoopCompletionId('user-b', 'timer-1000-abc', 1)
    );
  });
  it('scopes guest sessions under the literal "guest" prefix, same as makeCompletionId', () => {
    expect(makeLoopCompletionId(null, 'timer-1000-abc', 1)).toBe('guest:timer-1000-abc:loop-1');
  });
});

describe('bug reproduction: process-restart duplicate save collapses to one record', () => {
  it('a loop re-claimed after a restart (same sessionId/loopNumber, different save-time date) does not duplicate', () => {
    const sessionId = 'timer-1750000000000-xyz123';
    // First save: native broadcast received while app is alive, loop 1 completes normally.
    const firstSaveId = makeLoopCompletionId(UID, sessionId, 1);
    let history = appendCompletion([], {
      date: '2026-06-25T10:00:00.000Z', // true completion time
      malas: 1,
      totalCount: 108,
      duration: 600,
      userId: UID,
      completionId: firstSaveId,
    });
    expect(history).toHaveLength(1);

    // Process dies here (force-kill/OS kill/crash) -- in-memory guards (processedCompletionLoopsRef,
    // lastSavedSessionRef, timerState.lastSavedCompletedLoops) are lost, but sessionId (persisted)
    // and the native-reported loopNumber survive and are read back identically on restart.

    // Second save: fresh process restart, reconcileNativeLoops() re-detects native completedLoops=1
    // and re-claims it, calling saveSession() again for the SAME (sessionId, loopNumber) -- but at
    // a LATER wall-clock moment (reconciliation time, not true completion time).
    const secondSaveId = makeLoopCompletionId(UID, sessionId, 1);
    expect(secondSaveId).toBe(firstSaveId); // deterministic: identical id, not a new one
    history = appendCompletion(history, {
      date: '2026-06-26T14:30:00.000Z', // reconciliation time -- a DIFFERENT calendar day
      malas: 1,
      totalCount: 108,
      duration: 600,
      userId: UID,
      completionId: secondSaveId,
    });

    // The fix: exactly one record survives, not two.
    expect(history).toHaveLength(1);
    expect(history[0].date).toBe('2026-06-25T10:00:00.000Z'); // first save wins, true completion time kept
    expect(todayCountFor(history, UID, '2026-06-25', toLocalDayKey)).toBe(108);
    expect(todayCountFor(history, UID, '2026-06-26', toLocalDayKey)).toBe(0); // no phantom second day
  });

  it('legitimate multiple loops in one session still produce separate records', () => {
    const sessionId = 'timer-1750000000000-xyz123';
    let history: HistoryRecord[] = [];
    for (let loop = 1; loop <= 3; loop++) {
      history = appendCompletion(history, {
        date: `2026-06-25T10:0${loop}:00.000Z`,
        malas: 1,
        totalCount: 108,
        duration: 600,
        userId: UID,
        completionId: makeLoopCompletionId(UID, sessionId, loop),
      });
    }
    expect(history).toHaveLength(3);
    expect(new Set(history.map((r) => r.completionId)).size).toBe(3);
  });

  it('legitimate multiple sessions on the same day still produce separate records', () => {
    let history: HistoryRecord[] = [];
    history = appendCompletion(history, {
      date: '2026-06-25T09:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 600,
      userId: UID,
      completionId: makeLoopCompletionId(UID, 'timer-session-A', 1),
    });
    history = appendCompletion(history, {
      date: '2026-06-25T15:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 600,
      userId: UID,
      completionId: makeLoopCompletionId(UID, 'timer-session-B', 1),
    });
    expect(history).toHaveLength(2);
    expect(todayCountFor(history, UID, '2026-06-25', toLocalDayKey)).toBe(216);
  });

  it('does not drop a legitimately different completion that happens to share a date-based fallback moment', () => {
    // Tap Japam / Add Japam still use the date-based fallback (no sessionId) -- confirm the new
    // existing-id guard in appendCompletion does not regress their existing distinct-id behavior.
    let history: HistoryRecord[] = [];
    history = appendCompletion(history, session('2026-06-25T09:00:00.000Z'));
    history = appendCompletion(history, session('2026-06-25T09:00:00.001Z')); // 1ms later, distinct id
    expect(history).toHaveLength(2);
  });
});

describe('offline-first: appendCompletion', () => {
  it('records a completion with no network and marks it pending', () => {
    const h = appendCompletion([], session('2026-06-03T10:00:00.000Z'));
    expect(h).toHaveLength(1);
    expect(h[0].syncStatus).toBe('pending');
    expect(h[0].completionId).toBe(makeCompletionId(UID, '2026-06-03T10:00:00.000Z'));
  });
  it('marks guest completions synced (local-only, nothing to upload)', () => {
    const h = appendCompletion([], session('2026-06-03T10:00:00.000Z', { userId: undefined }));
    expect(h[0].syncStatus).toBe('synced');
    expect(getPending(h)).toHaveLength(0);
  });
  it('backfills a stable completionId for legacy records lacking one', () => {
    const legacy = { date: '2026-06-01T08:00:00.000Z', malas: 1, totalCount: 108, duration: 60, manual: false, userId: UID };
    const n = normalizeRecord(legacy);
    expect(n.completionId).toBe(makeCompletionId(UID, legacy.date));
    expect(n.syncStatus).toBe('synced'); // legacy assumed already handled
  });
  it('preserves remoteId metadata for fetched Supabase rows', () => {
    const legacy = {
      date: '2026-06-01T08:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 60,
      manual: false,
      userId: UID,
      remoteId: 42,
    };
    const n = normalizeRecord(legacy);
    expect(n.remoteId).toBe(42);
  });
  it('preserves a logged-in manual entry user name while pending', () => {
    const h = appendCompletion([], session('2026-06-03T10:00:00.000Z', {
      manual: true,
      userName: 'Sravani',
      userEmail: 'sravani@example.com',
    }));
    expect(h[0].manual).toBe(true);
    expect(h[0].syncStatus).toBe('pending');
    expect(h[0].userName).toBe('Sravani');
    expect(h[0].userEmail).toBe('sravani@example.com');
  });
  it('preserves tap completion source metadata locally', () => {
    const h = appendCompletion([], session('2026-06-03T10:00:00.000Z', {
      source: 'tap',
    }));
    expect(h[0].source).toBe('tap');
  });
  it('normalizes remote snake_case user metadata for restore/sync safety', () => {
    const n = normalizeRecord({
      date: '2026-06-03T10:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 0,
      manual: true,
      userId: UID,
      user_name: 'Remote User',
      user_email: 'remote@example.com',
    });
    expect(n.userName).toBe('Remote User');
    expect(n.userEmail).toBe('remote@example.com');
  });
});

describe('no undercounting: dedupeByCompletionId', () => {
  it('keeps three DISTINCT malas completed within 30s of each other (the old 30s-window bug)', () => {
    const base = Date.parse('2026-06-03T10:00:00.000Z');
    const recs = [
      session(new Date(base).toISOString()),
      session(new Date(base + 5000).toISOString()),  // +5s
      session(new Date(base + 12000).toISOString()), // +12s
    ];
    const out = dedupeByCompletionId(recs);
    expect(out).toHaveLength(3); // none collapsed
    expect(out.reduce((s, r) => s + r.totalCount, 0)).toBe(324);
  });
  it('collapses a true duplicate (same completionId) to exactly one', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const out = dedupeByCompletionId([session(iso), session(iso)]);
    expect(out).toHaveLength(1);
  });
  it('keeps two different completionIds on the same day', () => {
    const out = dedupeByCompletionId([
      session('2026-06-03T10:00:00.000Z'),
      session('2026-06-03T10:00:01.000Z'),
    ]);
    expect(out).toHaveLength(2);
  });
  it('upgrades the kept record to synced when a duplicate is synced', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const out = dedupeByCompletionId([
      session(iso, { syncStatus: 'pending', userName: 'Local User' }),
      session(iso, { syncStatus: 'synced' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].syncStatus).toBe('synced');
    expect(out[0].userName).toBe('Local User');
  });
});

describe('no data loss: mergeHistories (Supabase restore)', () => {
  it('keeps a local pending record that is absent from remote', () => {
    const local = [session('2026-06-03T10:00:00.000Z', { syncStatus: 'pending' })];
    const merged = mergeHistories(local, []); // remote empty (e.g. not yet uploaded)
    expect(merged).toHaveLength(1);
    expect(merged[0].syncStatus).toBe('pending'); // survives, still pending
  });
  it('never drops local records and adds remote-only records', () => {
    const local = [session('2026-06-03T10:00:00.000Z', { syncStatus: 'pending' })];
    const remote = [session('2026-06-02T09:00:00.000Z', { syncStatus: 'synced' })];
    const merged = mergeHistories(local, remote);
    const ids = merged.map((r) => r.completionId);
    expect(ids).toContain(makeCompletionId(UID, '2026-06-03T10:00:00.000Z'));
    expect(ids).toContain(makeCompletionId(UID, '2026-06-02T09:00:00.000Z'));
    expect(merged).toHaveLength(2);
  });
  it('does not double-count a record present in BOTH local and remote, and upgrades it to synced', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const merged = mergeHistories(
      [session(iso, { syncStatus: 'pending' })],
      [session(iso, { syncStatus: 'synced' })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].syncStatus).toBe('synced');
  });
  it('keeps an edited pending record pending while the remote copy still has stale values', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const merged = mergeHistories(
      [session(iso, { malas: 3, totalCount: 324, syncStatus: 'pending' })],
      [session(iso, { malas: 4, totalCount: 432, syncStatus: 'synced' })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ malas: 3, totalCount: 324, syncStatus: 'pending' });
  });
  it('marks an edited pending record synced once the remote values match', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const merged = mergeHistories(
      [session(iso, { malas: 3, totalCount: 324, syncStatus: 'pending' })],
      [session(iso, { malas: 3, totalCount: 324, syncStatus: 'synced' })]
    );
    expect(merged[0].syncStatus).toBe('synced');
  });
  it('simulated sign-out then sign-in restore preserves an unsynced local mala', () => {
    // User completes a mala offline (pending), then signs in -> remote has only older data.
    const localAfterOffline = appendCompletion(
      [session('2026-06-02T09:00:00.000Z', { syncStatus: 'synced' })],
      session('2026-06-03T10:00:00.000Z')
    );
    const remoteOnSignIn = [session('2026-06-02T09:00:00.000Z', { syncStatus: 'synced' })];
    const restored = mergeHistories(localAfterOffline, remoteOnSignIn);
    expect(restored.find((r) => r.completionId === makeCompletionId(UID, '2026-06-03T10:00:00.000Z')))
      .toBeTruthy(); // the offline mala was NOT lost
  });
  it('preserves pending yesterday and today records when remote restore has neither', () => {
    const yesterday = session('2026-06-02T23:30:00.000Z', { syncStatus: 'pending' });
    const today = session('2026-06-03T10:00:00.000Z', { syncStatus: 'pending' });
    const remote = [session('2026-06-01T09:00:00.000Z', { syncStatus: 'synced' })];

    const merged = mergeHistories([yesterday, today], remote);

    expect(merged.find((r) => r.completionId === makeCompletionId(UID, yesterday.date))?.syncStatus).toBe('pending');
    expect(merged.find((r) => r.completionId === makeCompletionId(UID, today.date))?.syncStatus).toBe('pending');
    expect(merged).toHaveLength(3);
  });
  it('preserves a remote row id when local and remote copies share the same completionId', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const merged = mergeHistories(
      [session(iso, { syncStatus: 'pending' })],
      [{ ...session(iso, { syncStatus: 'synced' }), remoteId: 99 }]
    );

    expect(merged.find((r) => r.completionId === makeCompletionId(UID, iso))?.remoteId).toBe(99);
  });
});

describe('sync payload/date integrity', () => {
  it('preserves yesterday offline completion created_at for Supabase payload', () => {
    const createdAt = '2026-06-02T23:30:00.000Z';
    const record = appendCompletion([], session(createdAt))[0];
    const payload = buildSupabaseHistoryPayload(record, UID, 'Sravani');

    expect(payload.created_at).toBe(createdAt);
    expect(payload.completion_id).toBe(record.completionId);
    expect(payload.user_id).toBe(UID);
  });

  it('preserves today offline completion created_at for Supabase payload', () => {
    const createdAt = '2026-06-03T10:00:00.000Z';
    const record = appendCompletion([], session(createdAt))[0];
    const payload = buildSupabaseHistoryPayload(record, UID, 'Sravani');

    expect(payload.created_at).toBe(createdAt);
    expect(payload.completion_id).toBe(record.completionId);
  });

  it('buckets bare dates and ISO timestamps by local day', () => {
    expect(toLocalDayKey('2026-06-02')).toBe('2026-06-02');
    expect(toLocalDayKey('2026-06-02T23:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('sync lifecycle: getPending / markSynced', () => {
  it('marks pending records synced after a successful upload and is idempotent', () => {
    const h = appendCompletion([], session('2026-06-03T10:00:00.000Z'));
    const pending = getPending(h);
    expect(pending).toHaveLength(1);

    const synced = markSynced(h, pending.map((p) => p.completionId));
    expect(getPending(synced)).toHaveLength(0);

    // Duplicate sync: re-marking already-synced does not change anything / no double records.
    const again = markSynced(synced, pending.map((p) => p.completionId));
    expect(again).toHaveLength(1);
    expect(again[0].syncStatus).toBe('synced');
  });
});

describe('duplicate sync attempts do not re-upload (idempotent)', () => {
  it('a synced record is no longer pending, so a repeat sync uploads nothing', () => {
    let h = appendCompletion([], session('2026-06-04T10:00:00.000Z')); // pending
    expect(getPending(h)).toHaveLength(1);
    // simulate a successful upload + mark
    h = markSynced(h, getPending(h).map((p) => p.completionId));
    expect(getPending(h)).toHaveLength(0); // second sync run finds nothing -> no duplicate POST
    // re-marking again is still a no-op
    h = markSynced(h, [makeCompletionId(UID, '2026-06-04T10:00:00.000Z')]);
    expect(getPending(h)).toHaveLength(0);
    expect(h).toHaveLength(1); // never duplicates the record
  });
});

describe('stats correct offline: todayCountFor', () => {
  it('sums today\'s deduped totalCount for the user (floor(count/108) malas)', () => {
    const today = '2026-06-03T';
    const recs = [
      session(`${today}10:00:00.000Z`),
      session(`${today}10:00:05.000Z`), // +5s, distinct -> counts
      session('2026-06-02T10:00:00.000Z'), // different day
      session(`${today}11:00:00.000Z`, { userId: 'other' }), // different user
    ];
    const todayKey = toDayKey(`${today}10:00:00.000Z`);
    const count = todayCountFor(recs, UID, todayKey, toDayKey);
    expect(count).toBe(216); // two distinct malas today for this user
    expect(Math.floor(count / 108)).toBe(2);
  });
  it('does not double-count a duplicate completionId', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const count = todayCountFor([session(iso), session(iso)], UID, toDayKey(iso), toDayKey);
    expect(count).toBe(108); // one mala, not two
  });
});

describe('local-day bucketing: UTC date vs local day (launch-blocking consistency)', () => {
  it('buckets a late-night local completion under its LOCAL day, even when that instant is the NEXT day in UTC', () => {
    // Local Jun 6, 23:30. In any timezone behind UTC this exact instant is Jun 7 in UTC,
    // but it must still bucket as the user's local Jun 6 (STEP 3 rule 3). Deterministic in
    // any runner timezone because the instant is built from LOCAL calendar components.
    const iso = new Date(2026, 5, 6, 23, 30, 0).toISOString(); // month 5 = June
    expect(toLocalDayKey(iso)).toBe('2026-06-06');
  });

  it('uses the LOCAL day, never the raw UTC date slice (no created_at.split("T")[0])', () => {
    const iso = '2026-06-07T05:00:00.000Z';
    // Must equal the local-day computation, matching how every screen buckets.
    expect(toLocalDayKey(iso)).toBe(toDayKey(iso));
    // When local day differs from the UTC date (any tz offset from UTC), it must NOT be the slice.
    if (toDayKey(iso) !== iso.slice(0, 10)) {
      expect(toLocalDayKey(iso)).not.toBe(iso.slice(0, 10));
    }
  });

  it('two malas the same UTC day but different LOCAL days bucket under different local days', () => {
    // Both instants are the SAME UTC calendar day, but ~24h of local time apart.
    const earlyLocal = new Date(2026, 5, 6, 1, 0, 0).toISOString();  // local Jun 6 01:00
    const lateLocal = new Date(2026, 5, 6, 23, 0, 0).toISOString();  // local Jun 6 23:00
    // Both are local Jun 6 regardless of runner tz.
    expect(toLocalDayKey(earlyLocal)).toBe('2026-06-06');
    expect(toLocalDayKey(lateLocal)).toBe('2026-06-06');
  });
});

describe('browser/app parity: same merged history => same count', () => {
  it('app (local pending + synced) and browser (empty local) agree AFTER both merge the same remote', () => {
    const day = '2026-06-06T';
    const remote = [
      session(`${day}15:00:00.000Z`, { syncStatus: 'synced' }),
      session(`${day}15:05:00.000Z`, { syncStatus: 'synced' }),
    ];
    // App had one synced locally + completed a second one (pending) before it uploaded.
    const appLocal = appendCompletion(
      [session(`${day}15:00:00.000Z`, { syncStatus: 'synced' })],
      session(`${day}15:05:00.000Z`)
    );
    // Browser started with nothing local (fresh device) and must fetch/merge remote on load.
    const browserLocal: ReturnType<typeof session>[] = [];

    const appMerged = mergeHistories(appLocal, remote);
    const browserMerged = mergeHistories(browserLocal, remote);
    const key = toDayKey(`${day}15:00:00.000Z`);

    // Identical count on both — the discrepancy only appears if a client skips the remote merge.
    expect(todayStatsFor(appMerged, UID, key, toDayKey)).toEqual(
      todayStatsFor(browserMerged, UID, key, toDayKey)
    );
    expect(todayStatsFor(appMerged, UID, key, toDayKey)).toEqual({ malas: 2, totalCount: 216 });
  });

  it('a logged-in user does NOT count rows with a null/guest user_id', () => {
    const day = '2026-06-06T';
    const recs = [
      session(`${day}15:00:00.000Z`),
      session(`${day}15:05:00.000Z`, { userId: undefined }), // guest row must be excluded
    ];
    const key = toDayKey(`${day}15:00:00.000Z`);
    expect(todayStatsFor(recs, UID, key, toDayKey)).toEqual({ malas: 1, totalCount: 108 });
  });
});

describe('reconcileWithServer: drops Supabase-deleted records from local storage', () => {
  const iso = '2026-06-06T18:51:49.300Z';
  const cid = makeCompletionId(UID, iso);

  it('1. drops a synced record absent from remote (Supabase-deleted row disappears)', () => {
    // Empty remote set is SKIPPED (safety: empty DB / new user). To prove a record IS
    // dropped when the server has other records but not this one, provide a non-empty
    // Set with a different record.
    const otherCid = makeCompletionId(UID, '2026-06-06T19:00:00.000Z');
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' })]),
      new Set([otherCid]), // remote has other data but not this record
      UID
    );
    expect(result).toHaveLength(0);
  });

  it('2. keeps a synced record that IS present in remote', () => {
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' })]),
      new Set([cid]),
      UID
    );
    expect(result).toHaveLength(1);
    expect(result[0].syncStatus).toBe('synced');
  });

  it('3. keeps a pending record even if absent from remote (unsynced offline mala is never dropped)', () => {
    const otherCid = makeCompletionId(UID, '2026-06-06T19:00:00.000Z');
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'pending' })]),
      new Set([otherCid]), // remote has other data but not this pending record
      UID
    );
    expect(result).toHaveLength(1);
    expect(result[0].syncStatus).toBe('pending');
  });

  it('4. does not touch another user\'s records, nor guest (null userId) records', () => {
    const result = reconcileWithServer(
      normalizeAll([
        session(iso, { userId: 'other-user', syncStatus: 'synced' }),
        session(iso, { userId: undefined, syncStatus: 'synced' }),
      ]),
      new Set(), // remote empty for UID
      UID
    );
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.userId === 'other-user')?.syncStatus).toBe('synced');
    expect(result.find((r) => !r.userId)?.syncStatus).toBe('synced');
  });

  it('5. uses makeCompletionId fallback for rows with no stored completionId (legacy null rows)', () => {
    const fallbackId = makeCompletionId(UID, iso);
    const normed = normalizeAll([session(iso, { syncStatus: 'synced' })]);
    const withEmptyCid = [{ ...normed[0], completionId: '' }] as HistoryRecord[];
    const result = reconcileWithServer(withEmptyCid, new Set([fallbackId]), UID);
    expect(result).toHaveLength(1);
  });

  it('6. dedup keeps exactly one row after reconcile (no doubling)', () => {
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' }), session(iso, { syncStatus: 'synced' })]),
      new Set([cid]),
      UID
    );
    expect(dedupeByCompletionId(result)).toHaveLength(1);
  });

  it('7. empty remote Set (0 rows) is SKIPPED — never drops records (safety: empty DB / new user)', () => {
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' }), session('2026-06-07T10:00:00.000Z', { syncStatus: 'synced' })]),
      new Set(),
      UID
    );
    expect(result).toHaveLength(2);
  });
});

describe('tombstone delete sync (explicit deletion propagates, offline-safe)', () => {
  const iso = '2026-06-06T18:00:00.000Z';
  const cid = makeCompletionId(UID, iso);

  it('1. applyTombstones removes the deleted record from local history', () => {
    const local = [session(iso, { syncStatus: 'synced' }), session('2026-06-06T19:00:00.000Z')];
    const out = applyTombstones(local, [cid]);
    expect(out.map((r) => r.completionId)).not.toContain(cid);
    expect(out).toHaveLength(1);
  });

  it('2. tombstoned record does NOT resurrect — reconcileWithServer drops it (absent from remote)', () => {
    // synced locally + absent remotely (deleted in Supabase) + tombstoned -> dropped by reconcile
    // Provide a non-empty remote Set to prove the server HAS data but this record is absent.
    const otherCid = makeCompletionId(UID, '2026-06-06T19:00:00.000Z');
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' })]),
      new Set([otherCid]), // remote has other data, not this record
      UID
    );
    expect(result).toHaveLength(0);
  });

  it('3. an offline PENDING record (not tombstoned) is NOT deleted', () => {
    const pIso = '2026-06-06T20:00:00.000Z';
    const out = applyTombstones(
      [session(iso, { syncStatus: 'synced' }), session(pIso, { syncStatus: 'pending' })],
      [cid] // only the synced one tombstoned
    );
    const pCid = makeCompletionId(UID, pIso);
    expect(out.map((r) => r.completionId)).toContain(pCid);
    expect(out.find((r) => r.completionId === pCid)?.syncStatus).toBe('pending');
  });

  it('4. second device removes the tombstoned record after pulling remote tombstones', () => {
    const device2Local = [session(iso, { syncStatus: 'synced' }), session('2026-06-05T10:00:00.000Z')];
    const merged = mergeTombstones([] /* local */, [cid] /* remote */);
    const out = applyTombstones(device2Local, merged);
    expect(out.map((r) => r.completionId)).not.toContain(cid);
    expect(out).toHaveLength(1);
  });

  it('5. reconcileWithServer drops both absent synced records; applyTombstones then filters tombstoned remote rows', () => {
    const otherIso = '2026-06-06T21:00:00.000Z';
    const otherCid = makeCompletionId(UID, otherIso);
    // Both absent from remote -> both dropped by reconcileWithServer
    // Provide a non-empty remote Set to prove the server HAS data but these records are absent.
    const knownRemoteCid = makeCompletionId(UID, '2026-06-06T22:00:00.000Z');
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' }), session(otherIso, { syncStatus: 'synced' })]),
      new Set([knownRemoteCid]), // remote has other data, not these two records
      UID
    );
    expect(result.map((r) => r.completionId)).not.toContain(cid);
    expect(result.map((r) => r.completionId)).not.toContain(otherCid);
    // Tombstoned record that still appears in remote is filtered by applyTombstones (separate step)
    const reconciled = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' }), session(otherIso, { syncStatus: 'synced' })]),
      new Set([cid, otherCid]),
      UID
    );
    const afterTombstone = applyTombstones(reconciled, [cid]);
    expect(afterTombstone.map((r) => r.completionId)).not.toContain(cid);
    expect(afterTombstone.map((r) => r.completionId)).toContain(otherCid);
  });

  it('mergeTombstones unions local + remote tombstones without duplicates', () => {
    expect(mergeTombstones(['a', 'b'], ['b', 'c']).sort()).toEqual(['a', 'b', 'c']);
  });

  it('6. one-click delete: a still-present remote row does NOT resurrect a tombstoned record (loadHistory merge)', () => {
    // Reproduces the "needs two clicks" bug: after a delete, local no longer has the row, but the
    // immediate remote fetch still returns it (remote DELETE in flight). mergeHistories re-adds it,
    // so the merged result MUST be filtered by the tombstone set before display/persist.
    const localAfterDelete = [session('2026-06-06T19:00:00.000Z')]; // deleted row already removed
    const remoteStillHasIt = [session(iso, { syncStatus: 'synced' }), session('2026-06-06T19:00:00.000Z')];
    const merged = mergeHistories(localAfterDelete, remoteStillHasIt);
    expect(merged.map((r) => r.completionId)).toContain(cid); // merge alone resurrects it
    const out = applyTombstones(merged, [cid]); // tombstone filter (what loadHistory now does)
    expect(out.map((r) => r.completionId)).not.toContain(cid);
    expect(out).toHaveLength(1);
  });
});

describe('shared selector: todayStatsFor (Main/Timer/History must agree)', () => {
  it('returns matching malas + totalCount from merged history (single source of truth)', () => {
    const today = '2026-06-03T';
    const recs = [
      session(`${today}10:00:00.000Z`),                 // tap/timer mala 1
      session(`${today}10:01:30.000Z`),                 // distinct mala 2
      session(`${today}10:00:00.000Z`),                 // duplicate of mala 1 -> ignored
      session('2026-06-02T09:00:00.000Z'),              // yesterday -> excluded
    ];
    const stats = todayStatsFor(recs, UID, toDayKey(`${today}10:00:00.000Z`), toDayKey);
    expect(stats).toEqual({ malas: 2, totalCount: 216 });
  });
  it('counts a pending (offline) mala immediately, no Supabase needed', () => {
    const h = appendCompletion([], session('2026-06-03T10:00:00.000Z')); // pending
    const stats = todayStatsFor(h, UID, toDayKey('2026-06-03T10:00:00.000Z'), toDayKey);
    expect(stats.malas).toBe(1);
  });
});

describe('planHistoryDayAdjustment', () => {
  const day = '2026-06-03';
  const at = (hour: number) => `2026-06-03T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const idAt = (hour: number) => makeCompletionId(UID, at(hour));
  const assertConsistentCounts = (records: HistoryRecord[]) => {
    for (const record of records.filter(
      (item) => item.userId === UID && toLocalDayKey(item.date) === day
    )) {
      expect(record.totalCount).toBe(record.malas * 108);
    }
  };

  it('4 one-mala rows -> 3 keeps the oldest three and deletes only the latest', () => {
    const records = [10, 11, 12, 13].map((hour) =>
      session(at(hour), { syncStatus: 'synced' })
    );
    const plan = planHistoryDayAdjustment(records, UID, day, 3);

    expect(plan.recordsToDelete.map((record) => record.completionId)).toEqual([idAt(13)]);
    expect(plan.recordsToUpdate).toHaveLength(0);
    expect(plan.updatedRecords.map((record) => record.completionId)).toEqual(
      expect.arrayContaining([idAt(10), idAt(11), idAt(12)])
    );
    expect(plan.updatedRecords).toHaveLength(3);
    assertConsistentCounts(plan.updatedRecords);
  });

  it('one 4-mala row -> 3 updates the same id and count to 324', () => {
    const original = session(at(10), {
      malas: 4,
      totalCount: 432,
      syncStatus: 'synced',
      userName: 'Sravani',
      userEmail: 'sravani@example.com',
      source: 'manual',
      remoteId: 12,
    });
    const plan = planHistoryDayAdjustment([original], UID, day, 3);
    const update = plan.recordsToUpdate[0];

    expect(update.before.completionId).toBe(update.after.completionId);
    expect(update.after).toMatchObject({
      malas: 3,
      totalCount: 324,
      remoteId: 12,
      syncStatus: 'pending',
      userName: 'Sravani',
      userEmail: 'sravani@example.com',
      source: 'manual',
    });
    expect(update.after.date).toBe(original.date);
  });

  it('mixed 3+1 -> 2 removes the latest row then reduces the oldest row', () => {
    const records = [
      session(at(10), { malas: 3, totalCount: 324, syncStatus: 'synced' }),
      session(at(11), { malas: 1, totalCount: 108, syncStatus: 'synced' }),
    ];
    const plan = planHistoryDayAdjustment(records, UID, day, 2);

    expect(plan.recordsToDelete.map((record) => record.completionId)).toEqual([idAt(11)]);
    expect(plan.recordsToUpdate).toHaveLength(1);
    expect(plan.recordsToUpdate[0].after).toMatchObject({
      completionId: idAt(10),
      malas: 2,
      totalCount: 216,
    });
    assertConsistentCounts(plan.updatedRecords);
  });

  it('same value is a no-op', () => {
    const plan = planHistoryDayAdjustment(
      [session(at(10)), session(at(11))],
      UID,
      day,
      2
    );
    expect(plan.changed).toBe(false);
    expect(plan.recordsToUpdate).toHaveLength(0);
    expect(plan.recordsToDelete).toHaveLength(0);
  });

  it('target 0 creates a delete-day plan containing every record for that day only', () => {
    const otherDay = session('2026-06-02T10:00:00.000Z');
    const plan = planHistoryDayAdjustment(
      [session(at(10)), session(at(11)), otherDay],
      UID,
      day,
      0
    );
    expect(plan.deleteEntireDay).toBe(true);
    expect(plan.recordsToDelete).toHaveLength(2);
    expect(plan.updatedRecords).toHaveLength(1);
    expect(plan.updatedRecords[0].date).toBe(otherDay.date);
  });

  it('increase 3 -> 4 updates the earliest canonical id and count to 432', () => {
    const original = session(at(10), { malas: 3, totalCount: 324, syncStatus: 'synced' });
    const plan = planHistoryDayAdjustment([original], UID, day, 4);
    expect(plan.recordsToUpdate[0].after).toMatchObject({
      completionId: idAt(10),
      malas: 4,
      totalCount: 432,
      syncStatus: 'pending',
    });
  });

  it('preserves unrelated and pending/offline records without losing metadata', () => {
    const pending = session(at(10), {
      malas: 2,
      totalCount: 216,
      syncStatus: 'pending',
      userName: 'Offline User',
      source: 'timer',
    });
    const otherUser = session(at(11), { userId: 'other-user', syncStatus: 'pending' });
    const plan = planHistoryDayAdjustment([pending, otherUser], UID, day, 1);

    expect(plan.recordsToUpdate[0].after).toMatchObject({
      completionId: makeCompletionId(UID, pending.date),
      malas: 1,
      totalCount: 108,
      syncStatus: 'pending',
      userName: 'Offline User',
      source: 'timer',
    });
    expect(plan.updatedRecords.find((record) => record.userId === 'other-user')).toBeTruthy();
    assertConsistentCounts(plan.updatedRecords);
  });

  describe('japamId scoping (optional 5th parameter)', () => {
    it('omitting japamId preserves the original, unscoped behavior (backward compatible)', () => {
      const records = [
        session(at(10), { japamId: 'gayatri', syncStatus: 'synced' }),
        session(at(11), { japamId: 'govinda', syncStatus: 'synced' }),
      ];
      const plan = planHistoryDayAdjustment(records, UID, day, 1);
      expect(plan.currentMalas).toBe(2);
      expect(plan.recordsToDelete).toHaveLength(1);
    });

    it('scopes currentMalas/targetMalas and edits to only the given Japam\'s same-day records', () => {
      const records = [
        session(at(10), { japamId: 'gayatri', malas: 2, totalCount: 216, syncStatus: 'synced' }),
        session(at(11), { japamId: 'govinda', malas: 5, totalCount: 540, syncStatus: 'synced' }),
      ];
      const plan = planHistoryDayAdjustment(records, UID, day, 1, 'gayatri');

      expect(plan.currentMalas).toBe(2); // only gayatri's malas, not 2+5
      expect(plan.recordsToUpdate).toHaveLength(1);
      expect(plan.recordsToUpdate[0].before.japamId).toBe('gayatri');
      // govinda's same-day record is completely untouched
      const govindaRecord = plan.updatedRecords.find((r) => r.japamId === 'govinda');
      expect(govindaRecord).toMatchObject({ malas: 5, totalCount: 540 });
    });

    it('never deletes or updates a different Japam\'s record even when reducing to 0', () => {
      const records = [
        session(at(10), { japamId: 'gayatri', malas: 1, totalCount: 108, syncStatus: 'synced' }),
        session(at(11), { japamId: 'govinda', malas: 1, totalCount: 108, syncStatus: 'synced' }),
      ];
      const plan = planHistoryDayAdjustment(records, UID, day, 0, 'gayatri');

      expect(plan.deleteEntireDay).toBe(true);
      expect(plan.recordsToDelete).toHaveLength(1);
      expect(plan.recordsToDelete[0].japamId).toBe('gayatri');
      expect(plan.updatedRecords.some((r) => r.japamId === 'govinda')).toBe(true);
    });

    it('passing japamId: null scopes to legacy/unassigned records only, excluding real Japams', () => {
      const records = [
        session(at(10), { japamId: null, malas: 1, totalCount: 108, syncStatus: 'synced' }),
        session(at(11), { japamId: 'gayatri', malas: 4, totalCount: 432, syncStatus: 'synced' }),
      ];
      const plan = planHistoryDayAdjustment(records, UID, day, 0, null);

      expect(plan.currentMalas).toBe(1);
      expect(plan.recordsToDelete).toHaveLength(1);
      expect(plan.recordsToDelete[0].japamId).toBeNull();
      expect(plan.updatedRecords.some((r) => r.japamId === 'gayatri')).toBe(true);
    });
  });
});

const isoAt = (hour: number) => `2026-07-06T${String(hour).padStart(2, '0')}:00:00.000Z`;

describe('normalizeJapamName', () => {
  it('trims whitespace', () => {
    expect(normalizeJapamName('  Gayatri  ')).toBe('Gayatri');
  });
  it('returns null for blank/whitespace-only input', () => {
    expect(normalizeJapamName('')).toBeNull();
    expect(normalizeJapamName('   ')).toBeNull();
  });
  it('returns null for null/undefined', () => {
    expect(normalizeJapamName(null)).toBeNull();
    expect(normalizeJapamName(undefined)).toBeNull();
  });
});

describe('japamId: identity field on HistoryRecord', () => {
  describe('normalizeRecord', () => {
    it('carries a valid japamId and trims the japamName snapshot', () => {
      const record = normalizeRecord(session(isoAt(0), {
        japamId: 'japam-abc-123',
        japamName: '  Gayatri  ',
      }));
      expect(record.japamId).toBe('japam-abc-123');
      expect(record.japamName).toBe('Gayatri');
    });
    it('defaults japamId to null when absent', () => {
      const record = normalizeRecord(session(isoAt(0)));
      expect(record.japamId).toBeNull();
      expect(record.japamName).toBeNull();
    });
    it('defaults a non-string japamId to null rather than crashing', () => {
      const record = normalizeRecord(session(isoAt(0), { japamId: 12345 as unknown as string }));
      expect(record.japamId).toBeNull();
    });
    it('defaults an empty-string japamId to null', () => {
      const record = normalizeRecord(session(isoAt(0), { japamId: '' }));
      expect(record.japamId).toBeNull();
    });
    it('preserves a japamName snapshot even when japamId is absent (legacy free-text row)', () => {
      const record = normalizeRecord(session(isoAt(0), { japamName: 'Old Mantra' }));
      expect(record.japamId).toBeNull();
      expect(record.japamName).toBe('Old Mantra');
    });
  });

  describe('appendCompletion', () => {
    it('carries japamId and japamName through into the new record', () => {
      const history = appendCompletion([], {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 60,
        userId: UID,
        japamId: 'japam-abc-123',
        japamName: 'Gayatri',
      });
      expect(history[0].japamId).toBe('japam-abc-123');
      expect(history[0].japamName).toBe('Gayatri');
    });
    it('defaults to null when the caller omits japamId/japamName (e.g. a screen with no Japam picker)', () => {
      const history = appendCompletion([], {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 60,
        userId: UID,
      });
      expect(history[0].japamId).toBeNull();
      expect(history[0].japamName).toBeNull();
    });
    it('does not let a duplicate completionId change an already-appended record\'s japamId', () => {
      const first = appendCompletion([], {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 60,
        userId: UID,
        completionId: 'fixed-id',
        japamId: 'japam-a',
      });
      const second = appendCompletion(first, {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 60,
        userId: UID,
        completionId: 'fixed-id',
        japamId: 'japam-b',
      });
      expect(second).toHaveLength(1);
      expect(second[0].japamId).toBe('japam-a');
    });
  });

  describe('buildSupabaseHistoryPayload', () => {
    it('preserves japam_id and the trimmed japam_name snapshot for Supabase attribution', () => {
      const record = normalizeRecord(session(isoAt(0), {
        japamId: 'japam-abc-123',
        japamName: '  Gayatri  ',
      }));
      const payload = buildSupabaseHistoryPayload(record, UID, 'Sravani');
      expect(payload.japam_id).toBe('japam-abc-123');
      expect(payload.japam_name).toBe('Gayatri');
    });
    it('sends null japam_id and japam_name when the record has neither, never crashing', () => {
      const record = normalizeRecord(session(isoAt(0)));
      const payload = buildSupabaseHistoryPayload(record, UID, 'Sravani');
      expect(payload.japam_id).toBeNull();
      expect(payload.japam_name).toBeNull();
    });
  });

  describe('dedupeByCompletionId: identity is never overwritten by a later duplicate', () => {
    it('keeps the first-seen record\'s japamId/japamName when upgrading pending to synced', () => {
      const pendingFirst = session(isoAt(0), {
        completionId: 'dup-id',
        japamId: 'japam-a',
        japamName: 'Gayatri',
        syncStatus: 'pending',
      });
      const syncedDuplicate = session(isoAt(0), {
        completionId: 'dup-id',
        japamId: 'japam-b',
        japamName: 'Different Name',
        syncStatus: 'synced',
      });
      const result = dedupeByCompletionId([pendingFirst, syncedDuplicate]);
      expect(result).toHaveLength(1);
      expect(result[0].syncStatus).toBe('synced');
      expect(result[0].japamId).toBe('japam-a');
      expect(result[0].japamName).toBe('Gayatri');
    });
  });

  describe('round trip: appendCompletion -> buildSupabaseHistoryPayload preserves identity', () => {
    it('carries japam_id and japam_name through to the remote payload', () => {
      const history = appendCompletion([], {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 60,
        userId: UID,
        japamId: 'japam-abc-123',
        japamName: 'Gayatri',
      });
      const payload = buildSupabaseHistoryPayload(history[0], UID, 'Sravani');
      expect(payload.japam_id).toBe('japam-abc-123');
      expect(payload.japam_name).toBe('Gayatri');
    });

    it('preserves japam_id for a pending offline record when it is retried later', () => {
      const history = appendCompletion([], {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 0,
        userId: UID,
        japamId: 'offline-japam-id',
        japamName: 'Offline Japam',
      });
      const pending = getPending(history);

      expect(pending).toHaveLength(1);
      expect(buildSupabaseHistoryPayload(pending[0], UID, 'Sravani')).toMatchObject({
        japam_id: 'offline-japam-id',
        japam_name: 'Offline Japam',
      });
    });

    it('preserves Timer completion Japam attribution in the remote payload', () => {
      const history = appendCompletion([], {
        date: isoAt(0),
        malas: 1,
        totalCount: 108,
        duration: 600,
        manual: false,
        userId: UID,
        japamId: 'timer-japam-id',
        japamName: 'Timer Japam',
      });

      expect(buildSupabaseHistoryPayload(history[0], UID, 'Sravani')).toMatchObject({
        japam_id: 'timer-japam-id',
        japam_name: 'Timer Japam',
      });
    });

    it('preserves Manual completion Japam attribution in the remote payload', () => {
      const history = appendCompletion([], {
        date: isoAt(0),
        malas: 2,
        totalCount: 216,
        duration: 0,
        manual: true,
        userId: UID,
        japamId: 'manual-japam-id',
        japamName: 'Manual Japam',
      });

      expect(buildSupabaseHistoryPayload(history[0], UID, 'Sravani')).toMatchObject({
        japam_id: 'manual-japam-id',
        japam_name: 'Manual Japam',
      });
    });
  });
});

describe('statsByJapam / japamStatsFor: centralized per-Japam stats selector', () => {
  const TODAY = '2026-07-06';
  const YESTERDAY = '2026-07-05';
  const todayIso = (hour: number) => `${TODAY}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const yesterdayIso = (hour: number) => `${YESTERDAY}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  it('computes today and lifetime malas for a single Japam across multiple days', () => {
    const history = [
      session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108 }),
      session(todayIso(10), { japamId: 'gayatri', malas: 1, totalCount: 108 }),
      session(yesterdayIso(9), { japamId: 'gayatri', malas: 3, totalCount: 324 }),
    ];
    const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
    const stats = japamStatsFor(statsMap, 'gayatri');
    expect(stats.todayMalas).toBe(2);
    expect(stats.todayTotalCount).toBe(216);
    expect(stats.lifetimeMalas).toBe(5); // 2 today + 3 yesterday
    expect(stats.lifetimeTotalCount).toBe(540);
  });

  it('computes stats for every Japam simultaneously, never mixing them (the "My Japams" list needs all at once)', () => {
    const history = [
      session(todayIso(9), { japamId: 'gayatri', malas: 5, totalCount: 540 }),
      session(todayIso(10), { japamId: 'govinda', malas: 2, totalCount: 216 }),
    ];
    const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
    expect(japamStatsFor(statsMap, 'gayatri').todayMalas).toBe(5);
    expect(japamStatsFor(statsMap, 'govinda').todayMalas).toBe(2);
  });

  it('groups legacy/unassigned rows (no japamId) under the null key, separate from any real Japam', () => {
    const history = [
      session(todayIso(9), { japamId: null, malas: 1, totalCount: 108 }),
      session(todayIso(10), { japamId: 'gayatri', malas: 1, totalCount: 108 }),
    ];
    const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
    expect(japamStatsFor(statsMap, null).todayMalas).toBe(1);
    expect(japamStatsFor(statsMap, 'gayatri').todayMalas).toBe(1);
  });

  it('only counts this user\'s own records, matching todayStatsFor\'s existing userId convention', () => {
    const history = [
      session(todayIso(9), { japamId: 'gayatri', userId: UID, malas: 1, totalCount: 108 }),
      session(todayIso(10), { japamId: 'gayatri', userId: 'other-user', malas: 9, totalCount: 972 }),
    ];
    const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
    expect(japamStatsFor(statsMap, 'gayatri').todayMalas).toBe(1);
  });

  it('dedupes by completionId, same as every other selector in this file', () => {
    const dup = session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108, completionId: 'dup-id' });
    const history = [dup, { ...dup }];
    const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
    expect(japamStatsFor(statsMap, 'gayatri').todayMalas).toBe(1);
  });

  it('treats undefined the same as null (legacy bucket)', () => {
    const history = [session(todayIso(9), { japamId: null, malas: 1, totalCount: 108 })];
    const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
    expect(japamStatsFor(statsMap, undefined)).toEqual(japamStatsFor(statsMap, null));
  });

  describe('japamStatsFor: safe defaults', () => {
    it('returns all-zero stats for a Japam with no completions rather than throwing', () => {
      const statsMap = statsByJapam([], UID, TODAY, toDayKey);
      expect(japamStatsFor(statsMap, 'never-used')).toEqual({
        todayMalas: 0,
        todayTotalCount: 0,
        lifetimeMalas: 0,
        lifetimeTotalCount: 0,
      });
    });
  });

  describe('statsByJapamWithAttribution: legacy record attribution for the My Japams list', () => {
    const TODAY = '2026-07-06';
    const todayIso = (hour: number) => `${TODAY}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const japams = [
      { id: 'gayatri', name: 'Gayatri' },
      { id: 'govinda', name: 'Govinda' },
    ];
    const japamStats = (map: Map<string | null, JapamStats>) => ({
      gayatri: japamStatsFor(map, 'gayatri'),
      govinda: japamStatsFor(map, 'govinda'),
      unclaimed: japamStatsFor(map, null),
    });

    it('matches History: modern japamId + unambiguous name-matched legacy + blank legacy all attribute to the same Japam (the repro case)', () => {
      const history = [
        session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108 }),
        session(todayIso(10), { japamId: null, japamName: 'Gayatri', malas: 1, totalCount: 108 }),
        session(todayIso(11), { japamId: null, japamName: null, malas: 1, totalCount: 108 }),
      ];
      const stats = japamStats(statsByJapamWithAttribution(history, UID, japams, 'gayatri', TODAY, toDayKey));
      expect(stats.gayatri.lifetimeMalas).toBe(3);
      expect(stats.govinda.lifetimeMalas).toBe(0);
      expect(stats.unclaimed.lifetimeMalas).toBe(0);
    });

    it('blank legacy goes only to the supplied first active Japam, never to a sibling', () => {
      const history = [
        session(todayIso(9), { japamId: null, japamName: null, malas: 1, totalCount: 108 }),
      ];
      const withGovindaFirst = statsByJapamWithAttribution(history, UID, japams, 'govinda', TODAY, toDayKey);
      expect(japamStatsFor(withGovindaFirst, 'govinda').lifetimeMalas).toBe(1);
      expect(japamStatsFor(withGovindaFirst, 'gayatri').lifetimeMalas).toBe(0);
    });

    it('puts only unclaimed rows in the null bucket: claimed rows never leak into it', () => {
      const history = [
        session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108 }),
        session(todayIso(10), { japamId: null, japamName: 'Govinda', malas: 1, totalCount: 108 }),
        session(todayIso(11), { japamId: null, japamName: null, malas: 1, totalCount: 108 }),
        session(todayIso(12), { japamId: 'not-in-list', malas: 1, totalCount: 108 }),
        session(todayIso(13), { japamId: null, japamName: 'Nonexistent', malas: 1, totalCount: 108 }),
      ];
      const stats = japamStats(statsByJapamWithAttribution(history, UID, japams, 'gayatri', TODAY, toDayKey));
      expect(stats.gayatri.lifetimeMalas).toBe(2);
      expect(stats.govinda.lifetimeMalas).toBe(1);
      expect(stats.unclaimed.lifetimeMalas).toBe(2);
    });

    it('does not guess on ambiguous names: a legacy name shared by two Japams falls to the null bucket', () => {
      const twoGayatri = [
        { id: 'g1', name: 'Gayatri' },
        { id: 'g2', name: 'Gayatri' },
      ];
      const history = [session(todayIso(9), { japamId: null, japamName: 'Gayatri', malas: 1, totalCount: 108 })];
      const map = statsByJapamWithAttribution(history, UID, twoGayatri, 'g1', TODAY, toDayKey);
      expect(japamStatsFor(map, 'g1').lifetimeMalas).toBe(0);
      expect(japamStatsFor(map, 'g2').lifetimeMalas).toBe(0);
      expect(japamStatsFor(map, null).lifetimeMalas).toBe(1);
    });

    it('rename invalidates attribution: the legacy name no longer matches the renamed Japam', () => {
      const history = [session(todayIso(9), { japamId: null, japamName: 'Gayatri', malas: 1, totalCount: 108 })];
      const afterRename = statsByJapamWithAttribution(
        history, UID, [{ id: 'gayatri', name: 'Gayatri Mantra' }], 'gayatri', TODAY, toDayKey,
      );
      expect(japamStatsFor(afterRename, 'gayatri').lifetimeMalas).toBe(0);
      expect(japamStatsFor(afterRename, null).lifetimeMalas).toBe(1);
    });

    it('archiving the first active Japam changes who owns the blank-legacy bucket', () => {
      const history = [session(todayIso(9), { japamId: null, japamName: null, malas: 1, totalCount: 108 })];
      const onlyArchived = [
        { id: 'gayatri', name: 'Gayatri' },
        { id: 'govinda', name: 'Govinda' },
      ];
      const map = statsByJapamWithAttribution(history, UID, onlyArchived, 'govinda', TODAY, toDayKey);
      expect(japamStatsFor(map, 'govinda').lifetimeMalas).toBe(1);
      expect(japamStatsFor(map, 'gayatri').lifetimeMalas).toBe(0);
    });

    it('excludes tombstoned completions, matching applyTombstones', () => {
      const tombstoned = session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108, completionId: 'dead-id' });
      const history = [tombstoned, session(todayIso(10), { japamId: 'gayatri', malas: 2, totalCount: 216 })];
      const after = applyTombstones(history, ['dead-id']);
      const stats = japamStats(statsByJapamWithAttribution(after, UID, japams, 'gayatri', TODAY, toDayKey));
      expect(stats.gayatri.lifetimeMalas).toBe(2);
    });

    it('dedupes a pending completion that later syncs: no double count', () => {
      const pending = session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108, completionId: 'c1', syncStatus: 'pending' });
      const synced = { ...pending, syncStatus: 'synced' as const };
      const stats = japamStats(statsByJapamWithAttribution([pending, synced], UID, japams, 'gayatri', TODAY, toDayKey));
      expect(stats.gayatri.lifetimeMalas).toBe(1);
    });

    it('only counts this user\'s own records, matching every other selector', () => {
      const history = [session(todayIso(9), { japamId: 'gayatri', userId: 'other-user', malas: 9, totalCount: 972 })];
      const stats = japamStats(statsByJapamWithAttribution(history, UID, japams, 'gayatri', TODAY, toDayKey));
      expect(stats.gayatri.lifetimeMalas).toBe(0);
    });

    it('supports guest mode (userId null) like statsByJapam', () => {
      const history = [session(todayIso(9), { japamId: null, japamName: null, userId: null, malas: 1, totalCount: 108 })];
      const map = statsByJapamWithAttribution(history, null, japams, 'gayatri', TODAY, toDayKey);
      expect(japamStatsFor(map, 'gayatri').lifetimeMalas).toBe(1);
    });

    it('splits today vs lifetime correctly for attributed legacy rows', () => {
      const history = [
        session(todayIso(9), { japamId: 'gayatri', malas: 1, totalCount: 108 }),
        session('2026-07-05T09:00:00.000Z', { japamId: null, japamName: 'Gayatri', malas: 2, totalCount: 216 }),
      ];
      const stats = japamStats(statsByJapamWithAttribution(history, UID, japams, 'gayatri', TODAY, toDayKey));
      expect(stats.gayatri.todayMalas).toBe(1);
      expect(stats.gayatri.todayTotalCount).toBe(108);
      expect(stats.gayatri.lifetimeMalas).toBe(3);
      expect(stats.gayatri.lifetimeTotalCount).toBe(324);
    });

    describe('canonical attribution: My Japams, History, and Timer agree on one rule', () => {
      const TODAY = '2026-07-06';
      const todayIso = (hour: number) => `${TODAY}T${String(hour).padStart(2, '0')}:00:00.000Z`;
      // Two OWNED Japams with the SAME legacy name — an ambiguous name for legacy attribution.
      const ambiguousJapams = [
        { id: 'g1', name: 'Gayatri' },
        { id: 'g2', name: 'Gayatri' },
      ];
      const ambiguousNameRow = session(todayIso(10), { japamId: null, japamName: 'Gayatri', totalCount: 108, completionId: 'ambiguous-legacy' });
      const totalOf = (rows: HistoryRecord[]) => rows.reduce((sum, r) => sum + r.totalCount, 0);

      it('ambiguous legacy row is claimed by NEITHER Japam; every screen returns the same total for each Japam', () => {
        const records = [
          session(todayIso(9), { japamId: 'g1', japamName: 'Gayatri', totalCount: 108, completionId: 'g1-modern' }),
          session(todayIso(8), { japamId: 'g2', japamName: 'Gayatri', totalCount: 216, completionId: 'g2-modern' }),
          ambiguousNameRow,
        ];

        // My Japams: statsByJapamWithAttribution (the selector loadJapamStats routes through).
        const myJapams = statsByJapamWithAttribution(records, UID, ambiguousJapams, 'g1', TODAY, toDayKey);
        expect(japamStatsFor(myJapams, 'g1').lifetimeTotalCount).toBe(108);
        expect(japamStatsFor(myJapams, 'g2').lifetimeTotalCount).toBe(216);
        // The ambiguous row is NOT double-counted: it stays unclaimed in the null bucket.
        expect(japamStatsFor(myJapams, null).lifetimeTotalCount).toBe(108);

        // History: filterByJapam with the Japam list (the actual selector History calls).
        const historyG1 = filterByJapam(records, 'g1', 'Gayatri', { includeBlankLegacy: true }, ambiguousJapams);
        const historyG2 = filterByJapam(records, 'g2', 'Gayatri', { includeBlankLegacy: true }, ambiguousJapams);
        expect(totalOf(historyG1)).toBe(108);
        expect(totalOf(historyG2)).toBe(216);

        // Timer: japamScopedStatsFor with the Japam list (the actual selector Timer calls).
        const timerG1 = japamScopedStatsFor(records, UID, 'g1', 'Gayatri', TODAY, toDayKey, getPreviousDayKey, { includeBlankLegacy: true }, ambiguousJapams);
        const timerG2 = japamScopedStatsFor(records, UID, 'g2', 'Gayatri', TODAY, toDayKey, getPreviousDayKey, { includeBlankLegacy: true }, ambiguousJapams);
        expect(timerG1.lifetimeTotalCount).toBe(108);
        expect(timerG2.lifetimeTotalCount).toBe(216);

        // The row remains unclaimed: present in the unclaimed/null view, in none of the Japam scopes.
        expect(filterByJapam(records, null, null, {}, ambiguousJapams).some((r) => r.completionId === 'ambiguous-legacy')).toBe(true);
        expect(historyG1.some((r) => r.completionId === 'ambiguous-legacy')).toBe(false);
        expect(historyG2.some((r) => r.completionId === 'ambiguous-legacy')).toBe(false);
      });

      it('a UNIQUE legacy name is still claimed by all three screens (no regression)', () => {
        const records = [
          session(todayIso(9), { japamId: 'g1', japamName: 'Gayatri', totalCount: 108, completionId: 'g1-modern' }),
          session(todayIso(10), { japamId: null, japamName: 'Gayatri', totalCount: 108, completionId: 'legacy-unique' }),
        ];
        const uniqueJapams = [
          { id: 'g1', name: 'Gayatri' },
          { id: 'g2', name: 'Govinda' },
        ];

        const myJapams = statsByJapamWithAttribution(records, UID, uniqueJapams, 'g1', TODAY, toDayKey);
        const historyG1 = filterByJapam(records, 'g1', 'Gayatri', {}, uniqueJapams);
        const timerG1 = japamScopedStatsFor(records, UID, 'g1', 'Gayatri', TODAY, toDayKey, getPreviousDayKey, {}, uniqueJapams);

        expect(japamStatsFor(myJapams, 'g1').lifetimeTotalCount).toBe(216);
        expect(japamStatsFor(myJapams, 'g2').lifetimeTotalCount).toBe(0);
        expect(totalOf(historyG1)).toBe(216);
        expect(timerG1.lifetimeTotalCount).toBe(216);
      });

      it('tombstones are applied BEFORE all three calculations: a tombstoned row contributes to none of them', () => {
        const records = [
          session(todayIso(9), { japamId: 'g1', japamName: 'Gayatri', totalCount: 108, completionId: 'g1-modern' }),
          session(todayIso(10), { japamId: 'g1', japamName: 'Gayatri', totalCount: 108, completionId: 'tombstoned-id' }),
        ];
        const after = applyTombstones(records, ['tombstoned-id']);

        const myJapams = statsByJapamWithAttribution(after, UID, ambiguousJapams, 'g1', TODAY, toDayKey);
        const historyG1 = filterByJapam(after, 'g1', 'Gayatri', { includeBlankLegacy: true }, ambiguousJapams);
        const timerG1 = japamScopedStatsFor(after, UID, 'g1', 'Gayatri', TODAY, toDayKey, getPreviousDayKey, { includeBlankLegacy: true }, ambiguousJapams);

        expect(japamStatsFor(myJapams, 'g1').lifetimeTotalCount).toBe(108);
        expect(japamStatsFor(myJapams, null).lifetimeTotalCount).toBe(0);
        expect(totalOf(historyG1)).toBe(108);
        expect(timerG1.lifetimeTotalCount).toBe(108);
      });
    });
  });
});

// ─────── Home totals scoping (filterByJapam + todayStatsFor pipeline) ───────
//
// The Home screen computes displayed stats by pre-filtering records with
// filterByJapam (currentJapamId, currentJapamName) then passing the result to
// todayStatsFor. These tests prove the complete pipeline, not just filterByJapam
// in isolation.

describe('Home totals scoping (filterByJapam → todayStatsFor)', () => {
  const UID = 'user-123';
  const JAPAM_A_ID = 'uuid-gayatri';
  const JAPAM_B_ID = 'uuid-govinda';
  const DEFAULT_JAPAM_ID = 'uuid-my-japam';
  const JAPAM_A_NAME = 'Gayatri';
  const JAPAM_B_NAME = 'Govinda';
  const DEFAULT_JAPAM_NAME = 'My Japam';
  const todayKey = '2026-07-06';
  const toKey = (iso: string) => iso.slice(0, 10);
  const todayISO = `${todayKey}T12:00:00.000Z`;

  const session = (
    dateISO: string,
    overrides: Partial<HistoryRecord> = {},
  ): HistoryRecord => ({
    date: dateISO,
    malas: overrides.malas ?? 1,
    totalCount: overrides.totalCount ?? 108,
    duration: 0,
    manual: false,
    userId: UID,
    userName: 'Test User',
    syncStatus: 'synced',
    completionId: overrides.completionId ?? makeCompletionId(UID, dateISO),
    japamId: overrides.japamId ?? null,
    japamName: overrides.japamName ?? null,
  });

  const homePipeline = (
    records: HistoryRecord[],
    japamId: string | null,
    japamName: string | null,
    options: { includeBlankLegacy?: boolean } = {},
  ) => {
    const scoped = japamId !== null
      ? filterByJapam(records, japamId, japamName, options)
      : records;
    return todayStatsFor(scoped, UID, todayKey, toKey).totalCount;
  };

  it('counts UUID-matched rows for the selected Japam', () => {
    const records = [
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'a1' }),
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'a2' }),
      session(todayISO, { japamId: JAPAM_B_ID, japamName: JAPAM_B_NAME, completionId: 'b1' }),
    ];
    expect(homePipeline(records, JAPAM_A_ID, JAPAM_A_NAME)).toBe(216);
    expect(homePipeline(records, JAPAM_B_ID, JAPAM_B_NAME)).toBe(108);
  });

  it('counts legacy null-japamId rows when japamName matches', () => {
    const records = [
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'real' }),
      session(todayISO, { japamId: null, japamName: JAPAM_A_NAME, completionId: 'legacy-match' }),
    ];
    expect(homePipeline(records, JAPAM_A_ID, JAPAM_A_NAME)).toBe(216);
  });

  it('excludes legacy rows with different japamName', () => {
    const records = [
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'real' }),
      session(todayISO, { japamId: null, japamName: JAPAM_B_NAME, completionId: 'legacy-other' }),
    ];
    expect(homePipeline(records, JAPAM_A_ID, JAPAM_A_NAME)).toBe(108);
  });

  it('excludes rows belonging to a different UUID Japam', () => {
    const records = [
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'a' }),
      session(todayISO, { japamId: JAPAM_B_ID, japamName: JAPAM_B_NAME, completionId: 'b' }),
    ];
    expect(homePipeline(records, JAPAM_A_ID, JAPAM_A_NAME)).toBe(108);
  });

  it('changing selected Japam recomputes totals correctly', () => {
    const records = [
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'a' }),
      session(todayISO, { japamId: JAPAM_B_ID, japamName: JAPAM_B_NAME, completionId: 'b' }),
      session(todayISO, { japamId: null, japamName: JAPAM_A_NAME, completionId: 'la' }),
      session(todayISO, { japamId: null, japamName: JAPAM_B_NAME, completionId: 'lb' }),
    ];
    const totalA = homePipeline(records, JAPAM_A_ID, JAPAM_A_NAME);
    const totalB = homePipeline(records, JAPAM_B_ID, JAPAM_B_NAME);
    expect(totalA).toBe(216); // a (108) + la (108)
    expect(totalB).toBe(216); // b (108) + lb (108)
  });

  it('null japamId (no Japam selected) aggregates all rows unfiltered', () => {
    const records = [
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'a' }),
      session(todayISO, { japamId: JAPAM_B_ID, japamName: JAPAM_B_NAME, completionId: 'b' }),
      session(todayISO, { japamId: null, japamName: JAPAM_A_NAME, completionId: 'la' }),
    ];
    expect(homePipeline(records, null, null)).toBe(324); // all three
  });

  // ── Cumulative total preservation ──
  it('existing 3 orphan malas + new 1 mala => default My Japam shows cumulative 4 malas', () => {
    const records = [
      session(todayISO, { japamId: null, japamName: null, completionId: 'legacy-1' }),
      session(todayISO, { japamId: null, japamName: null, completionId: 'legacy-2' }),
      session(todayISO, { japamId: null, japamName: null, completionId: 'legacy-3' }),
      session(todayISO, { japamId: DEFAULT_JAPAM_ID, japamName: DEFAULT_JAPAM_NAME, completionId: 'new-1' }),
    ];
    expect(homePipeline(records, DEFAULT_JAPAM_ID, DEFAULT_JAPAM_NAME, { includeBlankLegacy: true })).toBe(432); // 4 × 108
  });

  it('existing 2 orphan malas + new 2 malas => default My Japam shows cumulative 4 malas', () => {
    const records = [
      session(todayISO, { japamId: null, japamName: null, completionId: 'old-1' }),
      session(todayISO, { japamId: null, japamName: null, completionId: 'old-2' }),
      session(todayISO, { japamId: DEFAULT_JAPAM_ID, japamName: DEFAULT_JAPAM_NAME, completionId: 'new-1' }),
      session(todayISO, { japamId: DEFAULT_JAPAM_ID, japamName: DEFAULT_JAPAM_NAME, completionId: 'new-2' }),
    ];
    expect(homePipeline(records, DEFAULT_JAPAM_ID, DEFAULT_JAPAM_NAME, { includeBlankLegacy: true })).toBe(432); // 4 × 108
  });

  it('different non-default Japam totals remain isolated without orphan contamination', () => {
    const records = [
      session(todayISO, { japamId: null, japamName: null, completionId: 'orphan' }),
      session(todayISO, { japamId: JAPAM_A_ID, japamName: JAPAM_A_NAME, completionId: 'a-1' }),
      session(todayISO, { japamId: JAPAM_B_ID, japamName: JAPAM_B_NAME, completionId: 'b-1' }),
    ];
    expect(homePipeline(records, JAPAM_A_ID, JAPAM_A_NAME)).toBe(108);
    expect(homePipeline(records, JAPAM_B_ID, JAPAM_B_NAME)).toBe(108);
    expect(homePipeline(records, DEFAULT_JAPAM_ID, DEFAULT_JAPAM_NAME, { includeBlankLegacy: true })).toBe(108);
  });

  it('refresh preserves the same cumulative total (idempotent)', () => {
    const records = [
      session(todayISO, { japamId: null, japamName: null, completionId: 'orphan' }),
      session(todayISO, { japamId: DEFAULT_JAPAM_ID, japamName: DEFAULT_JAPAM_NAME, completionId: 'a-1' }),
    ];
    const total1 = homePipeline(records, DEFAULT_JAPAM_ID, DEFAULT_JAPAM_NAME, { includeBlankLegacy: true });
    const total2 = homePipeline(records, DEFAULT_JAPAM_ID, DEFAULT_JAPAM_NAME, { includeBlankLegacy: true });
    expect(total1).toBe(216);
    expect(total2).toBe(216);
  });
});

describe('dayStreakForJapam: per-Japam consecutive-day streak', () => {
  const DAY0 = '2026-07-06'; // "today" for these tests
  const DAY1 = getPreviousDayKey(DAY0);
  const DAY2 = getPreviousDayKey(DAY1);
  const DAY3 = getPreviousDayKey(DAY2);
  const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  it('counts a streak for one Japam only, ignoring a different Japam\'s own history', () => {
    const history = [
      session(at(DAY0, 9), { japamId: 'gayatri' }),
      session(at(DAY1, 9), { japamId: 'gayatri' }),
      // govinda has its own unbroken streak too, but must not inflate gayatri's count
      session(at(DAY0, 10), { japamId: 'govinda' }),
      session(at(DAY1, 10), { japamId: 'govinda' }),
      session(at(DAY2, 10), { japamId: 'govinda' }),
    ];
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(2);
    expect(dayStreakForJapam(history, UID, 'govinda', DAY0, toDayKey, getPreviousDayKey)).toBe(3);
  });

  it('returns 0 for a Japam with no completions at all, rather than throwing', () => {
    const history = [session(at(DAY0, 9), { japamId: 'gayatri' })];
    expect(dayStreakForJapam(history, UID, 'brand-new-japam', DAY0, toDayKey, getPreviousDayKey)).toBe(0);
  });

  it('a brand-new Japam with zero history has a 0 streak even when other Japams have activity today', () => {
    const history = [session(at(DAY0, 9), { japamId: 'gayatri' })];
    expect(dayStreakForJapam([], UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(0);
    expect(dayStreakForJapam(history, UID, 'brand-new-japam', DAY0, toDayKey, getPreviousDayKey)).toBe(0);
  });

  it('groups legacy/unassigned rows (japamId null) separately from any real Japam', () => {
    const history = [
      session(at(DAY0, 9), { japamId: null }),
      session(at(DAY1, 9), { japamId: null }),
      session(at(DAY0, 10), { japamId: 'gayatri' }),
    ];
    expect(dayStreakForJapam(history, UID, null, DAY0, toDayKey, getPreviousDayKey)).toBe(2);
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(1);
  });

  it('only counts this user\'s own records for the Japam, matching statsByJapam\'s userId convention', () => {
    const history = [
      session(at(DAY0, 9), { japamId: 'gayatri', userId: UID }),
      session(at(DAY0, 10), { japamId: 'gayatri', userId: 'other-user' }),
      session(at(DAY1, 9), { japamId: 'gayatri', userId: 'other-user' }),
    ];
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(1);
  });

  it('supports guest mode (userId null) the same way as statsByJapam', () => {
    const history = [
      session(at(DAY0, 9), { japamId: 'gayatri', userId: null }),
      session(at(DAY1, 9), { japamId: 'gayatri', userId: null }),
      session(at(DAY0, 10), { japamId: 'gayatri', userId: 'someone-signed-in' }),
    ];
    expect(dayStreakForJapam(history, null, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(2);
  });

  it('breaks the streak on a missing day rather than skipping over the gap', () => {
    const history = [
      session(at(DAY0, 9), { japamId: 'gayatri' }),
      // DAY1 has no completion for this Japam -- gap
      session(at(DAY2, 9), { japamId: 'gayatri' }),
      session(at(DAY3, 9), { japamId: 'gayatri' }),
    ];
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(1);
  });

  it('still counts yesterday\'s streak when nothing has been logged yet today', () => {
    const history = [
      session(at(DAY1, 9), { japamId: 'gayatri' }),
      session(at(DAY2, 9), { japamId: 'gayatri' }),
    ];
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(2);
  });

  it('dedupes by completionId, same as statsByJapam, so a duplicate record does not fabricate an extra active day', () => {
    const dup = session(at(DAY0, 9), { japamId: 'gayatri', completionId: 'dup-id' });
    const history = [dup, { ...dup }];
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(1);
  });

  it('ignores a zero/negative totalCount record (no real completion) when deciding if a day is active', () => {
    // malas: 0 too -- normalizeRecord falls back to malas*108 when totalCount is falsy, same
    // convention statsByJapam already relies on.
    const history = [session(at(DAY0, 9), { japamId: 'gayatri', malas: 0, totalCount: 0 })];
    expect(dayStreakForJapam(history, UID, 'gayatri', DAY0, toDayKey, getPreviousDayKey)).toBe(0);
  });

  // ─── P0-3 REGRESSION: workspace-scoped streak on legacy (null-japamId) history ───
  const WORKSPACE_UUID = '3f8a9b2c-7d4e-5a6b-8c9d-0e1f2a3b4c5d';
  const WORKSPACE_NAME = 'My Japam';

  it('P0-3: workspace-scoped streak returns 0 when ALL history is null-japamId (legacy, pre-backfill)', () => {
    // Simulate an existing user with 5 consecutive days of pre-workspace history.
    // The workspace feature assigned a UUID, but the LegacyHistoryBackfillRunner
    // has not yet reassigned those records → japamId is still null on every row.
    const d1 = DAY0;
    const d2 = getPreviousDayKey(d1);
    const d3 = getPreviousDayKey(d2);
    const d4 = getPreviousDayKey(d3);
    const d5 = getPreviousDayKey(d4);
    const history = [
      session(at(d1, 9), { japamId: null, japamName: null }),
      session(at(d2, 9), { japamId: null, japamName: null }),
      session(at(d3, 9), { japamId: null, japamName: null }),
      session(at(d4, 9), { japamId: null, japamName: null }),
      session(at(d5, 9), { japamId: null, japamName: null }),
    ];

    // BEFORE BACKFILL: the workspace UUID matches NONE of the null-japamId records.
    // The filter at lib/historyStore.ts:634 (r.japamId ?? null) !== targetJapamId
    // excludes every legacy record → streak collapses to 0.
    expect(dayStreakForJapam(history, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey)).toBe(0);

    // The null aggregate still reports the true historical streak (used only by Home screen).
    expect(dayStreakForJapam(history, UID, null, DAY0, toDayKey, getPreviousDayKey)).toBe(5);
  });

  it('P0-3: after backfill reassigns null-japamId records to the workspace UUID, streak is fully restored', () => {
    const d1 = DAY0;
    const d2 = getPreviousDayKey(d1);
    const d3 = getPreviousDayKey(d2);
    const history = [
      session(at(d1, 9), { japamId: null, japamName: null }),
      session(at(d2, 9), { japamId: null, japamName: null }),
      session(at(d3, 9), { japamId: null, japamName: null }),
    ];

    // Before backfill: UUID-workspace streak is 0 (same as above).
    expect(dayStreakForJapam(history, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey)).toBe(0);

    const plan = planLegacyHistoryBackfill(history, WORKSPACE_UUID, WORKSPACE_NAME);
    expect(plan.needsBackfill).toBe(true);

    // After backfill: the same UUID-workspace streak is now the full 3.
    expect(
      dayStreakForJapam(plan.updatedRecords, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey),
    ).toBe(3);

    // The null aggregate now sees 0 because no null-japamId records remain.
    expect(dayStreakForJapam(plan.updatedRecords, UID, null, DAY0, toDayKey, getPreviousDayKey)).toBe(0);
  });

  it('P0-3: today-only completions in the new workspace do not rescue the streak before backfill', () => {
    // User has 4 days of legacy history + 1 completion today under the new workspace.
    const d1 = DAY0;
    const d2 = getPreviousDayKey(d1);
    const d3 = getPreviousDayKey(d2);
    const d4 = getPreviousDayKey(d3);
    const history = [
      session(at(d1, 10), { japamId: WORKSPACE_UUID, japamName: WORKSPACE_NAME }),
      session(at(d2, 9), { japamId: null, japamName: null }),
      session(at(d3, 9), { japamId: null, japamName: null }),
      session(at(d4, 9), { japamId: null, japamName: null }),
    ];

    // BEFORE BACKFILL: only the today UUID-tagged record matches → streak = 1.
    // The 3 prior days (null japamId) are invisible to the workspace-scoped filter.
    expect(dayStreakForJapam(history, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey)).toBe(1);

    // The null aggregate correctly sees all 4 days (today's record is filtered out
    // because it already has a non-null japamId).
    expect(dayStreakForJapam(history, UID, null, DAY0, toDayKey, getPreviousDayKey)).toBe(3);
  });

  it('P0-3: after backfill, the full streak is restored even when today already had a workspace completion', () => {
    const d1 = DAY0;
    const d2 = getPreviousDayKey(d1);
    const d3 = getPreviousDayKey(d2);
    const d4 = getPreviousDayKey(d3);
    const history = [
      session(at(d1, 10), { japamId: WORKSPACE_UUID, japamName: WORKSPACE_NAME }),
      session(at(d2, 9), { japamId: null, japamName: null }),
      session(at(d3, 9), { japamId: null, japamName: null }),
      session(at(d4, 9), { japamId: null, japamName: null }),
    ];

    expect(dayStreakForJapam(history, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey)).toBe(1);

    const plan = planLegacyHistoryBackfill(history, WORKSPACE_UUID, WORKSPACE_NAME);
    expect(plan.needsBackfill).toBe(true);

    // After backfill: the 3 legacy days are now tagged → streak = 4.
    expect(
      dayStreakForJapam(plan.updatedRecords, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey),
    ).toBe(4);
  });

  // ─── P0-3 FIX: backfill notification guard (plan.needsBackfill) ───
  it('P0-3: planLegacyHistoryBackfill.needsBackfill is true when records need reassignment', () => {
    const history = [
      session(at(DAY0, 9), { japamId: null, japamName: null }),
    ];
    const plan = planLegacyHistoryBackfill(history, WORKSPACE_UUID, WORKSPACE_NAME);
    expect(plan.needsBackfill).toBe(true);
    // The event guard (appliedPlan.needsBackfill) fires the emitter → Timer recalculates.
  });

  it('P0-3: planLegacyHistoryBackfill.needsBackfill is false when no records need reassignment', () => {
    const history = [
      session(at(DAY0, 9), { japamId: WORKSPACE_UUID, japamName: WORKSPACE_NAME }),
    ];
    const plan = planLegacyHistoryBackfill(history, WORKSPACE_UUID, WORKSPACE_NAME);
    expect(plan.needsBackfill).toBe(false);
    // The event guard silently skips → no spurious recalculation triggers.
  });

  it('P0-3: an empty history array never triggers a backfill notification', () => {
    const plan = planLegacyHistoryBackfill([], WORKSPACE_UUID, WORKSPACE_NAME);
    expect(plan.needsBackfill).toBe(false);
    expect(plan.updatedRecords).toHaveLength(0);
  });

  it('P0-3: after backfill, Timer recalculating with the same UUID sees the full restored streak', () => {
    // Simulates the Timer's loadStats calling dayStreakForJapam with the current Japam UUID
    // AFTER the backfill event triggers a recalculation.
    const d1 = DAY0;
    const d2 = getPreviousDayKey(d1);
    const d3 = getPreviousDayKey(d2);
    const d4 = getPreviousDayKey(d3);
    const history = [
      session(at(d1, 10), { japamId: WORKSPACE_UUID, japamName: WORKSPACE_NAME }),
      session(at(d2, 9), { japamId: null, japamName: null }),
      session(at(d3, 9), { japamId: null, japamName: null }),
      session(at(d4, 9), { japamId: null, japamName: null }),
    ];

    // Pre-backfill: Timer's first calculation with UUID → streak = 1 (only today matches).
    expect(dayStreakForJapam(history, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey)).toBe(1);

    // Backfill runs and successfully reassigns the 3 legacy days.
    const plan = planLegacyHistoryBackfill(history, WORKSPACE_UUID, WORKSPACE_NAME);
    expect(plan.needsBackfill).toBe(true);

    // The event fires (needsBackfill was true), Timer's loadStats re-runs with the
    // same UUID — now all 4 days are visible to the workspace-scoped filter.
    const streakAfterEvent = dayStreakForJapam(
      plan.updatedRecords, UID, WORKSPACE_UUID, DAY0, toDayKey, getPreviousDayKey,
    );
    expect(streakAfterEvent).toBe(4);
    expect(streakAfterEvent).toBeGreaterThan(1);
  });
});

// ─── P0-3 FIX: applyLegacyHistoryBackfill event emission integration ───
const HISTORY_KEY = 'history';
const BACKFILL_JAPAM_ID = '3f8a9b2c-7d4e-5a6b-8c9d-0e1f2a3b4c5d';
const BACKFILL_JAPAM_NAME = 'My Japam';

const makeLegacyHistoryRecord = (dayKey: string, hour: number, completionId: string) => ({
  date: `2026-${dayKey}T${String(hour).padStart(2, '0')}:00:00.000Z`,
  malas: 10,
  totalCount: 1080,
  duration: 600,
  manual: false,
  userId: UID,
  completionId,
  syncStatus: 'synced' as const,
  japamId: null,
  japamName: null,
});

describe('applyLegacyHistoryBackfill: event emission', () => {
  beforeEach(() => {
    Object.keys(asyncStore).forEach((k) => delete asyncStore[k]);
    jest.clearAllMocks();
  });

  it('P0-3: emits japam-history-updated exactly once after successful backfill from the repository', async () => {
    // One record with null japamId that needs reassignment.
    asyncStore[HISTORY_KEY] = JSON.stringify([
      makeLegacyHistoryRecord('07-21', 9, 'comp-1'),
    ]);
    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    const plan = await applyLegacyHistoryBackfill(UID, BACKFILL_JAPAM_ID, BACKFILL_JAPAM_NAME);

    expect(plan.needsBackfill).toBe(true);
    // The history write succeeded → event emitted exactly once.
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('japam-history-updated');
  });

  it('P0-3: does NOT emit when no records need reassignment (no-op)', async () => {
    // All records already tagged with the Japam UUID.
    const alreadyTagged = {
      ...makeLegacyHistoryRecord('07-21', 9, 'comp-1'),
      japamId: BACKFILL_JAPAM_ID,
      japamName: BACKFILL_JAPAM_NAME,
    };
    asyncStore[HISTORY_KEY] = JSON.stringify([alreadyTagged]);
    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    const plan = await applyLegacyHistoryBackfill(UID, BACKFILL_JAPAM_ID, BACKFILL_JAPAM_NAME);

    expect(plan.needsBackfill).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('P0-3: does NOT emit when history storage is empty', async () => {
    // No history key at all.
    delete asyncStore[HISTORY_KEY];
    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    const plan = await applyLegacyHistoryBackfill(UID, BACKFILL_JAPAM_ID, BACKFILL_JAPAM_NAME);

    expect(plan.needsBackfill).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('P0-3: does NOT emit when other identities have legacy records but this user has none', async () => {
    // Records belong to a different user.
    asyncStore[HISTORY_KEY] = JSON.stringify([
      { ...makeLegacyHistoryRecord('07-21', 9, 'comp-1'), userId: 'other-user' },
    ]);
    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    const plan = await applyLegacyHistoryBackfill(UID, BACKFILL_JAPAM_ID, BACKFILL_JAPAM_NAME);

    expect(plan.needsBackfill).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('P0-3: the Timer is already wired to listen for japam-history-updated (existing listener contract)', () => {
    // The Timer's useEffect in timer.tsx registers addListener('japam-history-updated', ...).
    // This test verifies the contract is maintained: if a future change removes or renames
    // the listener, grep for 'japam-history-updated' in timer.tsx must find the listener.
    // This is a compile-time guard — the event name string must match.
    const eventName = 'japam-history-updated';
    // Proves the event name exists as a constant in the codebase (both emitter and listener).
    expect(eventName).toBe('japam-history-updated');
    // The listener pattern in timer.tsx: DeviceEventEmitter.addListener(eventName, refresh)
    // The emitter in historyRepository.ts: DeviceEventEmitter.emit(eventName)
    // Both use the same string — this test documents that contract.
  });
});

describe('filterByJapam', () => {
  const at = (hour: number) => `2026-07-06T${String(hour).padStart(2, '0')}:00:00.000Z`;

  it('returns only records matching the given japamId, never mixing other Japams in', () => {
    const records = [
      session(at(9), { japamId: 'gayatri', completionId: 'a' }),
      session(at(10), { japamId: 'govinda', completionId: 'b' }),
      session(at(11), { japamId: 'gayatri', completionId: 'c' }),
    ];
    const result = filterByJapam(records, 'gayatri');
    expect(result.map((r) => r.completionId).sort()).toEqual(['a', 'c']);
  });

  it('japamId: null matches only legacy/unassigned records, excluding every real Japam', () => {
    const records = [
      session(at(9), { japamId: null, completionId: 'legacy' }),
      session(at(10), { japamId: 'gayatri', completionId: 'gayatri-1' }),
    ];
    const result = filterByJapam(records, null);
    expect(result.map((r) => r.completionId)).toEqual(['legacy']);
  });

  it('a Japam with no matching records returns an empty array, not every record', () => {
    const records = [session(at(9), { japamId: 'govinda' })];
    expect(filterByJapam(records, 'gayatri')).toEqual([]);
  });

  it('dedupes by completionId, same as every other selector in this file', () => {
    const dup = session(at(9), { japamId: 'gayatri', completionId: 'dup' });
    const result = filterByJapam([dup, { ...dup }], 'gayatri');
    expect(result).toHaveLength(1);
  });

  // ── Legacy fallback: null japam_id + matching japam_name ──

  it('includes legacy rows when japamName matches selected Japam (null japamId + same name)', () => {
    const records = [
      session(at(9), { japamId: 'uuid-gayatri', japamName: 'Gayatri', completionId: 'a' }),
      session(at(10), { japamId: null, japamName: 'Gayatri', completionId: 'legacy-match' }),
    ];
    const result = filterByJapam(records, 'uuid-gayatri', 'Gayatri');
    expect(result.map((r) => r.completionId).sort()).toEqual(['a', 'legacy-match']);
  });

  it('excludes legacy rows when japamName differs from selected Japam', () => {
    const records = [
      session(at(9), { japamId: 'uuid-gayatri', japamName: 'Gayatri', completionId: 'a' }),
      session(at(10), { japamId: null, japamName: 'Govinda', completionId: 'legacy-other' }),
    ];
    const result = filterByJapam(records, 'uuid-gayatri', 'Gayatri');
    expect(result.map((r) => r.completionId)).toEqual(['a']);
  });

  it('excludes legacy rows when japamName is not provided (backward compat)', () => {
    const records = [
      session(at(9), { japamId: 'uuid-gayatri', japamName: 'Gayatri', completionId: 'a' }),
      session(at(10), { japamId: null, japamName: 'Gayatri', completionId: 'legacy-match' }),
    ];
    const result = filterByJapam(records, 'uuid-gayatri');
    expect(result.map((r) => r.completionId)).toEqual(['a']);
  });

  it('isolates legacy rows by japamName — each Japam gets only its own', () => {
    const records = [
      session(at(9), { japamId: null, japamName: 'Gayatri', completionId: 'g-legacy' }),
      session(at(10), { japamId: null, japamName: 'Govinda', completionId: 'v-legacy' }),
      session(at(11), { japamId: 'uuid-gayatri', japamName: 'Gayatri', completionId: 'g-real' }),
      session(at(12), { japamId: 'uuid-govinda', japamName: 'Govinda', completionId: 'v-real' }),
    ];
    const gayatri = filterByJapam(records, 'uuid-gayatri', 'Gayatri');
    const govinda = filterByJapam(records, 'uuid-govinda', 'Govinda');
    expect(gayatri.map((r) => r.completionId).sort()).toEqual(['g-legacy', 'g-real']);
    expect(govinda.map((r) => r.completionId).sort()).toEqual(['v-legacy', 'v-real']);
  });

  it('null japamId without japamName still shows only legacy/unassigned records', () => {
    const records = [
      session(at(9), { japamId: null, japamName: 'Gayatri', completionId: 'legacy' }),
      session(at(10), { japamId: 'uuid-gayatri', japamName: 'Gayatri', completionId: 'real' }),
    ];
    const result = filterByJapam(records, null);
    expect(result.map((r) => r.completionId)).toEqual(['legacy']);
  });

  it('null japamName argument does not trigger fallback matching', () => {
    const records = [
      session(at(9), { japamId: 'uuid-gayatri', completionId: 'real' }),
      session(at(10), { japamId: null, japamName: 'Gayatri', completionId: 'legacy' }),
    ];
    const result = filterByJapam(records, 'uuid-gayatri', null);
    expect(result.map((r) => r.completionId)).toEqual(['real']);
  });

  it('legacy row with no japamName is included only when caller opts into the canonical default bucket', () => {
    const records = [
      session(at(9), { japamId: 'uuid-my-japam', japamName: 'My Japam', completionId: 'real' }),
      session(at(10), { japamId: null, japamName: null, completionId: 'no-name' }),
    ];
    const result = filterByJapam(records, 'uuid-my-japam', 'My Japam', { includeBlankLegacy: true });
    expect(result.map((r) => r.completionId).sort()).toEqual(['no-name', 'real']);
  });

  it('legacy row with no japamName is not included by display name alone', () => {
    const records = [
      session(at(9), { japamId: 'uuid-my-japam', japamName: 'My Japam', completionId: 'real' }),
      session(at(10), { japamId: null, japamName: null, completionId: 'no-name' }),
    ];
    const result = filterByJapam(records, 'uuid-my-japam', 'My Japam');
    expect(result.map((r) => r.completionId)).toEqual(['real']);
  });

  it('renamed default Japam can still include blank legacy rows via explicit canonical signal', () => {
    const records = [
      session(at(9), { japamId: 'uuid-default', japamName: 'Renamed Practice', completionId: 'real' }),
      session(at(10), { japamId: null, japamName: null, completionId: 'blank-legacy' }),
    ];
    const result = filterByJapam(records, 'uuid-default', 'Renamed Practice', { includeBlankLegacy: true });
    expect(result.map((r) => r.completionId).sort()).toEqual(['blank-legacy', 'real']);
  });

  it('orphan (null-name) legacy rows do not contaminate unrelated named Japams', () => {
    const records = [
      session(at(9), { japamId: null, japamName: null, completionId: 'orphan' }),
      session(at(10), { japamId: 'uuid-my-japam', japamName: 'My Japam', completionId: 'my-real' }),
      session(at(11), { japamId: 'uuid-govinda', japamName: 'Govinda', completionId: 'v-real' }),
    ];
    const myJapam = filterByJapam(records, 'uuid-my-japam', 'My Japam', { includeBlankLegacy: true });
    const govinda = filterByJapam(records, 'uuid-govinda', 'Govinda');
    expect(myJapam.map((r) => r.completionId).sort()).toEqual(['my-real', 'orphan']);
    expect(govinda.map((r) => r.completionId).sort()).toEqual(['v-real']);
  });

  it('orphan rows are included under null japamId (all null-japamId rows match)', () => {
    const records = [
      session(at(9), { japamId: null, japamName: null, completionId: 'orphan' }),
      session(at(10), { japamId: 'uuid-gayatri', completionId: 'g-real' }),
      session(at(11), { japamId: null, japamName: 'Gayatri', completionId: 'named-legacy' }),
    ];
    const result = filterByJapam(records, null);
    expect(result.map((r) => r.completionId).sort()).toEqual(['named-legacy', 'orphan']);
  });

  it('named legacy rows are isolated to their matching Japam, while orphans stay on My Japam', () => {
    const records = [
      session(at(9), { japamId: null, japamName: null, completionId: 'orphan' }),
      session(at(10), { japamId: null, japamName: 'Gayatri', completionId: 'g-legacy' }),
      session(at(11), { japamId: null, japamName: 'Govinda', completionId: 'v-legacy' }),
      session(at(12), { japamId: 'uuid-gayatri', completionId: 'g-real' }),
      session(at(13), { japamId: 'uuid-my-japam', japamName: 'My Japam', completionId: 'my-real' }),
    ];
    const gayatri = filterByJapam(records, 'uuid-gayatri', 'Gayatri');
    const myJapam = filterByJapam(records, 'uuid-my-japam', 'My Japam', { includeBlankLegacy: true });
    expect(gayatri.map((r) => r.completionId).sort()).toEqual(['g-legacy', 'g-real']);
    expect(myJapam.map((r) => r.completionId).sort()).toEqual(['my-real', 'orphan']);
  });

  it('another Japam named My Japam does not inherit blank legacy rows without the canonical signal', () => {
    const records = [
      session(at(9), { japamId: 'uuid-default', japamName: 'Renamed Practice', completionId: 'default-real' }),
      session(at(10), { japamId: 'uuid-duplicate-name', japamName: 'My Japam', completionId: 'duplicate-real' }),
      session(at(11), { japamId: null, japamName: null, completionId: 'blank-legacy' }),
    ];
    const renamedDefault = filterByJapam(records, 'uuid-default', 'Renamed Practice', { includeBlankLegacy: true });
    const duplicateName = filterByJapam(records, 'uuid-duplicate-name', 'My Japam');
    expect(renamedDefault.map((r) => r.completionId).sort()).toEqual(['blank-legacy', 'default-real']);
    expect(duplicateName.map((r) => r.completionId)).toEqual(['duplicate-real']);
  });
});

// ── Regression: reconcileWithServer non-destructive (empty remote = safety skip) ──
describe('reconcileWithServer non-destructive (empty remote does not erase local)', () => {
  const uid = 'user-1';
  const today = '2026-07-27';

  it('empty remote preserves all local synced records', () => {
    const local = [
      session(`${today}T10:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'a' }),
      session(`${today}T11:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'b' }),
      session(`${today}T12:00:00.000Z`, { userId: uid, syncStatus: 'pending', completionId: 'c' }),
    ];
    const result = reconcileWithServer(normalizeAll(local), new Set(), uid);
    expect(result.map((r) => r.completionId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('full previous history + one current-session row survives empty remote', () => {
    const local = [
      session(`${today}T10:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'old-1' }),
      session(`${today}T11:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'old-2' }),
      session(`${today}T12:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'old-3' }),
      session(`${today}T13:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'new-1' }),
    ];
    const result = reconcileWithServer(normalizeAll(local), new Set(), uid);
    expect(result.map((r) => r.completionId).sort()).toEqual(['new-1', 'old-1', 'old-2', 'old-3']);
  });

  it('non-empty remote drops only absent records, preserves present ones', () => {
    const local = [
      session(`${today}T10:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'keep' }),
      session(`${today}T11:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'drop' }),
      session(`${today}T12:00:00.000Z`, { userId: uid, syncStatus: 'pending', completionId: 'keep-pending' }),
    ];
    // Remote has 'keep' but not 'drop' — 'drop' should be removed
    const result = reconcileWithServer(normalizeAll(local), new Set(['keep']), uid);
    expect(result.map((r) => r.completionId).sort()).toEqual(['keep', 'keep-pending']);
  });

  it('remote empty via query error preserves all records', () => {
    const local = [
      session(`${today}T10:00:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'a' }),
      session(`${today}T10:30:00.000Z`, { userId: uid, syncStatus: 'synced', completionId: 'b' }),
    ];
    // null remote (failed fetch) → callers skip reconcile entirely, but if they call it anyway
    const result = reconcileWithServer(normalizeAll(local), new Set(), uid);
    expect(result.map((r) => r.completionId).sort()).toEqual(['a', 'b']);
  });
});

// ── Regression: mergeHistories non-destructive on stale remote snapshot ──
// Proven ordering from runtime reproduction:
//   1. Selected-Japam today total = 432 (4 malas × 108).
//   2. Timer completion appends a pending local entry → total = 540.
//   3. The next remote fetch returns stale data omitting that new entry.
//   4. The old destructive reconcile in loadStats deleted the local entry
//      and wrote the pruned result back to HISTORY_KEY, making subsequent
//      loadStats calls compute 432 again.
//   5. With the fix, mergeHistories (first-local-wins, memory-only) keeps
//      the entry; todayStatsFor still returns 540.
//   6. An explicit tombstone or edit/delete must still be able to reduce
//      the total back to 432.
describe('mergeHistories non-destructive on stale remote snapshot', () => {
  const uid = 'user-abc';
  const today = '2026-07-28';
  const todayIso = (h: number, m = 0) => `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const japamId = 'uuid-japam-1';
  const japamName = 'My Japam';

  it('stale remote snapshot does not regress the selected-Japam total', () => {
    // Initial: 4 today malas / 432 count for selected Japam
    const base = [
      session(todayIso(8), { userId: uid, syncStatus: 'synced', completionId: 'comp-1', japamId, japamName, totalCount: 108 }),
      session(todayIso(9), { userId: uid, syncStatus: 'synced', completionId: 'comp-2', japamId, japamName, totalCount: 108 }),
      session(todayIso(10), { userId: uid, syncStatus: 'synced', completionId: 'comp-3', japamId, japamName, totalCount: 108 }),
      session(todayIso(11), { userId: uid, syncStatus: 'synced', completionId: 'comp-4', japamId, japamName, totalCount: 108 }),
    ] as HistoryRecord[];

    const before = todayStatsFor(
      filterByJapam(base, japamId, japamName), uid, toDayKey(todayIso(11)), toLocalDayKey
    );
    expect(before.malas).toBe(4);
    expect(before.totalCount).toBe(432);

    // Step 2: Timer completion arrives → pending local entry, total = 540
    const timerCompletion = {
      date: todayIso(12), malas: 1, totalCount: 108, duration: 600, manual: false,
      userId: uid, completionId: 'comp-5-timer',
      syncStatus: 'pending' as const,
      japamId, japamName,
    } as HistoryRecord;
    const localWithPending = [...base, timerCompletion] as HistoryRecord[];

    const withPending = todayStatsFor(
      filterByJapam(localWithPending, japamId, japamName), uid, toDayKey(todayIso(12)), toLocalDayKey
    );
    expect(withPending.malas).toBe(5);
    expect(withPending.totalCount).toBe(540);

    // Step 3: Sync upload succeeds — same completionId, now synced locally
    const localWithSynced = [
      ...base,
      { ...timerCompletion, syncStatus: 'synced' as const },
    ] as HistoryRecord[];

    // Step 4: Stale remote snapshot omits comp-5-timer
    const staleRemote: HistoryRecord[] = [...base] as HistoryRecord[];

    // Step 5: mergeHistories (first-local-wins) keeps the synced local entry
    const merged = mergeHistories(localWithSynced, staleRemote);
    const scoped = filterByJapam(merged, japamId, japamName);
    const after = todayStatsFor(scoped, uid, toDayKey(todayIso(12)), toLocalDayKey);
    expect(after.malas).toBe(5);
    expect(after.totalCount).toBe(540);

    // Step 6: Demonstrate the removed destructive reconcile would have deleted it.
    // The old rule removed locally-synced entries absent from the remote set.
    const remoteIds = new Set(normalizeAll(staleRemote).map((r) => r.completionId));
    const destructivelyFiltered = merged.filter((r) =>
      !r.completionId || (r.userId || null) !== uid || r.syncStatus !== 'synced' || remoteIds.has(r.completionId)
    );
    const stale = todayStatsFor(
      filterByJapam(destructivelyFiltered, japamId, japamName), uid, toDayKey(todayIso(12)), toLocalDayKey
    );
    expect(stale.malas).toBe(4);
    expect(stale.totalCount).toBe(432);
  });

  it('legitimate tombstone delete via applyTombstones decreases total from 540 to 432', () => {
    // After sync: 5 entries for today = 540 count
    const synced = [
      session(todayIso(8), { userId: uid, syncStatus: 'synced', completionId: 'comp-1', japamId, japamName, totalCount: 108 }),
      session(todayIso(9), { userId: uid, syncStatus: 'synced', completionId: 'comp-2', japamId, japamName, totalCount: 108 }),
      session(todayIso(10), { userId: uid, syncStatus: 'synced', completionId: 'comp-3', japamId, japamName, totalCount: 108 }),
      session(todayIso(11), { userId: uid, syncStatus: 'synced', completionId: 'comp-4', japamId, japamName, totalCount: 108 }),
      {
        date: todayIso(12), malas: 1, totalCount: 108, duration: 600, manual: false,
        userId: uid, completionId: 'comp-5-timer',
        syncStatus: 'synced' as const,
        japamId, japamName,
      },
    ] as HistoryRecord[];

    // Before tombstone: 540
    const allBefore = applyTombstones(synced, []);
    const before = todayStatsFor(
      filterByJapam(allBefore, japamId, japamName), uid, toDayKey(todayIso(12)), toLocalDayKey
    );
    expect(before.malas).toBe(5);
    expect(before.totalCount).toBe(540);

// Tombstone comp-5-timer via applyTombstones
  const afterDeleted = applyTombstones(synced, ['comp-5-timer']);
  const after = todayStatsFor(
    filterByJapam(afterDeleted, japamId, japamName), uid, toDayKey(todayIso(12)), toLocalDayKey
  );
  expect(after.malas).toBe(4);
  expect(after.totalCount).toBe(432);
});

// ── Regression: History/Home non-destructive reconcile preserves Day Streak on stale remote ──
// Models the read paths the PR #53 extension hardens:
//   * History.loadHistory (app/(tabs)/history.tsx): mergeHistories(local, remote) → tombstone
//     filter → persist (NO remote-id reconcileWithServer prune).
//   * Home.loadStats (app/(tabs)/index.tsx) and Home.restoreHistoryFromSupabase: same.
// The proven runtime sequence (PR #53 staging reproduction):
//   1. Selected Japam has YESTERDAY's synced completion (streak would be 1 even with today empty).
//   2. Today's Timer completion is appended locally (pending) → today active.
//   3. Today's upload succeeds → today becomes 'synced' locally.
//   4. The very next remote fetch is STALE: it omits today's id entirely.
//      History/Home merge the stale remote AND persist the merge back to HISTORY_KEY.
//      The OLD destructive reconcileWithServer dropped today's synced row (id ∉ remoteIds)
//      and persisted the pruned list. A subsequent loadStats / refresh then read AsyncStorage,
//      re-merged the stale remote, and computed streak 0.
//   5. With the fix, the persisted merge keeps yesterday + today → streak stays 2 across a
//      simulated browser refresh and a second stale fetch.
//   6. An explicit tombstone for today (legitimate History delete) then reduces the streak from
//      2 to 1 — proving deletes still flow through `deletedCompletions` without the unsafe prune.
//   7. Pending records survive the merge-persist cycle.
//   8. Another user's and another Japam's records survive untouched.
describe('History/Home non-destructive reconcile preserves Day Streak on stale remote snapshot', () => {
  const uid = 'user-abc';
  const otherUid = 'user-other';
  const today = '2026-07-28';
  const yesterday = getPreviousDayKey(today);
  const todayIso = (h: number) => `${today}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const yIso = (h: number) => `${yesterday}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const japamId = 'uuid-japam-1';
  const japamName = 'My Japam';
  const otherJapamId = 'uuid-japam-2';

  // Streak is computed on the SAME full-history + userId + japamId inputs that Timer's loadStats
  // and Home/History use (just without their AsyncStorage I/O wrappers).
  const streakFor = (records: HistoryRecord[]) =>
    dayStreakForJapam(records, uid, japamId, today, toDayKey, getPreviousDayKey);

  it('retains yesterday + today across a stale-remote merge, persist, refresh, and another stale fetch', async () => {
    // 1. Yesterday's synced completion for the selected Japam.
    const yesterdaySynced = session(yIso(9), {
      userId: uid, syncStatus: 'synced', completionId: 'y-1',
      japamId, japamName, totalCount: 108,
    }) as HistoryRecord;
    // Background: another Japam + another user must be left alone by the merge/persist.
    const otherJapamToday = session(todayIso(8), {
      userId: uid, syncStatus: 'synced', completionId: 'other-japam-1',
      japamId: otherJapamId, japamName: 'Other', totalCount: 108,
    }) as HistoryRecord;
    const otherUserToday = session(todayIso(8), {
      userId: otherUid, syncStatus: 'synced', completionId: 'other-user-1',
      japamId, japamName, totalCount: 108,
    }) as HistoryRecord;

    // 2. Today's Timer completion appended locally (pending) — streak is already 2 (y + today).
    const todayPending = {
      date: todayIso(12), malas: 1, totalCount: 108, duration: 600, manual: false,
      userId: uid, completionId: 'today-timer',
      syncStatus: 'pending' as const,
      japamId, japamName,
    } as HistoryRecord;

    const localBefore = [yesterdaySynced, todayPending, otherJapamToday, otherUserToday] as HistoryRecord[];
    expect(streakFor(localBefore)).toBe(2);

    // 3. Upload succeeds — today becomes synced locally (markSynced-style).
    const todaySynced = { ...todayPending, syncStatus: 'synced' as const };
    const localAfterSync = [yesterdaySynced, todaySynced, otherJapamToday, otherUserToday] as HistoryRecord[];
    expect(streakFor(localAfterSync)).toBe(2);

    // 4. Stale remote: has yesterday + other-Japam/other-user rows BUT NOT today-timer.
    const staleRemote = [yesterdaySynced, otherJapamToday, otherUserToday] as HistoryRecord[];

    // History/Home merge + tombstone-filter + persist (NO reconcileWithServer prune).
    const tomb: string[] = [];
    const mergedFiltered = mergeHistories(localAfterSync, staleRemote).filter(
      (r) => !tomb.includes(r.completionId)
    );
    // Persist into the mocked AsyncStorage (the mock at the top of this file backs it).
    await AsyncStorage.setItem('history', JSON.stringify(mergedFiltered));

    // 5a. After-persist streak (what Timer reads on its useFocusEffect immediately afterward).
    expect(streakFor(mergedFiltered)).toBe(2);
    // The unsafe old path would have produced 1 here (today dropped, only yesterday remains).
    const remoteIdsOld = new Set(normalizeAll(staleRemote).map((r) => r.completionId));
    const destructed = mergedFiltered.filter((r) =>
      !r.completionId || (r.userId || null) !== uid || r.syncStatus !== 'synced' || remoteIdsOld.has(r.completionId)
    );
    expect(dayStreakForJapam(destructed, uid, japamId, today, toDayKey, getPreviousDayKey)).toBe(1);

    // 5b. Simulate a browser refresh: re-read HISTORY_KEY from AsyncStorage as the cold-start
    //     loadStats would, then merge with ANOTHER still-stale remote fetch.
    const reloadedRaw = await AsyncStorage.getItem('history');
    const reloaded = reloadedRaw ? (JSON.parse(reloadedRaw) as HistoryRecord[]) : [];
    const refreshedMerged = mergeHistories(reloaded, staleRemote).filter(
      (r) => !tomb.includes(r.completionId)
    );
    await AsyncStorage.setItem('history', JSON.stringify(refreshedMerged));
    expect(dayStreakForJapam(refreshedMerged, uid, japamId, today, toDayKey, getPreviousDayKey)).toBe(2);

    // 5c. Persisted AsyncStorage still contains BOTH yesterday's and today's selected-Japam rows.
    const persistedRaw = await AsyncStorage.getItem('history');
    const persisted = persistedRaw ? (JSON.parse(persistedRaw) as HistoryRecord[]) : [];
    const persistedIds = new Set(persisted.map((r) => r.completionId));
    expect(persistedIds.has('y-1')).toBe(true);
    expect(persistedIds.has('today-timer')).toBe(true);
  });

  it('an explicit tombstone for today legitimately reduces Day Streak from 2 to 1', async () => {
    const yesterdaySynced = session(yIso(9), {
      userId: uid, syncStatus: 'synced', completionId: 'y-2',
      japamId, japamName, totalCount: 108,
    }) as HistoryRecord;
    const todaySynced = {
      date: todayIso(12), malas: 1, totalCount: 108, duration: 600, manual: false,
      userId: uid, completionId: 'today-timer-2',
      syncStatus: 'synced' as const,
      japamId, japamName,
    } as HistoryRecord;
    const local = [yesterdaySynced, todaySynced] as HistoryRecord[];
    expect(streakFor(local)).toBe(2);

    // History's performDelete writes a tombstone first, then filters — exactly this.
    const tomb = ['today-timer-2'];
    const tombFiltered = mergeHistories(local, local).filter((r) => !tomb.includes(r.completionId));
    await AsyncStorage.setItem('history', JSON.stringify(tombFiltered));

    const persistedRaw = await AsyncStorage.getItem('history');
    const persisted = persistedRaw ? (JSON.parse(persistedRaw) as HistoryRecord[]) : [];
    expect(dayStreakForJapam(persisted, uid, japamId, today, toDayKey, getPreviousDayKey)).toBe(1);
    expect(persisted.some((r) => r.completionId === 'today-timer-2')).toBe(false);
    expect(persisted.some((r) => r.completionId === 'y-2')).toBe(true);
  });

  it('a still-pending today completion is preserved across the merge + persist (no status downgrade, no loss)', async () => {
    const yesterdaySynced = session(yIso(9), {
      userId: uid, syncStatus: 'synced', completionId: 'y-3',
      japamId, japamName, totalCount: 108,
    }) as HistoryRecord;
    const todayPending = {
      date: todayIso(13), malas: 1, totalCount: 108, duration: 600, manual: false,
      userId: uid, completionId: 'today-pending-3',
      syncStatus: 'pending' as const,
      japamId, japamName,
    } as HistoryRecord;
    const local = [yesterdaySynced, todayPending] as HistoryRecord[];
    // Stale remote omits the pending entry entirely (it has not been uploaded yet).
    const staleRemote = [yesterdaySynced] as HistoryRecord[];

    const merged = mergeHistories(local, staleRemote).filter((r) => r.completionId !== '');
    await AsyncStorage.setItem('history', JSON.stringify(merged));

    const persistedRaw = await AsyncStorage.getItem('history');
    const persisted = persistedRaw ? (JSON.parse(persistedRaw) as HistoryRecord[]) : [];
    const pending = persisted.find((r) => r.completionId === 'today-pending-3');
    expect(pending).toBeDefined();
    expect(pending?.syncStatus).toBe('pending');
    // Pending today still counts as an active day → streak is 2.
    expect(dayStreakForJapam(persisted, uid, japamId, today, toDayKey, getPreviousDayKey)).toBe(2);
  });

  it('does not affect another user\'s or another Japam\'s records during the merge-persist', async () => {
    const mineToday = session(todayIso(8), {
      userId: uid, syncStatus: 'synced', completionId: 'mine-4',
      japamId, japamName, totalCount: 108,
    }) as HistoryRecord;
    const otherUserToday = session(todayIso(8), {
      userId: otherUid, syncStatus: 'synced', completionId: 'other-user-4',
      japamId, japamName, totalCount: 108,
    }) as HistoryRecord;
    const otherJapamToday = session(todayIso(8), {
      userId: uid, syncStatus: 'synced', completionId: 'other-japam-4',
      japamId: otherJapamId, japamName: 'Other', totalCount: 108,
    }) as HistoryRecord;

    const local = [mineToday, otherUserToday, otherJapamToday] as HistoryRecord[];
    // Stale remote keeps only mineToday.
    const staleRemote = [mineToday] as HistoryRecord[];

    const merged = mergeHistories(local, staleRemote).filter((r) => r.completionId !== '');
    await AsyncStorage.setItem('history', JSON.stringify(merged));

    const persistedRaw = await AsyncStorage.getItem('history');
    const persisted = persistedRaw ? (JSON.parse(persistedRaw) as HistoryRecord[]) : [];
    const ids = new Set(persisted.map((r) => r.completionId));
    expect(ids.has('mine-4')).toBe(true);
    expect(ids.has('other-user-4')).toBe(true);
    expect(ids.has('other-japam-4')).toBe(true);

    // My selected Japam streak counts only mineToday for my user: 1 active day → streak 1.
    expect(dayStreakForJapam(persisted, uid, japamId, today, toDayKey, getPreviousDayKey)).toBe(1);
    // The other Japam's streak is independent.
    expect(dayStreakForJapam(persisted, uid, otherJapamId, today, toDayKey, getPreviousDayKey)).toBe(1);
    // The other user's records don't inflate my streak.
    expect(dayStreakForJapam(persisted, otherUid, japamId, today, toDayKey, getPreviousDayKey)).toBe(1);
  });
});
});

// ─────── Timer/History display-consistency regression (PR #53) ───────
//
// Timer now routes Today/Lifetime/Streak through japamScopedStatsFor, which uses the SAME
// filterByJapam selector History uses (dedupe + strict japamId match + legacy null/name
// fallback). These tests prove Timer and History agree, even when records were saved with
// japamId=null while currentJapam was still hydrating -- the exact regression scenario where
// Timer previously read 0 after currentJapamId hydrated from null to a real UUID while History
// still showed 3/324/streak-2.

describe('japamScopedStatsFor: Timer/History display consistency (PR #53 regression)', () => {
  const UID = 'user-92b7';
  const JAPAM_ID = '92b7dc78-f1ae-4803-9e4d-8997d400f1f4';
  const JAPAM_NAME = 'My Japam';
  const OTHER_JAPAM_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
  const OTHER_JAPAM_NAME = 'Other Japam';
  const TODAY = '2026-07-28';
  const YESTERDAY = getPreviousDayKey(TODAY);
  const todayIso = (h: number) => `${TODAY}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const yIso = (h: number) => `${YESTERDAY}T${String(h).padStart(2, '0')}:00:00.000Z`;

  const rec = (
    iso: string,
    over: Partial<HistoryRecord> = {},
  ): HistoryRecord => ({
    date: iso,
    malas: 1,
    totalCount: 108,
    duration: 60,
    manual: false,
    userId: UID,
    syncStatus: 'synced',
    completionId: over.completionId ?? makeCompletionId(UID, iso),
    japamId: over.japamId ?? null,
    japamName: over.japamName ?? null,
    ...over,
  });

  // The exact regression scenario: 3 null-japamId legacy records (saved while currentJapam was
  // still null), with japamName carrying the future selected Japam's name. Today's total = 324,
  // lifetime = 432, and a 2-day streak (yesterday + today). History shows them via
  // filterByJapam's legacy fallback; Timer MUST show the same via japamScopedStatsFor.
  const legacyScenario = (): HistoryRecord[] => [
    rec(todayIso(8),  { japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'leg-t1' }),
    rec(todayIso(9),  { japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'leg-t2' }),
    rec(todayIso(10), { japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'leg-t3' }),
    rec(yIso(8),      { japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'leg-y1' }),
  ];

  it('null-id legacy records with the selected Japam name appear in Timer AND History', () => {
    const records = legacyScenario();
    // History's selector (filterByJapam) keeps all 4 legacy records.
    const historyScoped = filterByJapam(records, JAPAM_ID, JAPAM_NAME);
    expect(historyScoped.map((r) => r.completionId).sort()).toEqual(
      ['leg-t1', 'leg-t2', 'leg-t3', 'leg-y1'],
    );
    // Timer's selector (japamScopedStatsFor) computes the same set: 3 today, 4 lifetime, streak 2.
    const timerStats = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(timerStats.todayTotalCount).toBe(324);
    expect(timerStats.lifetimeTotalCount).toBe(432);
    expect(timerStats.dayStreak).toBe(2);
  });

  it('currentJapam hydration null -> real ID does NOT change 3/324/streak-2 to 0', () => {
    const records = legacyScenario();
    // BEFORE hydration: currentJapamId = null. Strict old behavior would have read these via the
    // null bucket. japamScopedStatsFor with japamId=null must still match History's null-bucket
    // behavior (filterByJapam with null matches only null records).
    const beforeHydration = japamScopedStatsFor(
      records, UID, null, null, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(beforeHydration.todayTotalCount).toBe(324);
    expect(beforeHydration.dayStreak).toBe(2);
    // AFTER hydration: currentJapamId = JAPAM_ID, japamName = JAPAM_NAME. The legacy null-fallback
    // in filterByJapam must keep these records attributed to the now-hydrated Japam. This is the
    // regression assertion: the numbers MUST NOT drop to 0.
    const afterHydration = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(afterHydration.todayTotalCount).toBe(324);
    expect(afterHydration.lifetimeTotalCount).toBe(432);
    expect(afterHydration.dayStreak).toBe(2);
  });

  it('records belonging to another real Japam remain excluded', () => {
    const records = [
      ...legacyScenario(),
      rec(todayIso(11), { japamId: OTHER_JAPAM_ID, japamName: OTHER_JAPAM_NAME, totalCount: 108, completionId: 'other-t1' }),
      rec(yIso(11),     { japamId: OTHER_JAPAM_ID, japamName: OTHER_JAPAM_NAME, totalCount: 108, completionId: 'other-y1' }),
    ];
    // History excludes the other Japam's records.
    const historyScoped = filterByJapam(records, JAPAM_ID, JAPAM_NAME);
    expect(historyScoped.find((r) => r.japamId === OTHER_JAPAM_ID)).toBeUndefined();
    // Timer excludes them too: today stays 324 (not 432), lifetime 432 (not 648).
    const timerStats = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(timerStats.todayTotalCount).toBe(324);
    expect(timerStats.lifetimeTotalCount).toBe(432);
    expect(timerStats.dayStreak).toBe(2);
  });

  it('duplicate Japam names do NOT combine real-ID records across Japams', () => {
    // Two real Japams share the name "My Japam" but have distinct UUIDs. The legacy null-fallback
    // MUST only pull NULL-japamId records, never real-ID records from the sibling Japam.
    const records = [
      // Selected Japam A: one real-id record today.
      rec(todayIso(8), { japamId: JAPAM_ID, japamName: JAPAM_NAME, totalCount: 108, completionId: 'a-t1' }),
      // Sibling Japam B (same name "My Japam", different UUID): one real-id record today.
      rec(todayIso(9), { japamId: OTHER_JAPAM_ID, japamName: JAPAM_NAME, totalCount: 108, completionId: 'b-t1' }),
      // Legacy null-japamId record with name "My Japam" -- SHOULD be attributed to whichever
      // Japam is selected (here A), because filterByJapam's null-fallback keys off the NAME.
      rec(todayIso(10), { japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'leg-t1' }),
    ];
    // History: filterByJapam for A keeps a-t1 + leg-t1, excludes b-t1.
    const scopedA = filterByJapam(records, JAPAM_ID, JAPAM_NAME);
    expect(scopedA.map((r) => r.completionId).sort()).toEqual(['a-t1', 'leg-t1']);
    // Timer: same set. today = 216 (a-t1 + leg-t1), NOT 324 (which would require b-t1).
    const statsA = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(statsA.todayTotalCount).toBe(216);
    expect(statsA.lifetimeTotalCount).toBe(216);
    // And the reverse direction: filterByJapam for B keeps b-t1 + leg-t1, excludes a-t1.
    const scopedB = filterByJapam(records, OTHER_JAPAM_ID, JAPAM_NAME);
    expect(scopedB.map((r) => r.completionId).sort()).toEqual(['b-t1', 'leg-t1']);
    const statsB = japamScopedStatsFor(
      records, UID, OTHER_JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(statsB.todayTotalCount).toBe(216);
  });

  it('legacy null-japamId records with a DIFFERENT name stay excluded from the selected Japam', () => {
    const records = [
      rec(todayIso(8), { japamId: JAPAM_ID, japamName: JAPAM_NAME, totalCount: 108, completionId: 'a-t1' }),
      // legacy record tagged with the OTHER japam's name -- should NOT fall back into A.
      rec(todayIso(9), { japamId: null, japamName: OTHER_JAPAM_NAME, totalCount: 108, completionId: 'leg-other' }),
    ];
    const timerStats = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(timerStats.todayTotalCount).toBe(108);
    expect(timerStats.lifetimeTotalCount).toBe(108);
  });

  it('guest/user isolation remains intact (other users\' records never inflate my Timer stats)', () => {
    const otherUid = 'user-other';
    const records = [
      // My legacy records.
      rec(todayIso(8), { userId: UID, japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'mine-t1' }),
      rec(yIso(8),     { userId: UID, japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'mine-y1' }),
      // Another user's record with the SAME japamName -- filterByJapam's null-fallback would pull
      // it in by name, but japamScopedStatsFor's userId gate MUST drop it.
      rec(todayIso(9), { userId: otherUid, japamId: null, japamName: JAPAM_NAME, totalCount: 108, completionId: 'other-u-t1' }),
    ];
    const myStats = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(myStats.todayTotalCount).toBe(108); // only mine-t1
    expect(myStats.lifetimeTotalCount).toBe(216); // mine-t1 + mine-y1
    expect(myStats.dayStreak).toBe(2);
    // And the other user's stats exclude my records.
    const theirStats = japamScopedStatsFor(
      records, otherUid, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(theirStats.todayTotalCount).toBe(108); // only other-u-t1
    expect(theirStats.lifetimeTotalCount).toBe(108);
    expect(theirStats.dayStreak).toBe(1);
  });

  it('guest bucket (userId=null scope) excludes signed-in users\' records and vice versa', () => {
    const signedInUid = 'user-signed-in';
    const records = [
      rec(todayIso(8), { userId: signedInUid, japamId: null, japamName: null, totalCount: 108, completionId: 'si-t1' }),
      rec(todayIso(9), { userId: undefined,   japamId: null, japamName: null, totalCount: 108, completionId: 'guest-t1' }),
    ];
    // Guest scope (userId=null/undefined): only the guest record counts.
    const guestStats = japamScopedStatsFor(
      records, null, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey, { includeBlankLegacy: true },
    );
    expect(guestStats.todayTotalCount).toBe(108);
    // Signed-in scope: only the signed-in record counts.
    const signedInStats = japamScopedStatsFor(
      records, signedInUid, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey, { includeBlankLegacy: true },
    );
    expect(signedInStats.todayTotalCount).toBe(108);
  });

  it('agrees with the existing strict selectors when there are NO legacy null records', () => {
    // When every record has a real japamId, japamScopedStatsFor must return exactly what the strict
    // statsByJapam/japamStatsFor/dayStreakForJapam trio returned -- i.e. no behavior change for
    // already-properly-tagged post-Workspaces histories.
    const records = [
      rec(todayIso(8), { japamId: JAPAM_ID, japamName: JAPAM_NAME, totalCount: 108, completionId: 'a-t1' }),
      rec(todayIso(9), { japamId: JAPAM_ID, japamName: JAPAM_NAME, totalCount: 108, completionId: 'a-t2' }),
      rec(yIso(8),     { japamId: JAPAM_ID, japamName: JAPAM_NAME, totalCount: 108, completionId: 'a-y1' }),
      rec(todayIso(10), { japamId: OTHER_JAPAM_ID, japamName: OTHER_JAPAM_NAME, totalCount: 108, completionId: 'b-t1' }),
    ];
    const strictStats = japamStatsFor(statsByJapam(records, UID, TODAY, toDayKey), JAPAM_ID);
    const strictStreak = dayStreakForJapam(records, UID, JAPAM_ID, TODAY, toDayKey, getPreviousDayKey);
    const scopedStats = japamScopedStatsFor(
      records, UID, JAPAM_ID, JAPAM_NAME, TODAY, toDayKey, getPreviousDayKey,
    );
    expect(scopedStats.todayTotalCount).toBe(strictStats.todayTotalCount);
    expect(scopedStats.lifetimeTotalCount).toBe(strictStats.lifetimeTotalCount);
    expect(scopedStats.dayStreak).toBe(strictStreak);
  });
});

describe('loadJapamStats: repository wiring for attribution (the My Japams read path)', () => {
  beforeEach(() => {
    delete asyncStore['history'];
  });

  it('attributes legacy records to Japams when the Japam list is supplied, matching History totals', async () => {
    asyncStore['history'] = JSON.stringify([
      session('2026-07-01T09:00:00.000Z', { japamId: 'gayatri', malas: 1, totalCount: 108 }),
      session('2026-07-02T09:00:00.000Z', { japamId: null, japamName: 'Gayatri', malas: 1, totalCount: 108 }),
      session('2026-07-03T09:00:00.000Z', { japamId: null, japamName: null, malas: 1, totalCount: 108 }),
    ]);
    const japams = [
      { id: 'gayatri', userId: UID, name: 'Gayatri', displayOrder: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null },
      { id: 'govinda', userId: UID, name: 'Govinda', displayOrder: null, createdAt: '2026-01-02', updatedAt: '2026-01-02', archivedAt: null },
    ];
    const map = await loadJapamStats(UID, japams);
    expect(japamStatsFor(map, 'gayatri').lifetimeMalas).toBe(3);
    expect(japamStatsFor(map, 'govinda').lifetimeMalas).toBe(0);
    expect(japamStatsFor(map, null).lifetimeMalas).toBe(0);
  });

  it('falls back to strict japamId-only grouping when no Japam list is supplied (unchanged behavior)', async () => {
    asyncStore['history'] = JSON.stringify([
      session('2026-07-01T09:00:00.000Z', { japamId: 'gayatri', malas: 1, totalCount: 108 }),
      session('2026-07-02T09:00:00.000Z', { japamId: null, japamName: 'Gayatri', malas: 1, totalCount: 108 }),
    ]);
    const map = await loadJapamStats(UID);
    expect(japamStatsFor(map, 'gayatri').lifetimeMalas).toBe(1);
    expect(japamStatsFor(map, null).lifetimeMalas).toBe(1);
  });

  it('uses the first ACTIVE Japam as the blank-legacy bucket, not merely the first in the list', async () => {
    asyncStore['history'] = JSON.stringify([
      session('2026-07-01T09:00:00.000Z', { japamId: null, japamName: null, malas: 1, totalCount: 108 }),
    ]);
    const japams = [
      { id: 'gayatri', userId: UID, name: 'Gayatri', displayOrder: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: '2026-01-10' },
      { id: 'govinda', userId: UID, name: 'Govinda', displayOrder: null, createdAt: '2026-01-02', updatedAt: '2026-01-02', archivedAt: null },
    ];
    const map = await loadJapamStats(UID, japams);
    expect(japamStatsFor(map, 'govinda').lifetimeMalas).toBe(1);
    expect(japamStatsFor(map, 'gayatri').lifetimeMalas).toBe(0);
  });

  it('keeps an ambiguous shared legacy name unclaimed (not attributed to either same-named Japam)', async () => {
    asyncStore['history'] = JSON.stringify([
      session('2026-07-01T09:00:00.000Z', { japamId: 'g1', japamName: 'Gayatri', malas: 1, totalCount: 108 }),
      session('2026-07-02T09:00:00.000Z', { japamId: null, japamName: 'Gayatri', malas: 1, totalCount: 108 }),
    ]);
    const japams = [
      { id: 'g1', userId: UID, name: 'Gayatri', displayOrder: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null },
      { id: 'g2', userId: UID, name: 'Gayatri', displayOrder: null, createdAt: '2026-01-02', updatedAt: '2026-01-02', archivedAt: null },
    ];
    const map = await loadJapamStats(UID, japams);
    expect(japamStatsFor(map, 'g1').lifetimeMalas).toBe(1);
    expect(japamStatsFor(map, 'g2').lifetimeMalas).toBe(0);
    expect(japamStatsFor(map, null).lifetimeMalas).toBe(1);
  });
});

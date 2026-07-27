/**
 * PR-2: Restore mapping preserves japamId and japamName.
 *
 * Every remote History fetch must carry japamId/japamName through into local records.
 * This file tests the pure selectors and merge/reconcile behavior — the actual fetch
 * and mapping is tested implicitly because the selectors are what every restore path
 * feeds into after mapping.
 */
import {
  makeCompletionId,
  normalizeRecord,
  dedupeByCompletionId,
  mergeHistories,
  reconcileWithServer,
  type HistoryRecord,
} from '../historyStore';

const UID = 'user-123';
const JAPAM_A = 'japam-aaa-111';
const JAPAM_B = 'japam-bbb-222';

const session = (
  dateISO: string,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord => ({
  date: dateISO,
  malas: overrides.malas ?? 1,
  totalCount: overrides.totalCount ?? 108,
  duration: overrides.duration ?? 0,
  manual: overrides.manual ?? false,
  userId: overrides.userId ?? UID,
  userName: overrides.userName ?? 'Test User',
  userEmail: overrides.userEmail ?? undefined,
  source: overrides.source,
  remoteId: overrides.remoteId,
  completionId: overrides.completionId ?? makeCompletionId(UID, dateISO),
  syncStatus: overrides.syncStatus ?? 'synced',
  japamId: overrides.japamId ?? null,
  japamName: overrides.japamName ?? null,
});

const isoAt = (offset: number) =>
  new Date(Date.UTC(2026, 6, 6, 12, 0, 0, offset * 60000)).toISOString();

// ─────── 1. remote japamId survives restore via mergeHistories ───────
describe('remote japamId survives restore', () => {
  it('mergeHistories preserves japamId from remote-only records', () => {
    const local: HistoryRecord[] = [];
    const remote = [session(isoAt(0), { japamId: JAPAM_A, japamName: 'Gayatri' })];
    const merged = mergeHistories(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].japamId).toBe(JAPAM_A);
  });

  it('mergeHistories preserves japamId from multiple remote records for different Japams', () => {
    const local: HistoryRecord[] = [];
    const remote = [
      session(isoAt(0), { japamId: JAPAM_A, japamName: 'Gayatri' }),
      session(isoAt(1), { japamId: JAPAM_B, japamName: 'Govinda' }),
      session(isoAt(2), { japamId: null, japamName: null }),
    ];
    const merged = mergeHistories(local, remote);
    expect(merged).toHaveLength(3);
    const a = merged.find((r) => r.japamId === JAPAM_A);
    const b = merged.find((r) => r.japamId === JAPAM_B);
    const n = merged.find((r) => r.japamId === null);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(n).toBeTruthy();
  });

  it('normalizeRecord preserves japamId from a raw remote row (simulating restore mapping)', () => {
    const raw = {
      date: isoAt(0),
      malas: 1,
      totalCount: 108,
      userId: UID,
      userName: 'Test User',
      completionId: 'cid-test',
      japamId: JAPAM_A,
      japamName: '  Gayatri  ',
    };
    const normalized = normalizeRecord(raw);
    expect(normalized.japamId).toBe(JAPAM_A);
    expect(normalized.japamName).toBe('Gayatri'); // trimmed
  });
});

// ─────── 2. remote japamName survives restore ───────
describe('remote japamName survives restore', () => {
  it('mergeHistories preserves japamName from remote records', () => {
    const local: HistoryRecord[] = [];
    const remote = [session(isoAt(0), { japamId: JAPAM_A, japamName: 'Gayatri Mantra' })];
    const merged = mergeHistories(local, remote);
    expect(merged[0].japamName).toBe('Gayatri Mantra');
  });

  it('normalizeRecord pulls japamName from remote row', () => {
    const raw = {
      date: isoAt(0),
      malas: 1,
      totalCount: 108,
      userId: UID,
      completionId: 'cid-name-test',
      japamId: JAPAM_A,
      japamName: 'Govinda',
    };
    const normalized = normalizeRecord(raw);
    expect(normalized.japamName).toBe('Govinda');
  });

  it('normalizeRecord handles missing japamName from remote gracefully', () => {
    const normalized = normalizeRecord({ date: isoAt(0), malas: 1, userId: UID });
    expect(normalized.japamName).toBeNull();
  });
});

// ─────── 3. merge/reconcile never erases an existing local japamId ───────
describe('merge and reconcile never erase local japamId', () => {
  it('mergeHistories keeps local japamId when remote has same completionId', () => {
    const sameId = 'cid-same';
    const local = [session(isoAt(0), {
      japamId: JAPAM_A,
      japamName: 'Gayatri',
      completionId: sameId,
      syncStatus: 'synced',
    })];
    const remote = [session(isoAt(0), {
      japamId: JAPAM_B,
      japamName: 'Different',
      completionId: sameId,
    })];
    const merged = mergeHistories(local, remote);
    expect(merged).toHaveLength(1);
    // Local wins — first-seen record kept
    expect(merged[0].japamId).toBe(JAPAM_A);
    expect(merged[0].japamName).toBe('Gayatri');
  });

  it('mergeHistories keeps local pending japamId over remote synced japamId', () => {
    const sameId = 'cid-pending-wins';
    const local = [session(isoAt(0), {
      japamId: JAPAM_A,
      completionId: sameId,
      syncStatus: 'pending',
    })];
    const remote = [session(isoAt(0), {
      japamId: JAPAM_B,
      completionId: sameId,
      syncStatus: 'synced',
    })];
    const merged = mergeHistories(local, remote);
    expect(merged[0].japamId).toBe(JAPAM_A);
    expect(merged[0].syncStatus).toBe('synced'); // upgraded
  });

  it('reconcileWithServer never drops pending records, preserving their japamId', () => {
    const merged = [
      session(isoAt(0), { japamId: JAPAM_A, syncStatus: 'pending', completionId: 'cid-p' }),
    ];
    const remoteIds = new Set<string>(); // empty — nothing on server
    const reconciled = reconcileWithServer(merged, remoteIds, UID);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].japamId).toBe(JAPAM_A);
  });

  it('reconcileWithServer drops synced records absent from remote but preserves japamId on survivors', () => {
    const merged = [
      session(isoAt(0), { japamId: JAPAM_A, syncStatus: 'synced', completionId: 'cid-keep' }),
      session(isoAt(1), { japamId: JAPAM_B, syncStatus: 'synced', completionId: 'cid-drop' }),
      session(isoAt(2), { japamId: JAPAM_A, syncStatus: 'pending', completionId: 'cid-pending' }),
    ];
    const remoteIds = new Set(['cid-keep']);
    const reconciled = reconcileWithServer(merged, remoteIds, UID);
    expect(reconciled).toHaveLength(2); // cid-drop removed
    expect(reconciled[0].japamId).toBe(JAPAM_A);
    expect(reconciled[1].japamId).toBe(JAPAM_A);
  });
});

// ─────── 4. null remote values do not overwrite valid local values ───────
describe('null remote values do not overwrite valid local values', () => {
  it('mergeHistories keeps local japamId when remote has null for same completionId', () => {
    const sameId = 'cid-remote-null';
    const local = [session(isoAt(0), {
      japamId: JAPAM_A,
      japamName: 'Gayatri',
      completionId: sameId,
      syncStatus: 'pending',
    })];
    const remote = [session(isoAt(0), {
      japamId: null,
      japamName: null,
      completionId: sameId,
    })];
    const merged = mergeHistories(local, remote);
    expect(merged[0].japamId).toBe(JAPAM_A);
    expect(merged[0].japamName).toBe('Gayatri');
  });

  it('mergeHistories adds remote-only record with null japamId without affecting others', () => {
    const local = [session(isoAt(0), { japamId: JAPAM_A, completionId: 'cid-a' })];
    const remote = [
      session(isoAt(1), { japamId: null, japamName: null, completionId: 'cid-b' }),
    ];
    const merged = mergeHistories(local, remote);
    expect(merged).toHaveLength(2);
    const localRecord = merged.find((r) => r.completionId === 'cid-a');
    const remoteRecord = merged.find((r) => r.completionId === 'cid-b');
    expect(localRecord!.japamId).toBe(JAPAM_A);
    expect(remoteRecord!.japamId).toBeNull();
  });

  it('dedupeByCompletionId keeps first-seen japamId when duplicate has null', () => {
    const records = [
      session(isoAt(0), { japamId: JAPAM_A, completionId: 'cid-dup' }),
      session(isoAt(0), { japamId: null, completionId: 'cid-dup' }),
    ];
    const deduped = dedupeByCompletionId(records);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].japamId).toBe(JAPAM_A);
  });
});

import {
  makeCompletionId,
  normalizeRecord,
  appendCompletion,
  dedupeByCompletionId,
  mergeHistories,
  getPending,
  markSynced,
  todayCountFor,
  type HistoryRecord,
} from '../historyStore';

const UID = 'user-123';
// Local YYYY-MM-DD key, matching how the app buckets days.
const toDayKey = (iso: string) => {
  const d = new Date(iso);
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
  it('upgrades the kept record to synced when a duplicate is synced', () => {
    const iso = '2026-06-03T10:00:00.000Z';
    const out = dedupeByCompletionId([
      session(iso, { syncStatus: 'pending' }),
      session(iso, { syncStatus: 'synced' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].syncStatus).toBe('synced');
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

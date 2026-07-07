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
  japamStatsFor,
  filterByJapam,
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
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' })]),
      new Set(), // remote has nothing
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
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'pending' })]),
      new Set(), // remote has nothing
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
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' })]),
      new Set(), // remote empty
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
    const result = reconcileWithServer(
      normalizeAll([session(iso, { syncStatus: 'synced' }), session(otherIso, { syncStatus: 'synced' })]),
      new Set(), // both absent remotely
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
    it('includes japam_id and the trimmed japam_name snapshot', () => {
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
    it('carries the same japamId through the full local-save-then-sync-payload pipeline', () => {
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
    it('treats undefined the same as null (legacy bucket)', () => {
      const history = [session(todayIso(9), { japamId: null, malas: 1, totalCount: 108 })];
      const statsMap = statsByJapam(history, UID, TODAY, toDayKey);
      expect(japamStatsFor(statsMap, undefined)).toEqual(japamStatsFor(statsMap, null));
    });
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
});

import {
  makeCompletionId,
  normalizeRecord,
  appendCompletion,
  dedupeByCompletionId,
  mergeHistories,
  getPending,
  markSynced,
  todayCountFor,
  todayStatsFor,
  buildSupabaseHistoryPayload,
  toLocalDayKey,
  selfHealSyncStatus,
  applyTombstones,
  mergeTombstones,
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

describe('self-heal sync: phantom-synced records re-upload (data consistency)', () => {
  const iso = '2026-06-06T18:51:49.300Z';
  const cid = makeCompletionId(UID, iso);

  it('1. re-marks a local synced record absent from remote back to pending', () => {
    const { records, markedPending } = selfHealSyncStatus(
      [session(iso, { syncStatus: 'synced' })],
      UID,
      new Set() // remote has nothing
    );
    expect(markedPending).toEqual([cid]);
    expect(records[0].syncStatus).toBe('pending');
  });

  it('2. the re-marked record is then picked up by getPending (so it WILL sync to Supabase)', () => {
    const { records } = selfHealSyncStatus([session(iso, { syncStatus: 'synced' })], UID, new Set());
    expect(getPending(records).map((r) => r.completionId)).toContain(cid);
  });

  it('3. leaves a synced record that IS present in remote as synced', () => {
    const { records, markedPending } = selfHealSyncStatus(
      [session(iso, { syncStatus: 'synced' })],
      UID,
      new Set([cid])
    );
    expect(markedPending).toEqual([]);
    expect(records[0].syncStatus).toBe('synced');
  });

  it('4. leaves an already-pending local record pending', () => {
    const { records, markedPending } = selfHealSyncStatus(
      [session(iso, { syncStatus: 'pending' })],
      UID,
      new Set()
    );
    expect(markedPending).toEqual([]);
    expect(records[0].syncStatus).toBe('pending');
  });

  it('5. does not modify another user\'s record, nor a guest (null userId) record', () => {
    const { records, markedPending } = selfHealSyncStatus(
      [
        session(iso, { userId: 'other-user', syncStatus: 'synced' }),
        session(iso, { userId: undefined, syncStatus: 'synced' }),
      ],
      UID,
      new Set() // remote empty for UID
    );
    expect(markedPending).toEqual([]);
    expect(records.find((r) => r.userId === 'other-user')?.syncStatus).toBe('synced');
    expect(records.find((r) => !r.userId)?.syncStatus).toBe('synced');
  });

  it('6. re-upload is idempotent: once remote has it, a second self-heal does not re-mark, and dedup keeps one row', () => {
    // 1st pass: missing remotely -> pending
    let { records } = selfHealSyncStatus([session(iso, { syncStatus: 'synced' })], UID, new Set());
    expect(records[0].syncStatus).toBe('pending');
    // simulate a successful re-upload (Supabase now has it via on_conflict upsert) + local mark
    records = markSynced(records, [cid]);
    const second = selfHealSyncStatus(records, UID, new Set([cid]));
    expect(second.markedPending).toEqual([]);
    expect(second.records[0].syncStatus).toBe('synced');
    // a re-uploaded completion never doubles: dedup by completion_id keeps exactly one
    expect(dedupeByCompletionId([...records, session(iso, { syncStatus: 'synced' })])).toHaveLength(1);
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

  it('2. tombstoned record does NOT resurrect — self-heal skips it', () => {
    // synced locally + absent remotely (deleted in Supabase) BUT tombstoned -> must NOT re-upload
    const { records, markedPending } = selfHealSyncStatus(
      [session(iso, { syncStatus: 'synced' })],
      UID,
      new Set(), // remote empty
      [cid] // tombstoned
    );
    expect(markedPending).toEqual([]);
    expect(records[0].syncStatus).toBe('synced'); // untouched (applyTombstones will drop it)
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

  it('5. self-heal does not re-upload tombstoned ids, but still heals legitimate ones', () => {
    const otherIso = '2026-06-06T21:00:00.000Z';
    const otherCid = makeCompletionId(UID, otherIso);
    const { markedPending } = selfHealSyncStatus(
      [session(iso, { syncStatus: 'synced' }), session(otherIso, { syncStatus: 'synced' })],
      UID,
      new Set(), // both absent remotely
      [cid] // only `cid` tombstoned
    );
    expect(markedPending).toContain(otherCid); // genuine synced-but-missing -> re-upload
    expect(markedPending).not.toContain(cid); // deleted -> stays gone
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

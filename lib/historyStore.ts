/**
 * Offline-first history store — pure, dependency-free helpers for recording, merging,
 * de-duplicating, and syncing japam completions.
 *
 * Design (see audit fixes #1 and #2):
 *  - Every completion has a STABLE completionId derived deterministically from
 *    (userId, completion timestamp). Because Supabase stores `created_at`, the same id is
 *    reconstructable from a remote row — so local↔remote dedup needs no schema change, and
 *    legacy records (saved before this module) backfill automatically on read.
 *  - Dedup is by completionId ONLY. The old 30-second time-window collapse is gone, so two
 *    legitimate malas completed close together are never merged.
 *  - Merge (never overwrite): remote restore unions with local by completionId and NEVER drops
 *    a local record. Unsynced (`pending`) local records survive sign-in/sign-out.
 *
 * These functions take and return plain arrays — all AsyncStorage / network I/O stays in the
 * callers, which keeps this module pure and unit-testable in plain Node.
 */

export type SyncStatus = 'pending' | 'synced';

export interface HistoryRecord {
  date: string; // ISO timestamp
  malas: number;
  totalCount: number;
  duration: number;
  manual: boolean;
  userId?: string;
  completionId: string;
  syncStatus: SyncStatus;
}

export type RawHistoryRecord = Partial<HistoryRecord> & { date: string };

/**
 * Deterministic, stable id for a completion. Reconstructable from a Supabase row's
 * (user_id, created_at), so the same physical completion yields the same id locally and remotely.
 */
export const makeCompletionId = (userId: string | undefined | null, dateISO: string): string => {
  const t = new Date(dateISO).getTime();
  const stamp = Number.isNaN(t) ? String(dateISO) : String(t);
  return `${userId || 'guest'}:${stamp}`;
};

/**
 * Ensure a raw/legacy/remote record has a completionId and a syncStatus.
 * - completionId: kept if present, else derived deterministically (backfills legacy rows).
 * - syncStatus: kept if present; otherwise legacy/remote rows default to 'synced' and guest
 *   (no userId) records are 'synced' (local-only — nothing to upload).
 */
export const normalizeRecord = (raw: RawHistoryRecord): HistoryRecord => {
  const malas = Number(raw.malas) || 0;
  const totalCount = Number(raw.totalCount) || malas * 108;
  const userId = raw.userId;
  return {
    date: raw.date,
    malas,
    totalCount,
    duration: Number(raw.duration) || 0,
    manual: Boolean(raw.manual),
    userId,
    completionId: raw.completionId || makeCompletionId(userId, raw.date),
    syncStatus: raw.syncStatus === 'pending' ? 'pending' : 'synced',
  };
};

export const normalizeAll = (records: RawHistoryRecord[]): HistoryRecord[] =>
  (Array.isArray(records) ? records : []).map(normalizeRecord);

/**
 * Build a new local record for a freshly completed mala. Records owned by a signed-in user start
 * as 'pending' (awaiting upload); guest records are 'synced' (local-only, no remote target).
 */
export const appendCompletion = (
  history: RawHistoryRecord[],
  completion: {
    date: string;
    malas: number;
    totalCount: number;
    duration: number;
    manual?: boolean;
    userId?: string;
  }
): HistoryRecord[] => {
  const record: HistoryRecord = {
    date: completion.date,
    malas: Number(completion.malas) || 0,
    totalCount: Number(completion.totalCount) || 0,
    duration: Number(completion.duration) || 0,
    manual: Boolean(completion.manual),
    userId: completion.userId,
    completionId: makeCompletionId(completion.userId, completion.date),
    syncStatus: completion.userId ? 'pending' : 'synced',
  };
  return [record, ...normalizeAll(history)];
};

/**
 * Keep exactly one record per completionId. Distinct completions (distinct ids) are ALWAYS kept —
 * there is no time-window collapse. When the same id appears more than once (e.g. a local row and
 * its remote echo), the first is kept and upgraded to 'synced' if any duplicate is synced.
 * Input order is preserved.
 */
export const dedupeByCompletionId = (records: RawHistoryRecord[]): HistoryRecord[] => {
  const seen = new Map<string, number>(); // completionId -> index in result
  const result: HistoryRecord[] = [];
  for (const raw of normalizeAll(records)) {
    const idx = seen.get(raw.completionId);
    if (idx === undefined) {
      seen.set(raw.completionId, result.length);
      result.push(raw);
    } else if (raw.syncStatus === 'synced' && result[idx].syncStatus === 'pending') {
      // Upgrade the kept record's status if a duplicate confirms it synced.
      result[idx] = { ...result[idx], syncStatus: 'synced' };
    }
  }
  return result;
};

/**
 * Merge remote records into local WITHOUT data loss.
 * - Every local record is kept (pending or synced) — local is never dropped.
 * - A local record whose completionId also exists remotely is upgraded to 'synced'.
 * - Remote-only records are added (as 'synced').
 * Result is sorted newest-first to match the app's stored convention.
 */
export const mergeHistories = (
  local: RawHistoryRecord[],
  remote: RawHistoryRecord[]
): HistoryRecord[] => {
  const localNorm = normalizeAll(local);
  const remoteIds = new Set(normalizeAll(remote).map((r) => r.completionId));

  const byId = new Map<string, HistoryRecord>();
  for (const rec of localNorm) {
    const upgraded =
      remoteIds.has(rec.completionId) && rec.syncStatus === 'pending'
        ? { ...rec, syncStatus: 'synced' as const }
        : rec;
    // First local wins for a given id; never overwrite a local record with a remote one.
    if (!byId.has(rec.completionId)) byId.set(rec.completionId, upgraded);
  }
  for (const rec of normalizeAll(remote)) {
    if (!byId.has(rec.completionId)) byId.set(rec.completionId, rec);
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
};

/** Records that still need uploading: pending AND owned by a signed-in user. */
export const getPending = (records: RawHistoryRecord[]): HistoryRecord[] =>
  normalizeAll(records).filter((r) => r.syncStatus === 'pending' && Boolean(r.userId));

/** Flip the given completionIds to 'synced'. Idempotent — re-marking a synced record is a no-op. */
export const markSynced = (
  records: RawHistoryRecord[],
  completionIds: Iterable<string>
): HistoryRecord[] => {
  const ids = new Set(completionIds);
  return normalizeAll(records).map((r) =>
    ids.has(r.completionId) && r.syncStatus === 'pending' ? { ...r, syncStatus: 'synced' } : r
  );
};

/** Sum of today's totalCount for a user (or guest), over de-duplicated records. */
export const todayCountFor = (
  records: RawHistoryRecord[],
  userId: string | null | undefined,
  todayKey: string,
  toDayKey: (dateISO: string) => string
): number => {
  return dedupeByCompletionId(records)
    .filter((r) => {
      const matchesUser = userId ? r.userId === userId : !r.userId;
      return matchesUser && toDayKey(r.date) === todayKey && r.totalCount > 0;
    })
    .reduce((sum, r) => sum + r.totalCount, 0);
};

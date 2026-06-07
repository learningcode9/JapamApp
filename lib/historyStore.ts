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
  userName?: string;
  userEmail?: string;
  source?: string;
  completionId: string;
  syncStatus: SyncStatus;
}

export type SupabaseHistoryPayload = {
  user_id: string;
  user_name: string;
  malas: number;
  count: number;
  created_at: string;
  completion_id: string;
};

/**
 * Shared local-day bucket helper. It intentionally uses the device timezone for ISO timestamps,
 * because "today/yesterday" in the app should follow the user's local day, not UTC midnight.
 */
export const toLocalDayKey = (rawDate?: string | null): string => {
  if (!rawDate) return 'unknown';
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;

  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return 'unknown';

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export type RawHistoryRecord = Partial<HistoryRecord> & {
  date: string;
  user_name?: string;
  user_email?: string;
};

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
  const userName = raw.userName || raw.user_name || undefined;
  const userEmail = raw.userEmail || raw.user_email || undefined;
  return {
    date: raw.date,
    malas,
    totalCount,
    duration: Number(raw.duration) || 0,
    manual: Boolean(raw.manual),
    userId,
    userName,
    userEmail,
    source: raw.source,
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
    userName?: string;
    userEmail?: string;
    source?: string;
  }
): HistoryRecord[] => {
  const record: HistoryRecord = {
    date: completion.date,
    malas: Number(completion.malas) || 0,
    totalCount: Number(completion.totalCount) || 0,
    duration: Number(completion.duration) || 0,
    manual: Boolean(completion.manual),
    userId: completion.userId,
    userName: completion.userName,
    userEmail: completion.userEmail,
    source: completion.source,
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
      result[idx] = {
        ...result[idx],
        userName: result[idx].userName || raw.userName,
        userEmail: result[idx].userEmail || raw.userEmail,
        syncStatus: 'synced',
      };
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

/**
 * Build the Supabase row from the local record. The important bit is `created_at: record.date`:
 * offline completions must upload with their actual completion time, not the later sync time.
 */
export const buildSupabaseHistoryPayload = (
  record: RawHistoryRecord,
  fallbackUserId?: string | null,
  fallbackUserName = 'Unknown User'
): SupabaseHistoryPayload => {
  const normalized = normalizeRecord(record);
  const userId = normalized.userId || fallbackUserId || '';
  const userName = normalized.userName || normalized.userEmail || fallbackUserName || 'Unknown User';

  return {
    user_id: userId,
    user_name: userName,
    malas: normalized.malas,
    count: normalized.totalCount,
    created_at: normalized.date,
    completion_id: normalized.completionId,
  };
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

/**
 * Single source of truth for a screen's displayed "today" stat. Every screen (Timer, History,
 * Main/Tap) should derive Malas Today / Total from THIS over the merged local history, so the
 * numbers always match and update immediately offline (no dependency on Supabase).
 */
export const todayStatsFor = (
  records: RawHistoryRecord[],
  userId: string | null | undefined,
  todayKey: string,
  toDayKey: (dateISO: string) => string
): { malas: number; totalCount: number } => {
  const totalCount = todayCountFor(records, userId, todayKey, toDayKey);
  return { malas: Math.floor(totalCount / 108), totalCount };
};

/**
 * Self-heal "phantom synced" records. After a FULL remote fetch for `userId`, any local record
 * owned by that user that is marked 'synced' but whose completionId is NOT present remotely must
 * have failed to persist (or was removed) — re-mark it 'pending' so the normal sync re-uploads it.
 * The idempotent upsert (on_conflict=completion_id) means a re-upload never creates a duplicate.
 *
 * Safety: only this user's records are touched; other users, guest (no userId) records, and
 * already-pending records are left exactly as-is, and no record is ever dropped. Pass the COMPLETE
 * remote completionId set — a partial set would re-mark real synced rows pending, but that is still
 * harmless (idempotent re-upload).
 */
export const selfHealSyncStatus = (
  records: RawHistoryRecord[],
  userId: string | null | undefined,
  remoteCompletionIds: Iterable<string>
): { records: HistoryRecord[]; markedPending: string[] } => {
  const remoteIds =
    remoteCompletionIds instanceof Set
      ? remoteCompletionIds
      : new Set<string>(remoteCompletionIds);
  const markedPending: string[] = [];
  const result = normalizeAll(records).map((r) => {
    if (
      userId &&
      r.userId === userId &&
      r.syncStatus === 'synced' &&
      !remoteIds.has(r.completionId)
    ) {
      markedPending.push(r.completionId);
      return { ...r, syncStatus: 'pending' as const };
    }
    return r;
  });
  return { records: result, markedPending };
};

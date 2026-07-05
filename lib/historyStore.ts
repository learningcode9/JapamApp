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
  userId?: string | null;
  userName?: string;
  userEmail?: string;
  source?: string;
  remoteId?: number | string;
  completionId: string;
  syncStatus: SyncStatus;
  /** Plain-text name the user typed for this one completion (e.g. "Gayatri"). Never an id. */
  japamName?: string | null;
}

export type SupabaseHistoryPayload = {
  user_id: string;
  user_name: string;
  malas: number;
  count: number;
  created_at: string;
  completion_id: string;
  japam_name: string | null;
};

/**
 * Single shared normalizer for the per-completion japam name — every read/write path must call
 * this instead of re-implementing trim/blank handling (see the day+name History grouping and
 * planHistoryDayAdjustment's edit scoping, which both depend on this producing identical output
 * for identical input).
 */
export const normalizeJapamName = (raw?: string | null): string | null => {
  const trimmed = (raw || '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

export type HistoryRecordUpdate = {
  before: HistoryRecord;
  after: HistoryRecord;
};

export type HistoryDayAdjustmentPlan = {
  changed: boolean;
  deleteEntireDay: boolean;
  currentMalas: number;
  targetMalas: number;
  updatedRecords: HistoryRecord[];
  recordsToUpdate: HistoryRecordUpdate[];
  recordsToDelete: HistoryRecord[];
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
  remote_id?: number | string;
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
 * Deterministic id for one loop of one timer session — same (userId, sessionId, loopNumber)
 * always yields the same id, regardless of how many times or how late it's computed. Used so a
 * loop re-claimed after a process restart (native/JS in-memory "already saved" guards reset on
 * restart, but sessionId and loopNumber don't) collapses onto the same record instead of a
 * duplicate one keyed by wall-clock save time. See docs/BUGFIX_DUPLICATE_COMPLETION_ID.md.
 */
export const makeLoopCompletionId = (
  userId: string | undefined | null,
  sessionId: string,
  loopNumber: number
): string => `${userId || 'guest'}:${sessionId}:loop-${loopNumber}`;

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
    remoteId: raw.remoteId ?? raw.remote_id,
    completionId: raw.completionId || makeCompletionId(userId, raw.date),
    syncStatus: raw.syncStatus === 'pending' ? 'pending' : 'synced',
    japamName: normalizeJapamName(raw.japamName),
  };
};

export const normalizeAll = (records: RawHistoryRecord[]): HistoryRecord[] =>
  (Array.isArray(records) ? records : []).map(normalizeRecord);

/**
 * Build a new local record for a freshly completed mala. Records owned by a signed-in user start
 * as 'pending' (awaiting upload); guest records are 'synced' (local-only, no remote target).
 *
 * completionId: uses the caller-supplied value if given (e.g. the timer's deterministic
 * (sessionId, loopNumber)-based id — see makeLoopCompletionId), else falls back to the
 * date-based makeCompletionId (unchanged behavior for Tap Japam / Add Japam, which have no
 * session/loop concept).
 *
 * Guard: if a record with the resulting completionId already exists in history, this is by
 * construction the same real completion being saved again (see the collision-freedom proof in
 * docs/BUGFIX_DUPLICATE_COMPLETION_ID.md) — skip appending a second local row rather than
 * duplicating it. A caller-supplied completionId always wins this check even when a fallback
 * date-based id would differ, since it's the more precise identity.
 */
export const appendCompletion = (
  history: RawHistoryRecord[],
  completion: {
    date: string;
    malas: number;
    totalCount: number;
    duration: number;
    manual?: boolean;
    userId?: string | null;
    userName?: string;
    userEmail?: string;
    source?: string;
    completionId?: string;
    japamName?: string | null;
  }
): HistoryRecord[] => {
  const completionId = completion.completionId || makeCompletionId(completion.userId, completion.date);
  const normalized = normalizeAll(history);
  if (normalized.some((r) => r.completionId === completionId)) {
    return normalized;
  }
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
    completionId,
    syncStatus: completion.userId ? 'pending' : 'synced',
    japamName: normalizeJapamName(completion.japamName),
  };
  return [record, ...normalized];
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
        remoteId: result[idx].remoteId ?? raw.remoteId,
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
  const remoteNorm = normalizeAll(remote);
  const remoteById = new Map(remoteNorm.map((r) => [r.completionId, r]));

  const byId = new Map<string, HistoryRecord>();
  for (const rec of localNorm) {
    const remoteMatch = remoteById.get(rec.completionId);
    // An edited record deliberately keeps its completionId and becomes pending again. A stale
    // remote copy with that same id must not mark the edit synced until its values match.
    const remoteConfirmsLocal =
      remoteMatch &&
      remoteMatch.malas === rec.malas &&
      remoteMatch.totalCount === rec.totalCount &&
      remoteMatch.date === rec.date;
    const upgraded =
      remoteConfirmsLocal && rec.syncStatus === 'pending'
        ? {
            ...rec,
            remoteId: rec.remoteId ?? remoteMatch.remoteId,
            syncStatus: 'synced' as const,
          }
        : rec;
    // First local wins for a given id; never overwrite a local record with a remote one.
    if (!byId.has(rec.completionId)) byId.set(rec.completionId, upgraded);
  }
  for (const rec of remoteNorm) {
    if (!byId.has(rec.completionId)) byId.set(rec.completionId, rec);
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
};

/**
 * Plan a correction to one visible daily aggregate without exposing or replacing its underlying
 * completion records. Reductions consume the newest records first so the oldest chronology stays
 * intact. Increases update the earliest record as the stable canonical record for that day.
 *
 * `japamName` scopes the plan to one History row's japam group (day + normalized name), so
 * editing/deleting one japam on a multi-japam day never touches another japam's records. It is
 * optional and omitting it (`undefined`) preserves the pre-multi-japam behavior of matching every
 * record for the day regardless of name — existing callers that haven't been updated yet keep
 * working unchanged. Pass the row's raw name (or `null` for the "Japam" group) once the caller
 * groups by day+japam.
 */
export const planHistoryDayAdjustment = (
  records: RawHistoryRecord[],
  userId: string | null | undefined,
  localDayKey: string,
  requestedTargetMalas: number,
  japamName?: string | null,
): HistoryDayAdjustmentPlan => {
  const normalized = dedupeByCompletionId(records);
  const matchesUser = (record: HistoryRecord) =>
    userId ? record.userId === userId : !record.userId;
  const targetJapamName = japamName === undefined ? undefined : normalizeJapamName(japamName);
  const matchesJapam = (record: HistoryRecord) =>
    targetJapamName === undefined || normalizeJapamName(record.japamName) === targetJapamName;
  const dayRecords = normalized
    .filter((record) => matchesUser(record) && matchesJapam(record) && toLocalDayKey(record.date) === localDayKey)
    .map((record) => ({
      ...record,
      malas: Math.max(0, Math.floor(Number(record.malas) || 0)),
      totalCount: Math.max(0, Math.floor(Number(record.malas) || 0)) * 108,
    }))
    .filter((record) => record.malas > 0)
    .sort((a, b) => {
      const dateDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      return dateDiff || a.completionId.localeCompare(b.completionId);
    });

  const currentMalas = dayRecords.reduce((sum, record) => sum + record.malas, 0);
  const targetMalas = Math.max(0, Math.floor(Number(requestedTargetMalas) || 0));
  const unchangedPlan: HistoryDayAdjustmentPlan = {
    changed: false,
    deleteEntireDay: false,
    currentMalas,
    targetMalas,
    updatedRecords: normalized,
    recordsToUpdate: [],
    recordsToDelete: [],
  };

  if (dayRecords.length === 0 || targetMalas === currentMalas) return unchangedPlan;

  const updates = new Map<string, HistoryRecordUpdate>();
  const deletions = new Map<string, HistoryRecord>();
  const pendingStatusFor = (record: HistoryRecord): SyncStatus =>
    record.userId ? 'pending' : record.syncStatus;

  if (targetMalas < currentMalas) {
    let remainingReduction = currentMalas - targetMalas;
    // Newest first: preserve the earliest records and their completion ids for as long as possible.
    for (let index = dayRecords.length - 1; index >= 0 && remainingReduction > 0; index -= 1) {
      const before = dayRecords[index];
      const removedMalas = Math.min(before.malas, remainingReduction);
      const nextMalas = before.malas - removedMalas;
      remainingReduction -= removedMalas;

      if (nextMalas === 0) {
        deletions.set(before.completionId, before);
      } else {
        updates.set(before.completionId, {
          before,
          after: {
            ...before,
            malas: nextMalas,
            totalCount: nextMalas * 108,
            syncStatus: pendingStatusFor(before),
          },
        });
      }
    }
  } else {
    const before = dayRecords[0];
    const nextMalas = before.malas + (targetMalas - currentMalas);
    updates.set(before.completionId, {
      before,
      after: {
        ...before,
        malas: nextMalas,
        totalCount: nextMalas * 108,
        syncStatus: pendingStatusFor(before),
      },
    });
  }

  const updatedRecords = normalized
    .filter((record) => !deletions.has(record.completionId))
    .map((record) => updates.get(record.completionId)?.after || record);

  return {
    changed: true,
    // Only "the entire day" when unscoped by japam — a scoped plan hitting zero only zeroes that
    // japam's slice of the day, leaving other japams' records for the same day untouched.
    deleteEntireDay: targetMalas === 0 && targetJapamName === undefined,
    currentMalas,
    targetMalas,
    updatedRecords,
    recordsToUpdate: [...updates.values()],
    recordsToDelete: [...deletions.values()],
  };
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
 * Remove local synced records for the current user if they are absent from the server.
 * Only drops records that are ALL of: this user's, syncStatus==='synced', have a completionId,
 * and whose completionId is not in remoteCompletionIds.
 * Always keeps: pending/offline records, guest records, other-user records, id-less records.
 * Only call after a confirmed HTTP 200 from a complete (limit=10000) Supabase fetch.
 */
export const reconcileWithServer = (
  merged: HistoryRecord[],
  remoteCompletionIds: Set<string>,
  currentUserId: string,
): HistoryRecord[] =>
  merged.filter((r) => {
    if (r.userId !== currentUserId) return true;
    if (!r.completionId) return true;
    if (r.syncStatus !== 'synced') return true;
    return remoteCompletionIds.has(r.completionId);
  });

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
    japam_name: normalized.japamName ?? null,
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
 * Tombstone support — explicit deletions that propagate to every device and survive sync.
 *
 * A deletion is recorded as a tombstone (the deleted completionId), NOT inferred from "absent
 * remotely" (which would wrongly erase un-uploaded offline malas). Tombstones sync via the
 * `deleted_completions` table, so: self-heal skips them (no resurrection), restore removes the
 * matching local records, and other devices delete their local copy after pulling tombstones.
 */

/** Remove records whose completionId is tombstoned. Used on restore/delete to honor deletions. */
export const applyTombstones = (
  records: RawHistoryRecord[],
  tombstones: Iterable<string>
): HistoryRecord[] => {
  const t = tombstones instanceof Set ? tombstones : new Set<string>(tombstones);
  if (t.size === 0) return normalizeAll(records);
  return normalizeAll(records).filter((r) => !t.has(r.completionId));
};

/** Union of two tombstone id collections (local + remote), de-duplicated. */
export const mergeTombstones = (a: Iterable<string>, b: Iterable<string>): string[] => {
  const s = new Set<string>(a);
  for (const x of b) s.add(x);
  return [...s];
};

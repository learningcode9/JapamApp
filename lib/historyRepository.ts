/**
 * Repository layer for History reads — the ONLY place in the app that knows HOW history is
 * loaded. Today that's AsyncStorage only. When Supabase merge is added, it is added ENTIRELY
 * INSIDE this file (e.g. fetching and merging remote rows the same way individual screens used to
 * do it themselves, via lib/historyStore.ts's mergeHistories/reconcileWithServer) — every screen
 * calls these exact same function names with the exact same signatures either way and never needs
 * to change. This mirrors lib/japamsRepository.ts's role for Japams exactly, on purpose: same
 * layering, same reason for existing.
 *
 * Screens must never read AsyncStorage directly, never JSON.parse history themselves, and never
 * call lib/historyStore.ts's selectors (statsByJapam, filterByJapam, todayStatsFor, etc.) directly
 * — they ask this repository for the clean, already-computed value they need. This file is where
 * AsyncStorage reads, JSON parsing, and selector orchestration live; screens only render what it
 * returns. No UI decides which selector to call — that decision lives here, once.
 *
 * Reads only, with one deliberate exception: applyLegacyHistoryBackfill (below), which persists
 * the one-time legacy-history reassignment. Timer/Home/Tap/Manual/History's own save/edit/delete
 * write paths are NOT moved here and remain unchanged -- this repository does not become the
 * general write path for history just because one specific, self-contained write operation lives
 * here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, Platform } from 'react-native';
import {
  normalizeAll,
  statsByJapam,
  statsByJapamWithAttribution,
  japamStatsFor as japamStatsForSelector,
  filterByJapam,
  toLocalDayKey,
  applyTombstones,
  dedupeByCompletionId,
  mergeHistories,
  mergeTombstones,
  type HistoryRecord,
  type JapamAttributionInput,
  type RawHistoryRecord,
  type JapamStats,
} from './historyStore';
import {
  planLegacyHistoryBackfill,
  type LegacyHistoryBackfillOptions,
  type LegacyHistoryBackfillPlan,
} from './legacyHistoryBackfill';
import { activeJapams, type Japam } from './japams';

export type { JapamStats };
/** Re-exported so screens have one single import path for both loading and reading stats — they
 * never need to import lib/historyStore.ts directly for this. Pure, no I/O: safe to call as often
 * as needed on a map already returned by loadJapamStats. */
export const japamStatsFor = japamStatsForSelector;

const HISTORY_KEY = 'history';
const DELETED_COMPLETIONS_KEY = 'deletedCompletions';

type RemoteHydrationSnapshot = {
  history: HistoryRecord[];
  tombstones: string[];
  pagination?: RemoteHistoryPagination;
};

type RemoteHistoryCursor = {
  createdAt: string;
  completionId: string;
};

type RemoteHistoryPage = {
  records: HistoryRecord[];
  cursor: RemoteHistoryCursor | null;
  exhausted: boolean;
};

type RemoteHistoryPageSource = {
  userId: string;
  cursor: RemoteHistoryCursor | null;
  exhausted: boolean;
  buffered: HistoryRecord[];
};

type RemoteHistoryPagination = {
  pageSize: number;
  sourcePageSize: number;
  sources: RemoteHistoryPageSource[];
};

const paginationHasMore = (pagination?: RemoteHistoryPagination): boolean =>
  Boolean(pagination?.sources.some((source) => !source.exhausted || source.buffered.length > 0));

type RemoteHydrationApplyResult = {
  records: HistoryRecord[];
  hadLocalTombstones: boolean;
  historyChanged: boolean;
  tombstonesChanged: boolean;
};

export type HydratedHistoryResult = {
  records: HistoryRecord[];
  hydrationSucceeded: boolean;
  localRecordCount: number;
  hadLocalTombstones: boolean;
  scopedLocalTombstoneApplied: boolean;
  localStateAuthoritativelyChanged: boolean;
  hasMoreRemote: boolean;
};

export type HistoryPageResult = {
  records: HistoryRecord[];
  hasMoreRemote: boolean;
  pageLoaded: boolean;
};

export type HistoryDrainResult = {
  records: HistoryRecord[];
  complete: boolean;
  remoteUnavailable: boolean;
};

const DEFAULT_REMOTE_HISTORY_PAGE_SIZE = 50;

const hydratedHistoryInFlight = new Map<string, Promise<RemoteHydrationSnapshot | null>>();
const hydratedRemoteSnapshotCache = new Map<string, RemoteHydrationSnapshot>();
const hydratedScopedLocalBaselineCache = new Map<string, string>();
const historyPageInFlight = new Map<string, Promise<HistoryPageResult>>();

export const __resetHistoryHydrationState = () => {
  hydratedHistoryInFlight.clear();
  hydratedRemoteSnapshotCache.clear();
  hydratedScopedLocalBaselineCache.clear();
  historyPageInFlight.clear();
};

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Load and normalize ALL locally stored history (every user/guest mixed together). An internal
 * building block for the user-scoped reads below — screens should prefer those instead. */
export const loadHistory = async (): Promise<HistoryRecord[]> => {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return normalizeAll((Array.isArray(parsed) ? parsed : []) as RawHistoryRecord[]);
  } catch {
    return [];
  }
};

/** Load this user's (or guest's) own history records only. */
export const loadHistoryForUser = async (
  userId: string | null | undefined,
): Promise<HistoryRecord[]> => {
  const all = await loadHistory();
  return all.filter((r) => (userId ? r.userId === userId : !r.userId));
};

const loadDeletedCompletionTombstones = async (): Promise<string[]> => {
  try {
    const raw = await AsyncStorage.getItem(DELETED_COMPLETIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map((id) => String(id)).filter((id) => id.length > 0) : [];
  } catch {
    return [];
  }
};

const getHydrationCacheKey = (
  userId: string,
  legacyUserId?: string | null,
  remotePageSize?: number,
) => `${userId}|${legacyUserId ?? ''}|${remotePageSize ? `page:${remotePageSize}` : 'full'}`;

const canonicalizeUserHistory = (records: HistoryRecord[], userId: string): HistoryRecord[] =>
  records.map((record) => ({ ...record, userId }));

const scopedHistorySignature = (records: HistoryRecord[], scopedLocalTombstoneApplied: boolean): string => JSON.stringify({
  applied: scopedLocalTombstoneApplied,
  records: records.map((record) => ({
    completionId: record.completionId,
    date: record.date,
    malas: record.malas,
    totalCount: record.totalCount,
    japamId: record.japamId ?? null,
  })),
});

const authoritativeScopedHistorySignature = (records: HistoryRecord[], scopedLocalTombstoneApplied: boolean): string =>
  scopedHistorySignature(
    records.filter((record) => record.syncStatus !== 'pending'),
    scopedLocalTombstoneApplied,
  );

const replaceScopedHistory = (
  allHistory: HistoryRecord[],
  scopedHistory: HistoryRecord[],
  matchesUser: (record: HistoryRecord) => boolean,
): HistoryRecord[] => {
  const replacement = scopedHistory.slice();
  const result: HistoryRecord[] = [];
  let inserted = false;

  for (const record of allHistory) {
    if (matchesUser(record)) {
      if (!inserted) {
        result.push(...replacement);
        inserted = true;
      }
      continue;
    }
    result.push(record);
  }

  if (!inserted) result.push(...replacement);
  return result;
};

const fetchRemoteHistoryPage = async (
  userId: string,
  limit?: number,
  cursor: RemoteHistoryCursor | null = null,
): Promise<RemoteHistoryPage | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchJapamHistoryRows } = require('./supabaseRestHelper') as typeof import('./supabaseRestHelper');
    const select = 'id,created_at,malas,count,user_name,completion_id,japam_id,japam_name';
    const rows = await fetchJapamHistoryRows({
      select,
      userId,
      order: { column: 'created_at', ascending: false },
      secondaryOrder: { column: 'completion_id', ascending: false },
      before: cursor ?? undefined,
      ...(limit ? { limit } : {}),
    });
    if (rows === null) return null;
    const typedRows = rows as RemoteLegacyHistoryRow[];
    const records = typedRows.map((row) => remoteRowToHistoryRecord(row, userId));
    const lastRow = typedRows[typedRows.length - 1];
    const lastRecord = records[records.length - 1];
    const nextCursor = lastRow && lastRecord
      ? { createdAt: lastRow.created_at || lastRecord.date, completionId: lastRow.completion_id || lastRecord.completionId }
      : null;
    return {
      records,
      cursor: nextCursor,
      exhausted: limit === undefined ? true : typedRows.length < limit,
    };
  } catch {
    return null;
  }
};

const fetchRemoteHistoryForUser = async (
  userId: string,
  legacyUserId?: string | null,
  pageSize?: number,
): Promise<{ history: HistoryRecord[]; pagination?: RemoteHistoryPagination } | null> => {
  const sourceUserIds = [userId, ...(legacyUserId && legacyUserId !== userId ? [legacyUserId] : [])];
  if (pageSize) {
    // A global top page cannot be proven from split per-identity quotas. Fetching one bounded
    // page from each stream is the minimum safe request shape, then keep the unconsumed rows as
    // buffers behind each stream's independent cursor for the next visible page.
    const sourcePageSize = pageSize;
    const pages = await Promise.all(
      sourceUserIds.map((sourceUserId) => fetchRemoteHistoryPage(sourceUserId, sourcePageSize)),
    );
    if (pages.some((page) => page === null)) return null;
    const resolvedPages = pages as RemoteHistoryPage[];
    const firstPage = mergeHistories([], resolvedPages.flatMap((page) => page.records)).slice(0, pageSize);
    const consumedIds = new Set(firstPage.map((record) => record.completionId));
    return {
      history: firstPage,
      pagination: {
        pageSize,
        sourcePageSize,
        sources: sourceUserIds.map((sourceUserId, index) => ({
          userId: sourceUserId,
          cursor: resolvedPages[index].cursor,
          exhausted: resolvedPages[index].exhausted,
          buffered: resolvedPages[index].records.filter((record) => !consumedIds.has(record.completionId)),
        })),
      },
    };
  }

  const pages = await Promise.all(sourceUserIds.map((sourceUserId) => fetchRemoteHistoryPage(sourceUserId)));
  if (pages.some((page) => page === null)) return null;
  return { history: (pages as RemoteHistoryPage[]).flatMap((page) => page.records) };
};

const fetchRemoteDeletedCompletions = async (
  userId: string,
  legacyUserId?: string | null,
): Promise<string[] | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase') as typeof import('./supabase');
    const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
    if (!sessionToken) return null;

    const fetchFor = async (uid: string): Promise<string[] | null> => {
      const { data, error } = await supabase
        .from('deleted_completions')
        .select('completion_id')
        .eq('user_id', uid);

      if (error || !data) return null;
      return (data as { completion_id?: unknown }[])
        .map((row) => String(row.completion_id))
        .filter((id) => id.length > 0);
    };

    const primary = await fetchFor(userId);
    if (primary === null) return null;
    if (!legacyUserId || legacyUserId === userId) {
      return primary;
    }
    const legacy = await fetchFor(legacyUserId);
    if (legacy === null) return null;
    return mergeTombstones(primary, legacy);
  } catch {
    return null;
  }
};

const fetchRemoteHydrationSnapshot = async (
  userId: string,
  legacyUserId?: string | null,
  force = false,
  remotePageSize?: number,
): Promise<RemoteHydrationSnapshot | null> => {
  const cacheKey = getHydrationCacheKey(userId, legacyUserId, remotePageSize);
  if (force) hydratedRemoteSnapshotCache.delete(cacheKey);
  if (!force) {
    const cached = hydratedRemoteSnapshotCache.get(cacheKey);
    if (cached) return cached;
  }

  const existing = hydratedHistoryInFlight.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    const remoteHistory = await fetchRemoteHistoryForUser(userId, legacyUserId, remotePageSize);
    const remoteTombstones = await fetchRemoteDeletedCompletions(userId, legacyUserId);
    if (remoteHistory === null || remoteTombstones === null) return null;

    const snapshot = {
      history: remoteHistory.history,
      tombstones: remoteTombstones,
      pagination: remoteHistory.pagination,
    };
    hydratedRemoteSnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  })();

  hydratedHistoryInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    hydratedHistoryInFlight.delete(cacheKey);
  }
};

const resolveLocalHydration = async (
  userId: string,
  legacyUserId: string | null | undefined,
  remotePageSize?: number,
): Promise<{
  allLocalHistory: HistoryRecord[];
  localTombstones: string[];
  localScoped: HistoryRecord[];
  localScopedRecords: HistoryRecord[];
  scopedLocalTombstoneApplied: boolean;
  cacheKey: string;
  localStateAuthoritativelyChanged: boolean;
}> => {
  const allLocalHistory = await loadHistory();
  const localTombstones = await loadDeletedCompletionTombstones();
  const matchesIdentity = (record: HistoryRecord) => (
    record.userId === userId || (legacyUserId != null && record.userId === legacyUserId)
  );
  const localScopedRaw = allLocalHistory.filter(matchesIdentity);
  const scopedCompletionIds = new Set(localScopedRaw.map((record) => record.completionId));
  const scopedLocalTombstones = localTombstones.filter((id) => scopedCompletionIds.has(id));
  const localScoped = applyTombstones(localScopedRaw, scopedLocalTombstones);
  const scopedLocalTombstoneApplied = scopedLocalTombstones.length > 0;
  const cacheKey = getHydrationCacheKey(userId, legacyUserId, remotePageSize);
  const localScopedRecords = canonicalizeUserHistory(dedupeByCompletionId(localScoped), userId);
  const currentScopedSignature = scopedHistorySignature(localScopedRecords, scopedLocalTombstoneApplied);
  const previousScopedSignature = hydratedScopedLocalBaselineCache.get(cacheKey);
  const localStateAuthoritativelyChanged = previousScopedSignature !== undefined
    ? previousScopedSignature !== currentScopedSignature
    : false;
  if (previousScopedSignature === undefined) {
    hydratedScopedLocalBaselineCache.set(cacheKey, authoritativeScopedHistorySignature(localScopedRecords, scopedLocalTombstoneApplied));
  }
  return {
    allLocalHistory,
    localTombstones,
    localScoped,
    localScopedRecords,
    scopedLocalTombstoneApplied,
    cacheKey,
    localStateAuthoritativelyChanged,
  };
};

const applyRemoteHydration = async (
  userId: string,
  legacyUserId: string | null | undefined,
  local: Awaited<ReturnType<typeof resolveLocalHydration>>,
  remoteSnapshot: RemoteHydrationSnapshot,
  allLocalHistory: HistoryRecord[],
  localTombstones: string[],
): Promise<RemoteHydrationApplyResult> => {
  const { localScoped, scopedLocalTombstoneApplied, cacheKey } = local;
  const matchesIdentity = (record: HistoryRecord) => (
    record.userId === userId || (legacyUserId != null && record.userId === legacyUserId)
  );
  const mergedTombstones = mergeTombstones(localTombstones, remoteSnapshot.tombstones);
  const mergedScoped = canonicalizeUserHistory(
    applyTombstones(
      mergeHistories(localScoped, remoteSnapshot.history),
      mergedTombstones,
    ),
    userId,
  );
  const mergedHistory = replaceScopedHistory(allLocalHistory, mergedScoped, matchesIdentity);
  const historyChanged = JSON.stringify(mergedHistory) !== JSON.stringify(allLocalHistory);
  const tombstonesChanged = JSON.stringify(mergedTombstones) !== JSON.stringify(localTombstones);

  if (historyChanged) {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));
  }
  if (tombstonesChanged) {
    await AsyncStorage.setItem(DELETED_COMPLETIONS_KEY, JSON.stringify(mergedTombstones));
  }

  hydratedScopedLocalBaselineCache.set(
    cacheKey,
    authoritativeScopedHistorySignature(mergedScoped, scopedLocalTombstoneApplied),
  );

  return {
    records: mergedScoped,
    hadLocalTombstones: mergedTombstones.length > 0,
    historyChanged,
    tombstonesChanged,
  };
};

const emitHistoryUpdated = () => {
  DeviceEventEmitter.emit('japam-history-updated');
  DeviceEventEmitter.emit('japam-stats-updated');
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('japam-history-updated'));
    window.dispatchEvent(new Event('japam-stats-updated'));
  }
};

/**
 * hydrateHistoryForUserDetails, but the remote fetch is NOT awaited: local-only rows are returned
 * immediately (hydrationSucceeded=false) and the remote merge continues in the background,
 * emitting japam-history-updated/japam-stats-updated when it lands so already-mounted screens
 * re-render with the merged rows. Screens that already show local data during a remote outage
 * (History) use this so a cold start is never gated on the supabase getSession network refresh.
 */
const hydrateHistoryForUserDetailsLocalFirst = async (
  userId: string,
  legacyUserId?: string | null,
  options: { force?: boolean; remotePageSize?: number } = {},
): Promise<HydratedHistoryResult> => {
  const local = await resolveLocalHydration(userId, legacyUserId, options.remotePageSize);
  const { localTombstones, localScopedRecords, scopedLocalTombstoneApplied, localStateAuthoritativelyChanged } = local;

  const continueInBackground = async () => {
    try {
      const remoteSnapshot = await fetchRemoteHydrationSnapshot(
        userId,
        legacyUserId,
        options.force,
        options.remotePageSize,
      );
      // Re-read immediately after the remote await so newer offline writes/deletions are merged
      // into the current cache instead of being overwritten by the startup snapshot.
      const latestLocal = await resolveLocalHydration(userId, legacyUserId, options.remotePageSize);
      if (remoteSnapshot === null) {
        // A remote outage must not rewrite, delete, or canonicalize the local cache. Local
        // history remains available to the screen and export exactly as it was stored.
        return;
      }
      const applied = await applyRemoteHydration(
        userId,
        legacyUserId,
        latestLocal,
        remoteSnapshot,
        latestLocal.allLocalHistory,
        latestLocal.localTombstones,
      );
      if (applied.historyChanged || applied.tombstonesChanged) {
        emitHistoryUpdated();
      }
    } catch {
      // Best-effort background hydration; local rows are already shown.
    }
  };

  void continueInBackground();

  const cachedPageSnapshot = !options.force && options.remotePageSize
    ? hydratedRemoteSnapshotCache.get(getHydrationCacheKey(userId, legacyUserId, options.remotePageSize))
    : undefined;

  return {
    records: localScopedRecords,
    hydrationSucceeded: false,
    localRecordCount: localScopedRecords.length,
    hadLocalTombstones: localTombstones.length > 0,
    scopedLocalTombstoneApplied,
    localStateAuthoritativelyChanged,
    hasMoreRemote: cachedPageSnapshot?.pagination
      ? paginationHasMore(cachedPageSnapshot.pagination)
      : Boolean(options.remotePageSize),
  };
};

export const hydrateHistoryForUserDetails = async (
  userId: string | null | undefined,
  legacyUserId?: string | null,
  options: { force?: boolean; localFirst?: boolean; remotePageSize?: number } = {},
): Promise<HydratedHistoryResult> => {
  if (options.localFirst && userId) {
    return hydrateHistoryForUserDetailsLocalFirst(userId, legacyUserId, options);
  }

  if (!userId) {
    const guestHistory = await loadHistoryForUser(userId);
    return {
      records: guestHistory,
      hydrationSucceeded: true,
      localRecordCount: guestHistory.length,
      hadLocalTombstones: false,
      scopedLocalTombstoneApplied: false,
      localStateAuthoritativelyChanged: false,
      hasMoreRemote: false,
    };
  }

  const local = await resolveLocalHydration(userId, legacyUserId, options.remotePageSize);
  const { allLocalHistory, localTombstones, localScopedRecords, scopedLocalTombstoneApplied, localStateAuthoritativelyChanged } = local;
  const remoteSnapshot = await fetchRemoteHydrationSnapshot(
    userId,
    legacyUserId,
    options.force,
    options.remotePageSize,
  );

  if (remoteSnapshot === null) {
    const scopedRecords = localScopedRecords;
    return {
      records: scopedRecords,
      hydrationSucceeded: false,
      localRecordCount: scopedRecords.length,
      hadLocalTombstones: localTombstones.length > 0,
      scopedLocalTombstoneApplied,
      localStateAuthoritativelyChanged,
      hasMoreRemote: false,
    };
  }

  const merged = await applyRemoteHydration(
    userId,
    legacyUserId,
    local,
    remoteSnapshot,
    allLocalHistory,
    localTombstones,
  );

  return {
    records: merged.records,
    hydrationSucceeded: true,
    localRecordCount: merged.records.length,
    hadLocalTombstones: merged.hadLocalTombstones,
    scopedLocalTombstoneApplied,
    localStateAuthoritativelyChanged,
    hasMoreRemote: paginationHasMore(remoteSnapshot.pagination),
  };
};

export const hydrateHistoryForUser = async (
  userId: string | null | undefined,
  legacyUserId?: string | null,
  options: { force?: boolean; remotePageSize?: number } = {},
): Promise<HistoryRecord[]> => {
  const hydrated = await hydrateHistoryForUserDetails(userId, legacyUserId, options);
  return hydrated.records;
};

/**
 * Fetch one older remote page for History and merge it into the local cache. Each identity has
 * its own cursor, so canonical and legacy rows cannot skip one another at a same-timestamp
 * boundary. A page is additive only: a partial response is never treated as a full snapshot.
 */
export const loadMoreHistoryForUser = async (
  userId: string | null | undefined,
  legacyUserId?: string | null,
  options: { pageSize?: number } = {},
): Promise<HistoryPageResult> => {
  if (!userId) {
    const records = await loadHistoryForUser(userId);
    return { records, hasMoreRemote: false, pageLoaded: false };
  }

  const pageSize = options.pageSize || DEFAULT_REMOTE_HISTORY_PAGE_SIZE;
  const cacheKey = getHydrationCacheKey(userId, legacyUserId, pageSize);
  const existing = historyPageInFlight.get(cacheKey);
  if (existing) return existing;

  const task = (async (): Promise<HistoryPageResult> => {
    // If the initial local-first fetch is still running, this awaits it rather than starting a
    // second stream with a missing cursor.
    const snapshot = hydratedRemoteSnapshotCache.get(cacheKey)
      ?? await fetchRemoteHydrationSnapshot(userId, legacyUserId, false, pageSize);
    if (!snapshot?.pagination) {
      return {
        records: await loadHistoryForUser(userId),
        hasMoreRemote: false,
        pageLoaded: false,
      };
    }

    const activeSources = snapshot.pagination.sources.filter((source) => !source.exhausted);
    const buffered = mergeHistories([], snapshot.pagination.sources.flatMap((source) => source.buffered));
    if (activeSources.length === 0 && buffered.length === 0) {
      return {
        records: await loadHistoryForUser(userId),
        hasMoreRemote: false,
        pageLoaded: false,
      };
    }

    let nextSources = snapshot.pagination.sources;
    let available = buffered;
    const sourcesNeedingHeadCoverage = activeSources.filter((source) => (
      available.length < pageSize || source.buffered.length < pageSize
    ));
    if (sourcesNeedingHeadCoverage.length > 0) {
      const pages = await Promise.all(
        sourcesNeedingHeadCoverage.map((source) => fetchRemoteHistoryPage(
          source.userId,
          snapshot.pagination?.sourcePageSize ?? pageSize,
          source.cursor,
        )),
      );
      // A failed/interrupted page does not touch either AsyncStorage key or the in-memory snapshot.
      if (pages.some((page) => page === null)) {
        const local = await resolveLocalHydration(userId, legacyUserId, pageSize);
        return { records: local.localScopedRecords, hasMoreRemote: true, pageLoaded: false };
      }

      const resolvedPages = pages as RemoteHistoryPage[];
      let pageIndex = 0;
      nextSources = snapshot.pagination.sources.map((source) => {
        if (!sourcesNeedingHeadCoverage.includes(source)) return source;
        const page = resolvedPages[pageIndex++];
        return {
          ...source,
          cursor: page.cursor,
          exhausted: page.exhausted,
          buffered: [...source.buffered, ...page.records],
        };
      });
      available = mergeHistories([], nextSources.flatMap((source) => source.buffered));
    }

    const nextPage = available.slice(0, pageSize);
    const consumedIds = new Set(nextPage.map((record) => record.completionId));
    nextSources = nextSources.map((source) => ({
      ...source,
      buffered: source.buffered.filter((record) => !consumedIds.has(record.completionId)),
    }));
    const nextSnapshot: RemoteHydrationSnapshot = {
      history: mergeHistories([], [...snapshot.history, ...nextPage]),
      tombstones: snapshot.tombstones,
      pagination: { ...snapshot.pagination, sources: nextSources },
    };
    hydratedRemoteSnapshotCache.set(cacheKey, nextSnapshot);

    const latestLocal = await resolveLocalHydration(userId, legacyUserId, pageSize);
    const applied = await applyRemoteHydration(
      userId,
      legacyUserId,
      latestLocal,
      nextSnapshot,
      latestLocal.allLocalHistory,
      latestLocal.localTombstones,
    );
    if (applied.historyChanged || applied.tombstonesChanged) emitHistoryUpdated();

    return {
      records: applied.records,
      hasMoreRemote: nextSources.some((source) => !source.exhausted || source.buffered.length > 0),
      pageLoaded: nextPage.length > 0,
    };
  })();

  historyPageInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    historyPageInFlight.delete(cacheKey);
  }
};

/** Drain the paginated History stream for complete export/full-record operations only. */
export const drainHistoryForUser = async (
  userId: string | null | undefined,
  legacyUserId?: string | null,
  options: { pageSize?: number } = {},
): Promise<HistoryDrainResult> => {
  if (!userId) return { records: await loadHistoryForUser(userId), complete: true, remoteUnavailable: false };

  const pageSize = options.pageSize || DEFAULT_REMOTE_HISTORY_PAGE_SIZE;
  const initial = await hydrateHistoryForUserDetails(userId, legacyUserId, { remotePageSize: pageSize });
  if (!initial.hydrationSucceeded) {
    // Export historically used the scoped AsyncStorage cache. A remote outage must not turn that
    // offline export into an error, but one cached page is not proof of remote completeness.
    const local = await resolveLocalHydration(userId, legacyUserId, pageSize);
    return { records: local.localScopedRecords, complete: false, remoteUnavailable: true };
  }
  let hasMoreRemote = initial.hasMoreRemote;
  let complete: boolean = initial.hydrationSucceeded;
  while (hasMoreRemote) {
    const page = await loadMoreHistoryForUser(userId, legacyUserId, { pageSize });
    if (!page.pageLoaded) {
      complete = false;
      break;
    }
    hasMoreRemote = page.hasMoreRemote;
  }
  const local = await resolveLocalHydration(userId, legacyUserId, pageSize);
  return { records: local.localScopedRecords, complete: complete && !hasMoreRemote, remoteUnavailable: false };
};

/**
 * This user's history records for exactly one Japam, already scoped and deduped -- the single
 * place any screen scoped to "the current Japam" (History) asks for its records, instead of
 * loading history and calling a historyStore selector itself. Internally: load history, filter to
 * this user, then hand off to filterByJapam (which dedupes and matches the Japam).
 *
 * japamName is an optional fallback: when japamId is a real UUID, filterByJapam also includes
 * legacy records whose japam_id is null but whose japam_name matches — rows created before Japam
 * workspaces existed, or rows whose japam_id was dropped by a NULL FK.
 *
 * The optional `japams` list is passed through to filterByJapam so that legacy-name attribution is
 * ambiguity-safe and identical to My Japams' statsByJapamWithAttribution (shared rule): a legacy
 * name shared by more than one Japam is claimed by none of them.
 */
export const loadHistoryForJapam = async (
  userId: string | null | undefined,
  japamId: string | null,
  japamName?: string | null,
  options: { includeBlankLegacy?: boolean } = {},
  japams?: Japam[] | null,
): Promise<HistoryRecord[]> => {
  const forUser = await loadHistoryForUser(userId);
  const inputs: JapamAttributionInput[] | null = japams && japams.length > 0
    ? japams.map((j) => ({ id: j.id, name: j.name }))
    : null;
  return filterByJapam(forUser, japamId, japamName, options, inputs);
};

/**
 * Every Japam's today + lifetime stats at once, for this user (or guest) — the "My Japams" list's
 * one-stop read. Returns the same Map shape lib/historyStore.ts's statsByJapam already produces;
 * look up one Japam's stats out of it with japamStatsFor (re-exported above).
 *
 * When the caller also supplies the current Japam list, stats are computed through
 * statsByJapamWithAttribution so pre-Workspaces legacy records are attributed to a Japam exactly
 * the way History/Timer attribute them (matching japam_id; unambiguous japam_name match; blank
 * legacy to the first ACTIVE Japam — `activeJapams(japams)[0]`, the canonical default bucket, NOT
 * merely `japams[0]`). Every record is assigned to exactly one Japam and the null bucket holds only
 * records no Japam claims, so a Japam's lifetime total on My Japams agrees with History's per-Japam
 * total. Callers without a Japam list (loadTodayStats/loadLifetimeStats below) fall back to the
 * strict japamId-only statsByJapam — unchanged behavior.
 */
export const loadJapamStats = async (
  userId: string | null | undefined,
  japams?: Japam[] | null,
): Promise<Map<string | null, JapamStats>> => {
  const history = await loadHistoryForUser(userId);
  const todayKey = getLocalDateKey();
  if (japams && japams.length > 0) {
    const inputs: JapamAttributionInput[] = japams.map((j) => ({ id: j.id, name: j.name }));
    const firstActiveJapamId = activeJapams(japams)[0]?.id ?? null;
    return statsByJapamWithAttribution(history, userId, inputs, firstActiveJapamId, todayKey, toLocalDayKey);
  }
  return statsByJapam(history, userId, todayKey, toLocalDayKey);
};

/** Today's malas/count for one Japam (or the legacy bucket, if japamId is null/omitted). */
export const loadTodayStats = async (
  userId: string | null | undefined,
  japamId?: string | null,
): Promise<{ malas: number; totalCount: number }> => {
  const statsMap = await loadJapamStats(userId);
  const stats = japamStatsFor(statsMap, japamId);
  return { malas: stats.todayMalas, totalCount: stats.todayTotalCount };
};

/** Lifetime malas/count for one Japam (or the legacy bucket, if japamId is null/omitted). */
export const loadLifetimeStats = async (
  userId: string | null | undefined,
  japamId?: string | null,
): Promise<{ malas: number; totalCount: number }> => {
  const statsMap = await loadJapamStats(userId);
  const stats = japamStatsFor(statsMap, japamId);
  return { malas: stats.lifetimeMalas, totalCount: stats.lifetimeTotalCount };
};

type RemoteLegacyHistoryRow = {
  id?: number | string;
  created_at?: string;
  malas?: number | string;
  count?: number | string;
  user_name?: string | null;
  completion_id?: string | null;
  japam_id?: string | null;
  japam_name?: string | null;
};

function remoteRowToHistoryRecord(row: RemoteLegacyHistoryRow, userId: string): HistoryRecord {
  const malas = Number(row.malas) || 0;
  const totalCount = Number(row.count) || malas * 108;
  const date = row.created_at || new Date().toISOString();
  return {
    date,
    malas: malas || Math.floor(totalCount / 108),
    totalCount,
    duration: 0,
    manual: false,
    userId,
    userName: row.user_name || undefined,
    remoteId: row.id,
    completionId: row.completion_id || `${userId}:${new Date(date).getTime()}`,
    syncStatus: 'synced',
    japamId: row.japam_id ?? null,
    japamName: row.japam_name ?? null,
  };
}

// The backfill is allowed to change only Japam attribution. Keep a stable snapshot of every
// other History field so a user edit that lands while the remote PATCH loop is running remains
// pending instead of being mistaken for the exact version the backfill wrote.
const historyBackfillVersion = (record: HistoryRecord): string => JSON.stringify({
  date: record.date,
  malas: record.malas,
  totalCount: record.totalCount,
  duration: record.duration,
  manual: record.manual,
  userId: record.userId ?? null,
  userName: record.userName ?? null,
  userEmail: record.userEmail ?? null,
  source: record.source ?? null,
  remoteId: record.remoteId ?? null,
  completionId: record.completionId,
  japamId: record.japamId ?? null,
  japamName: record.japamName ?? null,
});

/**
 * Best-effort remote half of the legacy backfill. The query is scoped to the authenticated user,
 * and eligibility is decided HERE against the authoritative remote `japam_history` rows using the
 * EXACT SAME History attribution rule the screens use (`filterByJapam` with `includeBlankLegacy`
 * plus the caller's Japam list for the ambiguity-safe name index) — so blank legacy rows go to the
 * canonical first-active Japam, named rows only to their uniquely-matching Japam, and ambiguous or
 * other-Japam rows stay untouched.
 *
 * Deliberately NOT gated on a caller-supplied completion-id set: the runner builds that set from
 * the client's LOCAL AsyncStorage snapshot at app startup, which can lag behind (or entirely lack)
 * the rows that actually exist in `japam_history` — the History screen's remote merge has not
 * populated local storage yet, or a device has no local copy of those rows at all. Intersecting the
 * remote PATCHes with that stale local-derived set is exactly what left production's eligible
 * null-japamId rows unassigned (History showed their totals via the same attribution rule while the
 * Groups RPC, which counts only `japam_id = p_japam_id`, did not). The remote source is
 * authoritative; the shared attribution rule applied here is the single filter, so no local/remote
 * divergence can silently skip rows.
 *
 * Existing rows are patched one at a time by their remote id + user id, so retries are idempotent
 * and cannot insert a duplicate or touch another user's/another Japam's history.
 */
const syncLegacyHistoryBackfillToSupabase = async (
  userId: string,
  japamId: string,
  japamName: string,
  japams: Japam[] | null | undefined,
): Promise<Set<string>> => {
  if (!userId) return new Set();

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return new Set();

  // Load lazily so historyRepository's pure/local tests do not need Supabase configuration.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { supabase } = require('./supabase') as typeof import('./supabase');
  const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
  if (!accessToken) return new Set();

  try {
    const query = new URLSearchParams({
      user_id: `eq.${userId}`,
      select: 'id,created_at,malas,count,user_name,completion_id,japam_id,japam_name',
    });
    const response = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
      headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (!response.ok) return new Set();

    const rows = (await response.json()) as RemoteLegacyHistoryRow[];
    const remoteRecords = (Array.isArray(rows) ? rows : [])
      .map((row) => remoteRowToHistoryRecord(row, userId));
    const attributionInputs: JapamAttributionInput[] | null = japams && japams.length > 0
      ? japams.map((j) => ({ id: j.id, name: j.name }))
      : null;
    const eligible = filterByJapam(
      remoteRecords,
      japamId,
      japamName,
      { includeBlankLegacy: true },
      attributionInputs,
    ).filter((record) => (
      record.japamId == null
      && record.remoteId != null
    ));

    const syncedIds = new Set<string>();
    for (const record of eligible) {
      const patchQuery = new URLSearchParams({
        id: `eq.${record.remoteId}`,
        user_id: `eq.${userId}`,
      });
      const patch = await fetch(`${url}/rest/v1/japam_history?${patchQuery.toString()}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ japam_id: japamId, japam_name: japamName }),
      });
      if (patch.ok) syncedIds.add(record.completionId);
    }
    return syncedIds;
  } catch {
    return new Set();
  }
};

/**
 * Persists the one-time legacy history backfill for one identity: reassigns that identity's
 * null-japamId records to (japamId, japamName) and writes the result back to the SAME HISTORY_KEY
 * every other read/write in this app already uses -- offline-first, no network call, no Supabase
 * write. Every other identity's records (every other user, or guest, mixed into the same storage
 * key) are read back out untouched and written back exactly as they were.
 *
 * The actual reassignment decision is lib/legacyHistoryBackfill.ts's planLegacyHistoryBackfill
 * (pure, already tested) -- this function only supplies the I/O around it: load, scope to this
 * identity, plan, merge back with everyone else's untouched records, and persist -- but only if
 * the plan actually found something to reassign, so a no-op call never rewrites storage.
 *
 * After a successful write, emits japam-history-updated (via DeviceEventEmitter + web fallback)
 * so in-memory consumers (Timer streak, History screen, stats) recalculate immediately from the
 * new persisted state without requiring a tab switch or cold restart. The event is NOT emitted
 * for no-ops (needsBackfill=false) or any write/load failure.
 *
 * Callers (currently only LegacyHistoryBackfillRunner) are still responsible for: deciding
 * japamId/japamName, creating that Japam, checking/setting the per-identity "already backfilled"
 * flag so this never runs a second time, and showing any user-facing notice. None of that lives
 * here.
 */
export const applyLegacyHistoryBackfill = async (
  userId: string | null | undefined,
  japamId: string,
  japamName: string,
  options: LegacyHistoryBackfillOptions & { japams?: Japam[] | null } = {},
): Promise<LegacyHistoryBackfillPlan & { remoteSyncedIds: string[] }> => {
  const all = await loadHistory();
  const matchesIdentity = (r: HistoryRecord) => (userId ? r.userId === userId : !r.userId);
  const forThisIdentity = all.filter(matchesIdentity);
  const forOthers = all.filter((r) => !matchesIdentity(r));

  const plan = planLegacyHistoryBackfill(forThisIdentity, japamId, japamName, options);
  const expectedBackfillVersions = new Map(
    plan.reassignedRecords.map((record) => [record.completionId, historyBackfillVersion(record)])
  );
  let remoteSyncedIds: string[] = [];

  if (plan.needsBackfill) {
    const merged = [...forOthers, ...plan.updatedRecords];
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(merged));

    DeviceEventEmitter.emit('japam-history-updated');
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-history-updated'));
    }
  }

  if (userId) {
    remoteSyncedIds = [...await syncLegacyHistoryBackfillToSupabase(
      userId,
      japamId,
      japamName,
      options.japams,
    )];
    if (remoteSyncedIds.length > 0) {
      const latest = await loadHistory();
      const synced = new Set(remoteSyncedIds);
      const updatedLatest = latest.map((record) => {
        if (!synced.has(record.completionId) || record.japamId !== japamId) return record;
        const expectedVersion = expectedBackfillVersions.get(record.completionId);
        if (!expectedVersion || historyBackfillVersion(record) !== expectedVersion) return record;
        return { ...record, syncStatus: 'synced' as const };
      });
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedLatest));
    }
  }

  return { ...plan, remoteSyncedIds };
};

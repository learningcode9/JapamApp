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

const remoteRowToHistoryRecord = (row: RemoteLegacyHistoryRow, userId: string): HistoryRecord => {
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
};

/**
 * Best-effort remote half of the legacy backfill. The query is scoped to the authenticated user,
 * and the caller supplies the same History-attributed records that are safe to assign locally.
 * Existing rows are patched by their remote id, so retries are idempotent and cannot insert a
 * duplicate or touch another user's/another Japam's history.
 */
const syncLegacyHistoryBackfillToSupabase = async (
  userId: string,
  japamId: string,
  japamName: string,
  japams: Japam[] | null | undefined,
  onlyCompletionIds?: ReadonlySet<string>,
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
      && (!onlyCompletionIds || onlyCompletionIds.has(record.completionId))
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
      options.onlyCompletionIds,
    )];
    if (remoteSyncedIds.length > 0) {
      const latest = await loadHistory();
      const synced = new Set(remoteSyncedIds);
      const updatedLatest = latest.map((record) => (
        synced.has(record.completionId) && record.japamId === japamId
          ? { ...record, syncStatus: 'synced' as const }
          : record
      ));
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedLatest));
    }
  }

  return { ...plan, remoteSyncedIds };
};

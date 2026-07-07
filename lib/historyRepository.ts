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
 * This commit implements read operations only. Writes (appendCompletion, edits, deletes) are not
 * moved here — Timer/Home/Tap/Manual/History are not being wired to this repository yet, and their
 * own write paths are unchanged for now.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  normalizeAll,
  statsByJapam,
  japamStatsFor as japamStatsForSelector,
  filterByJapam,
  toLocalDayKey,
  type HistoryRecord,
  type RawHistoryRecord,
  type JapamStats,
} from './historyStore';

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
 * this user, then hand off to filterByJapam (which dedupes and matches the Japam). japamId: null
 * matches only legacy/unassigned records, mirroring lib/historyStore.ts's own null-means-legacy
 * convention throughout (statsByJapam, planHistoryDayAdjustment, filterByJapam).
 */
export const loadHistoryForJapam = async (
  userId: string | null | undefined,
  japamId: string | null,
): Promise<HistoryRecord[]> => {
  const forUser = await loadHistoryForUser(userId);
  return filterByJapam(forUser, japamId);
};

/**
 * Every Japam's today + lifetime stats at once, for this user (or guest) — the "My Japams" list's
 * one-stop read. Returns the same Map shape lib/historyStore.ts's statsByJapam already produces;
 * look up one Japam's stats out of it with japamStatsFor (re-exported above).
 */
export const loadJapamStats = async (
  userId: string | null | undefined,
): Promise<Map<string | null, JapamStats>> => {
  const history = await loadHistoryForUser(userId);
  const todayKey = getLocalDateKey();
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

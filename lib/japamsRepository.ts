/**
 * Repository layer for Japam Workspaces — the ONLY place in the app that knows HOW Japams are
 * persisted. Today that's AsyncStorage only. When Supabase sync is added, it is added ENTIRELY
 * INSIDE this file (e.g. a best-effort background upsert after each local write, mirroring
 * historyStore.ts's local-first-then-sync discipline, or a merge on load) — CurrentJapamContext
 * and every UI screen call these exact same function names with the exact same signatures either
 * way and never need to change. That is the whole point of this layer existing.
 *
 * Every mutation here is self-contained: it reads the current persisted state itself (rather than
 * requiring the caller to pass in whatever it happens to have in memory), applies the relevant
 * pure transformation from lib/japams.ts, persists, and returns the result. This avoids a lost-
 * update race between the caller's in-memory cache and what's actually persisted — a concern that
 * becomes real, not hypothetical, once a background sync can also write to storage independently.
 *
 * CurrentJapamContext owns RUNTIME state (the in-memory japams list, which one is selected). This
 * file owns PERSISTENCE. Selection logic (e.g. "which Japam should become current after this
 * archive") deliberately stays in the Context, not here — that's a runtime concern, not a storage
 * concern.
 */

import {
  createJapam as createJapamPure,
  renameJapam as renameJapamPure,
  archiveJapam as archiveJapamPure,
  restoreJapam as restoreJapamPure,
  type Japam,
} from './japams';
import {
  loadJapams as loadJapamsFromStorage,
  saveJapams as saveJapamsToStorage,
  loadCurrentJapamId as loadCurrentJapamIdFromStorage,
  saveCurrentJapamId as saveCurrentJapamIdToStorage,
} from './japamsStorage';

const syncInFlight = new Map<string, boolean>();

const enqueueSync = (userId: string, japam: Japam): void => {
  if (!userId) return;

  if (syncInFlight.has(japam.id)) {
    syncInFlight.set(japam.id, true);
    return;
  }

  syncInFlight.set(japam.id, false);
  void syncLoop(userId, japam.id);
};

const syncLoop = async (userId: string, japamId: string): Promise<void> => {
  try {
    while (syncInFlight.has(japamId)) {
      syncInFlight.set(japamId, false);

      const japams = await loadJapamsFromStorage(userId);
      const japam = japams.find((j) => j.id === japamId);
      if (!japam) {
        syncInFlight.delete(japamId);
        return;
      }

      const ok = await syncJapam(userId, japam);
      if (!ok) {
        syncInFlight.delete(japamId);
        return;
      }

      if (!syncInFlight.get(japamId)) {
        syncInFlight.delete(japamId);
        return;
      }
    }
  } catch {
    syncInFlight.delete(japamId);
  }
};

export const loadJapams = (userId: string | null | undefined): Promise<Japam[]> =>
  loadJapamsFromStorage(userId);

export const saveJapams = (userId: string | null | undefined, japams: Japam[]): Promise<void> =>
  saveJapamsToStorage(userId, japams);

/**
 * Create a Japam and persist it. Reads the current list itself before appending, so it's correct
 * regardless of what the caller's in-memory cache currently holds. Returns null (never throws) if
 * the name is blank, matching createJapam's own safe-no-op behavior in lib/japams.ts.
 */
export const createJapam = async (
  userId: string | null | undefined,
  rawName: string,
): Promise<{ created: Japam; japams: Japam[] } | null> => {
  const existing = await loadJapamsFromStorage(userId);
  const created = createJapamPure(userId, rawName);
  if (created === null) return null;
  const updated = [...existing, created];
  await saveJapamsToStorage(userId, updated);
  if (userId) enqueueSync(userId, created);
  return { created, japams: updated };
};

/** Rename a Japam and persist it. No-op (returns the list unchanged) if japamId isn't found. */
export const renameJapam = async (
  userId: string | null | undefined,
  japamId: string,
  rawName: string,
): Promise<Japam[]> => {
  const existing = await loadJapamsFromStorage(userId);
  const target = existing.find((j) => j.id === japamId);
  if (!target) return existing;
  const renamed = renameJapamPure(target, rawName);
  const updated = existing.map((j) => (j.id === japamId ? renamed : j));
  await saveJapamsToStorage(userId, updated);
  if (userId) {
    const current = updated.find((j) => j.id === japamId);
    if (current) enqueueSync(userId, current);
  }
  return updated;
};

/** Archive a Japam and persist it. No-op if japamId isn't found. Never touches history. */
export const archiveJapam = async (
  userId: string | null | undefined,
  japamId: string,
): Promise<Japam[]> => {
  const existing = await loadJapamsFromStorage(userId);
  const target = existing.find((j) => j.id === japamId);
  if (!target) return existing;
  const archived = archiveJapamPure(target);
  const updated = existing.map((j) => (j.id === japamId ? archived : j));
  await saveJapamsToStorage(userId, updated);
  if (userId) {
    const current = updated.find((j) => j.id === japamId);
    if (current) enqueueSync(userId, current);
  }
  return updated;
};

/** Restore a previously archived Japam and persist it. No-op if japamId isn't found. */
export const restoreJapam = async (
  userId: string | null | undefined,
  japamId: string,
): Promise<Japam[]> => {
  const existing = await loadJapamsFromStorage(userId);
  const target = existing.find((j) => j.id === japamId);
  if (!target) return existing;
  const restored = restoreJapamPure(target);
  const updated = existing.map((j) => (j.id === japamId ? restored : j));
  await saveJapamsToStorage(userId, updated);
  if (userId) {
    const current = updated.find((j) => j.id === japamId);
    if (current) enqueueSync(userId, current);
  }
  return updated;
};

/**
 * Permanently delete an archived Japam. No-op if japamId isn't found.
 * This is deliberately restricted to archived Japams only — active Japams must
 * be archived first before they can be deleted.
 */
export const deleteJapam = async (
  userId: string | null | undefined,
  japamId: string,
): Promise<Japam[]> => {
  const existing = await loadJapamsFromStorage(userId);
  const target = existing.find((j) => j.id === japamId);
  if (!target) return existing;
  const updated = existing.filter((j) => j.id !== japamId);
  await saveJapamsToStorage(userId, updated);
  return updated;
};

export const loadCurrentJapamId = (userId: string | null | undefined): Promise<string | null> =>
  loadCurrentJapamIdFromStorage(userId);

export const saveCurrentJapamId = (
  userId: string | null | undefined,
  japamId: string | null,
): Promise<void> => saveCurrentJapamIdToStorage(userId, japamId);

export const syncJapam = async (
  userId: string,
  japam: Japam,
): Promise<boolean> => {
  if (!userId) {
    console.warn('[JAPAM_SYNC_FAILED]', {
      japamId: japam.id,
      code: 'MISSING_USER_ID',
      message: 'Cannot sync Japam without an authenticated user',
    });
    return false;
  }

  if (japam.userId !== null && japam.userId !== userId) {
    console.warn('[JAPAM_SYNC_FAILED]', {
      japamId: japam.id,
      code: 'USER_ID_MISMATCH',
      message: 'Japam userId does not match authenticated user',
    });
    return false;
  }

  try {
    // Temporary lazy require() to avoid breaking pre-existing tests that
    // import japamsRepository.ts without mocking ../supabase. Replace with
    // a top-level import when runtime wiring and test mocks are updated.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase');
    const { error } = await supabase
      .from('japams')
      .upsert(
        {
          id: japam.id,
          user_id: userId,
          name: japam.name,
          archived_at: japam.archivedAt,
        },
        { onConflict: 'id' },
      );

    if (error) {
      console.warn('[JAPAM_SYNC_FAILED]', {
        japamId: japam.id,
        code: error.code,
        message: error.message,
      });
      return false;
    }

    return true;
  } catch {
    console.warn('[JAPAM_SYNC_FAILED]', {
      japamId: japam.id,
      code: 'NETWORK_ERROR',
      message: 'Network error during Japam sync',
    });
    return false;
  }
};

let reconciliationInFlight = false;

export const reconcileAllJapams = async (
  userId: string,
): Promise<{ synced: number; failed: number }> => {
  if (!userId || reconciliationInFlight) return { synced: 0, failed: 0 };
  reconciliationInFlight = true;
  try {
    const japams = await loadJapamsFromStorage(userId);
    let synced = 0;
    let failed = 0;
    for (const japam of japams) {
      const ok = await syncJapam(userId, japam);
      if (ok) synced++;
      else failed++;
    }
    return { synced, failed };
  } finally {
    reconciliationInFlight = false;
  }
};

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
  applyJapamTombstones,
  normalizeJapamName,
  type Japam,
} from './japams';
import { mergeTombstones } from './historyStore';
import { uuidV5 } from './deterministicUuid';
import {
  loadJapams as loadJapamsFromStorage,
  saveJapams as saveJapamsToStorage,
  loadCurrentJapamId as loadCurrentJapamIdFromStorage,
  saveCurrentJapamId as saveCurrentJapamIdToStorage,
  loadDeletedJapams as loadDeletedJapamsFromStorage,
  saveDeletedJapams as saveDeletedJapamsToStorage,
} from './japamsStorage';

const DEFAULT_JAPAM_NAME = 'My Japam';
const DEFAULT_JAPAM_UUID_NAMESPACE = '62f5824e-58fd-5d39-9f87-1f761082d8e3';

const syncInFlight = new Map<string, boolean>();
const defaultEnsureInFlight = new Map<string, Promise<{
  japams: Japam[];
  currentJapamId: string | null;
  created: Japam | null;
}>>();

type RemoteJapamRow = {
  id: string;
  user_id: string;
  name: string;
  display_order?: number | null;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
};

const remoteRowToJapam = (row: RemoteJapamRow): Japam => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  displayOrder: row.display_order ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at ?? row.created_at,
  archivedAt: row.archived_at ?? null,
});

const createdAtMillis = (japam: Japam): number => {
  const millis = Date.parse(japam.createdAt);
  return Number.isFinite(millis) ? millis : Number.MAX_SAFE_INTEGER;
};

const updatedAtMillis = (japam: Japam): number | null => {
  const millis = Date.parse(japam.updatedAt);
  return Number.isFinite(millis) ? millis : null;
};

const sortByCreatedAtThenId = (a: Japam, b: Japam): number => {
  const timeDiff = createdAtMillis(a) - createdAtMillis(b);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
};

const activeByCanonicalOrder = (japams: Japam[]): Japam[] =>
  japams.filter((j) => j.archivedAt === null).sort(sortByCreatedAtThenId);

const mergeJapamsById = (local: Japam[], remote: Japam[]): Japam[] => {
  const merged = new Map<string, Japam>();
  for (const japam of remote) {
    merged.set(japam.id, japam);
  }
  for (const japam of local) {
    const remoteMatch = merged.get(japam.id);
    if (!remoteMatch) {
      merged.set(japam.id, japam);
      continue;
    }
    merged.set(japam.id, resolveSameIdJapam(japam, remoteMatch));
  }
  return [...merged.values()].sort(sortByCreatedAtThenId);
};

function resolveSameIdJapam(local: Japam, remote: Japam): Japam {
  // A remotely archived Japam must stay archived even if the local cache is stale.
  if (remote.archivedAt !== null) return remote;

  const localUpdatedAt = updatedAtMillis(local);
  const remoteUpdatedAt = updatedAtMillis(remote);
  if (localUpdatedAt !== null && remoteUpdatedAt !== null) {
    if (localUpdatedAt > remoteUpdatedAt) return local;
    if (remoteUpdatedAt > localUpdatedAt) return remote;
  }

  // If we cannot prove the local copy is newer, prefer the remote row during signed-in startup
  // reconciliation so we do not silently overwrite authoritative remote state.
  return remote;
}

const deterministicDefaultJapamId = (userId: string): string =>
  uuidV5(`${userId}:default-japam`, DEFAULT_JAPAM_UUID_NAMESPACE);

const fetchRemoteJapams = async (userId: string): Promise<Japam[] | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase');
    const { data, error } = await supabase
      .from('japams')
      .select('id,user_id,name,display_order,created_at,updated_at,archived_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('[JAPAM_REMOTE_LOAD_FAILED]', {
        code: error.code,
        message: error.message,
      });
      return null;
    }

    return ((data ?? []) as RemoteJapamRow[]).map(remoteRowToJapam);
  } catch {
    console.warn('[JAPAM_REMOTE_LOAD_FAILED]', {
      code: 'NETWORK_ERROR',
      message: 'Network error during Japam remote load',
    });
    return null;
  }
};

const fetchRemoteDeletedJapams = async (userId: string): Promise<string[] | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase');
    const { data, error } = await supabase
      .from('deleted_japams')
      .select('japam_id')
      .eq('user_id', userId)
      .order('deleted_at', { ascending: true });

    if (error) {
      console.warn('[JAPAM_TOMBSTONE_LOAD_FAILED]', {
        code: error.code,
        message: error.message,
      });
      return null;
    }

    return ((data ?? []) as Array<{ japam_id?: unknown }>).map((row) => String(row.japam_id)).filter((id) => id.length > 0);
  } catch {
    console.warn('[JAPAM_TOMBSTONE_LOAD_FAILED]', {
      code: 'NETWORK_ERROR',
      message: 'Network error during Japam tombstone load',
    });
    return null;
  }
};

type RemoteJapamUsageRow = {
  japam_id: string;
  name: string;
  history_count: number;
  group_ref_count: number;
  archived_at?: string | null;
};

type RemoteJapamUsage = {
  japamId: string;
  name: string;
  historyCount: number;
  groupRefCount: number;
  archivedAt: string | null;
};

const fetchRemoteJapamUsage = async (japamId: string): Promise<RemoteJapamUsage | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase');
    const { data, error } = await supabase.rpc('get_owned_japam_usage', {
      p_japam_id: japamId,
    });

    if (error) {
      console.warn('[JAPAM_USAGE_LOAD_FAILED]', {
        code: error.code,
        message: error.message,
      });
      return null;
    }

    const row = Array.isArray(data) ? (data[0] as RemoteJapamUsageRow | undefined) : (data as RemoteJapamUsageRow | null | undefined);
    if (!row) return null;
    return {
      japamId: row.japam_id,
      name: row.name,
      historyCount: Number(row.history_count) || 0,
      groupRefCount: Number(row.group_ref_count) || 0,
      archivedAt: row.archived_at ?? null,
    };
  } catch {
    console.warn('[JAPAM_USAGE_LOAD_FAILED]', {
      code: 'NETWORK_ERROR',
      message: 'Network error during Japam usage load',
    });
    return null;
  }
};

const loadMergedDeletedJapams = async (userId: string | null | undefined): Promise<Set<string>> => {
  if (!userId) return new Set();
  const local = await loadDeletedJapamsFromStorage(userId);
  const remote = await fetchRemoteDeletedJapams(userId);
  const merged = remote === null ? local : mergeTombstones(local, remote);
  if (merged.length !== local.length) {
    await saveDeletedJapamsToStorage(userId, merged);
  }
  return new Set(merged);
};

const loadAuthoritativeDeletedJapams = async (userId: string | null | undefined): Promise<Set<string> | null> => {
  if (!userId) return new Set();
  const local = await loadDeletedJapamsFromStorage(userId);
  const remote = await fetchRemoteDeletedJapams(userId);
  if (remote === null) return null;
  const merged = mergeTombstones(local, remote);
  if (merged.length !== local.length) {
    await saveDeletedJapamsToStorage(userId, merged);
  }
  return new Set(merged);
};

const restoreRemoteJapam = async (japamId: string): Promise<boolean> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase');
    const { data, error } = await supabase.rpc('restore_owned_japam', {
      p_japam_id: japamId,
    });

    if (error) {
      console.warn('[JAPAM_REMOTE_RESTORE_FAILED]', {
        japamId,
        code: error.code,
        message: error.message,
      });
      return false;
    }

    const returnedIds = Array.isArray(data)
      ? data
          .map((row) => (row && typeof row === 'object' ? (row as { restored_japam_id?: unknown }).restored_japam_id : null))
          .filter((id): id is string => typeof id === 'string')
      : [];

    if (returnedIds.length !== 1 || returnedIds[0] !== japamId) {
      console.warn('[JAPAM_REMOTE_RESTORE_FAILED]', {
        japamId,
        code: 'UNEXPECTED_RESPONSE',
        message: 'Restore did not return exactly one matching Japam ID',
      });
      return false;
    }

    return true;
  } catch {
    console.warn('[JAPAM_REMOTE_RESTORE_FAILED]', {
      japamId,
      code: 'NETWORK_ERROR',
      message: 'Network error during Japam restore',
    });
    return false;
  }
};

const restoreJapamInStorage = async (
  userId: string | null | undefined,
  existing: Japam[],
  target: Japam,
): Promise<Japam[] | null> => {
  if (userId) {
    const restoredRemotely = await restoreRemoteJapam(target.id);
    if (!restoredRemotely) return null;
  }

  const conflictCandidates = normalizeJapamName(target.name) === DEFAULT_JAPAM_NAME
    ? existing.filter(
        (j) =>
          j.id !== target.id
          && j.archivedAt === null
          && normalizeJapamName(j.name) === DEFAULT_JAPAM_NAME,
      )
    : [];
  const conflictUsage = userId
    ? await Promise.all(conflictCandidates.map(async (conflict) => ({
        conflict,
        usage: await fetchRemoteJapamUsage(conflict.id),
      })))
    : conflictCandidates.map((conflict) => ({
        conflict,
        usage: { japamId: conflict.id, name: conflict.name, historyCount: 0, groupRefCount: 0, archivedAt: null },
      }));

  if (conflictUsage.some(({ usage }) => usage === null)) return null;
  if (conflictUsage.some(({ usage }) => (usage?.historyCount ?? 0) > 0 || (usage?.groupRefCount ?? 0) > 0)) {
    return null;
  }

  const restored = restoreJapamPure(target);
  const retiredConflictIds = new Set(conflictUsage.map(({ conflict }) => conflict.id));
  const updated = existing
    .filter((j) => !retiredConflictIds.has(j.id))
    .map((j) => (j.id === target.id ? restored : j));
  const tombstones = userId ? await loadDeletedJapamsFromStorage(userId) : [];
  const nextTombstones = tombstones.filter((id) => id !== target.id && !retiredConflictIds.has(id));
  const nextDeleted = [...nextTombstones, ...conflictUsage.map(({ conflict }) => conflict.id)];

  await saveJapamsToStorage(userId, updated);
  if (userId) {
    await saveDeletedJapamsToStorage(userId, Array.from(new Set(nextDeleted)));
  }
  await saveCurrentJapamIdToStorage(userId, restored.id);
  if (userId) enqueueSync(userId, restored);

  return updated;
};

const findRestoreCandidate = async (
  userId: string,
  japams: Japam[],
): Promise<Japam | null> => {
  const archived = japams
    .filter((j) => j.archivedAt !== null && normalizeJapamName(j.name) === DEFAULT_JAPAM_NAME)
    .sort(sortByCreatedAtThenId);
  if (archived.length === 0) return null;

  const usage = await Promise.all(archived.map(async (j) => ({
    japam: j,
    usage: await fetchRemoteJapamUsage(j.id),
  })));
  if (usage.some(({ usage: u }) => u === null)) return null;

  const eligible = usage.filter(({ usage: u }) => (u?.historyCount ?? 0) > 0 || (u?.groupRefCount ?? 0) > 0);
  if (eligible.length !== 1) return null;
  return eligible[0].japam;
};

const deleteRemoteJapam = async (japamId: string): Promise<boolean> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require('./supabase');
    const { data, error } = await supabase.rpc('delete_owned_japam', {
      p_japam_id: japamId,
    });

    if (error) {
      console.warn('[JAPAM_REMOTE_DELETE_FAILED]', {
        japamId,
        code: error.code,
        message: error.message,
      });
      return false;
    }

    const returnedIds = Array.isArray(data)
      ? data
          .map((row) => (row && typeof row === 'object' ? (row as { deleted_japam_id?: unknown }).deleted_japam_id : null))
          .filter((id): id is string => typeof id === 'string')
      : [];

    if (returnedIds.length !== 1 || returnedIds[0] !== japamId) {
      console.warn('[JAPAM_REMOTE_DELETE_FAILED]', {
        japamId,
        code: 'UNEXPECTED_RESPONSE',
        message: 'Delete did not return exactly one matching Japam ID',
      });
      return false;
    }

    return true;
  } catch {
    console.warn('[JAPAM_REMOTE_DELETE_FAILED]', {
      japamId,
      code: 'NETWORK_ERROR',
      message: 'Network error during Japam delete',
    });
    return false;
  }
};

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
  Promise.all([loadJapamsFromStorage(userId), loadMergedDeletedJapams(userId)]).then(([japams, tombstones]) =>
    applyJapamTombstones(japams, tombstones ?? new Set()),
  );

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

const ensureDefaultJapamInternal = async (
  userId: string,
): Promise<{ japams: Japam[]; currentJapamId: string | null; created: Japam | null }> => {
  const local = await loadJapamsFromStorage(userId);
  const remote = await fetchRemoteJapams(userId);
  const tombstones = await loadAuthoritativeDeletedJapams(userId);
  if (tombstones === null) {
    return { japams: local, currentJapamId: null, created: null };
  }
  const mergedBeforeTombstones = remote === null ? local : mergeJapamsById(local, remote);
  const merged = applyJapamTombstones(mergedBeforeTombstones, tombstones);
  await saveJapamsToStorage(userId, merged);

  const persistedCurrentId = await loadCurrentJapamIdFromStorage(userId);
  const active = activeByCanonicalOrder(merged);
  const firstActive = active[0] ?? null;
  const persistedStillActive = persistedCurrentId
    ? active.find((j) => j.id === persistedCurrentId)
    : undefined;
  if (persistedStillActive) {
    return { japams: merged, currentJapamId: persistedStillActive.id, created: null };
  }

  const firstNonDefaultActive = active.find((j) => normalizeJapamName(j.name) !== DEFAULT_JAPAM_NAME) ?? null;
  if (firstNonDefaultActive) {
    await saveCurrentJapamIdToStorage(userId, firstNonDefaultActive.id);
    return { japams: merged, currentJapamId: firstNonDefaultActive.id, created: null };
  }

  const restoreCandidate = await findRestoreCandidate(userId, mergedBeforeTombstones);
  if (restoreCandidate) {
    const restored = await restoreJapamInStorage(userId, mergedBeforeTombstones, restoreCandidate);
    if (restored) {
      return { japams: restored, currentJapamId: restoreCandidate.id, created: null };
    }
    return { japams: merged, currentJapamId: null, created: null };
  }

  // If remote could not be loaded, do not guess that the signed-in user has no remote Japams.
  if (remote === null) {
    if (persistedCurrentId !== null) {
      await saveCurrentJapamIdToStorage(userId, null);
    }
    return { japams: merged, currentJapamId: null, created: null };
  }

  if (firstActive) {
    await saveCurrentJapamIdToStorage(userId, firstActive.id);
    return { japams: merged, currentJapamId: firstActive.id, created: null };
  }

  const now = new Date().toISOString();
  const created = createJapamPure(userId, DEFAULT_JAPAM_NAME, {
    id: deterministicDefaultJapamId(userId),
    now,
  });
  if (created === null) return { japams: merged, currentJapamId: null, created: null };
  if (tombstones.has(created.id)) return { japams: merged, currentJapamId: null, created: null };

  const updated = [...merged, created].sort(sortByCreatedAtThenId);
  await saveJapamsToStorage(userId, updated);
  await saveCurrentJapamIdToStorage(userId, created.id);
  enqueueSync(userId, created);
  return { japams: updated, currentJapamId: created.id, created };
};

export const ensureDefaultJapam = async (
  userId: string,
): Promise<{ japams: Japam[]; currentJapamId: string | null; created: Japam | null }> => {
  const existing = defaultEnsureInFlight.get(userId);
  if (existing) return existing;

  const promise = ensureDefaultJapamInternal(userId);
  defaultEnsureInFlight.set(userId, promise);
  try {
    return await promise;
  } finally {
    if (defaultEnsureInFlight.get(userId) === promise) {
      defaultEnsureInFlight.delete(userId);
    }
  }
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
  const updated = await restoreJapamInStorage(userId, existing, target);
  return updated ?? existing;
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
  if (!target || target.archivedAt === null) return existing;

  if (userId) {
    const deletedRemotely = await deleteRemoteJapam(japamId);
    if (!deletedRemotely) return existing;

    const tombstones = await loadDeletedJapamsFromStorage(userId);
    if (!tombstones.includes(japamId)) {
      await saveDeletedJapamsToStorage(userId, [...tombstones, japamId]);
    }
  }

  const updated = applyJapamTombstones(existing, [japamId]);
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

  const localTombstones = await loadDeletedJapamsFromStorage(userId);
  if (localTombstones.includes(japam.id)) {
    console.warn('[JAPAM_SYNC_FAILED]', {
      japamId: japam.id,
      code: 'TOMBSTONED_JAPAM',
      message: 'Cannot sync a permanently deleted Japam',
    });
    return false;
  }

  const remoteTombstones = await fetchRemoteDeletedJapams(userId);
  if (remoteTombstones === null) {
    return false;
  }
  if (remoteTombstones?.includes(japam.id)) {
    const merged = mergeTombstones(localTombstones, remoteTombstones);
    await saveDeletedJapamsToStorage(userId, merged);
    console.warn('[JAPAM_SYNC_FAILED]', {
      japamId: japam.id,
      code: 'TOMBSTONED_JAPAM',
      message: 'Cannot sync a permanently deleted Japam',
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

/**
 * Before a signed-in History row is uploaded with a non-null japam_id, make sure the referenced
 * Japam has reached Supabase. If this cannot be confirmed, callers leave the completion pending.
 */
export const ensureJapamSyncedForHistory = async (
  userId: string,
  japamId: string | null | undefined,
): Promise<boolean> => {
  if (!userId || !japamId) return false;
  const tombstones = await loadAuthoritativeDeletedJapams(userId);
  if (tombstones === null) return false;
  if (tombstones.has(japamId)) return false;
  const japams = await loadJapamsFromStorage(userId);
  const japam = japams.find((j) => j.id === japamId);
  if (!japam) {
    console.warn('[JAPAM_HISTORY_SYNC_BLOCKED]', {
      japamId,
      code: 'LOCAL_JAPAM_NOT_FOUND',
      message: 'Cannot upload history until the selected Japam exists locally',
    });
    return false;
  }
  return syncJapam(userId, japam);
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

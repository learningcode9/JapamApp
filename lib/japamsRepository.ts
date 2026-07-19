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
  normalizeJapamName,
  type Japam,
} from './japams';
import {
  loadJapams as loadJapamsFromStorage,
  saveJapams as saveJapamsToStorage,
  loadCurrentJapamId as loadCurrentJapamIdFromStorage,
  saveCurrentJapamId as saveCurrentJapamIdToStorage,
} from './japamsStorage';
import { supabase } from './supabase';

type RemoteJapamRow = {
  id?: string;
  user_id?: string;
  name?: string;
  display_order?: number | null;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
};

type SyncContext = {
  url: string;
  key: string;
  sessionToken: string;
};

type JapamSyncOutcome = 'synced' | 'pending' | 'failed';

const getSyncContext = async (userId: string | null | undefined): Promise<SyncContext | null> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!userId || !url || !key) return null;
  const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
  if (!sessionToken) return null;
  return { url, key, sessionToken };
};

const toTimestamp = (value?: string | null): number => {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const mapRemoteJapam = (row: RemoteJapamRow): Japam | null => {
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.user_id !== 'string' || row.user_id.length === 0) return null;
  const name = normalizeJapamName(row.name);
  if (name === null) return null;
  const createdAt = typeof row.created_at === 'string' ? row.created_at : new Date().toISOString();
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : createdAt;
  return {
    id: row.id,
    userId: row.user_id,
    name,
    syncStatus: 'synced',
    displayOrder: typeof row.display_order === 'number' && Number.isFinite(row.display_order)
      ? row.display_order
      : null,
    createdAt,
    updatedAt,
    archivedAt: typeof row.archived_at === 'string' ? row.archived_at : null,
  };
};

const toRemoteJapamPayload = (japam: Japam, userId: string): RemoteJapamRow => ({
  id: japam.id,
  user_id: userId,
  name: japam.name,
  display_order: japam.displayOrder,
  created_at: japam.createdAt,
  updated_at: japam.updatedAt,
  archived_at: japam.archivedAt,
});

const replaceJapam = (japams: Japam[], next: Japam): Japam[] =>
  japams.map((j) => (j.id === next.id ? next : j));

const mergeLocalAndRemoteJapams = (local: Japam[], remote: Japam[]): Japam[] => {
  const remoteById = new Map(remote.map((j) => [j.id, j]));
  const seen = new Set<string>();
  const merged: Japam[] = [];

  for (const localJapam of local) {
    const remoteJapam = remoteById.get(localJapam.id);
    if (!remoteJapam) {
      merged.push(localJapam);
      seen.add(localJapam.id);
      continue;
    }
    seen.add(localJapam.id);
    const keepLocal = localJapam.syncStatus !== 'synced'
      || toTimestamp(localJapam.updatedAt) > toTimestamp(remoteJapam.updatedAt);
    merged.push(keepLocal ? localJapam : remoteJapam);
  }

  for (const remoteJapam of remote) {
    if (!seen.has(remoteJapam.id)) merged.push(remoteJapam);
  }

  return merged;
};

const fetchRemoteJapams = async (
  userId: string,
  ctx: SyncContext,
): Promise<Japam[] | null> => {
  try {
    const query = new URLSearchParams({
      user_id: `eq.${userId}`,
      select: 'id,user_id,name,display_order,created_at,updated_at,archived_at',
      order: 'created_at.asc',
    });
    const response = await fetch(`${ctx.url}/rest/v1/japams?${query.toString()}`, {
      headers: {
        apikey: ctx.key,
        Authorization: `Bearer ${ctx.sessionToken}`,
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      console.log('[JAPAM_SYNC_FETCH_FAILED] status=%d', response.status);
      return null;
    }
    const rows: RemoteJapamRow[] = await response.json();
    return rows.map(mapRemoteJapam).filter((j): j is Japam => j !== null);
  } catch {
    console.log('[JAPAM_SYNC_FETCH_FAILED] reason=network');
    return null;
  }
};

const upsertRemoteJapam = async (
  userId: string,
  japam: Japam,
  ctx: SyncContext,
): Promise<JapamSyncOutcome> => {
  try {
    const response = await fetch(`${ctx.url}/rest/v1/japams?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ctx.key,
        Authorization: `Bearer ${ctx.sessionToken}`,
        Prefer: 'return=representation,resolution=merge-duplicates',
      },
      body: JSON.stringify(toRemoteJapamPayload(japam, userId)),
    });
    if (!response.ok) {
      console.log('[JAPAM_SYNC_UPSERT_FAILED] japamId=%s status=%d', japam.id, response.status);
      return 'failed';
    }
    const rows: RemoteJapamRow[] = await response.json();
    return rows.some((row) => row.id === japam.id) ? 'synced' : 'failed';
  } catch {
    console.log('[JAPAM_SYNC_UPSERT_FAILED] japamId=%s reason=network', japam.id);
    return 'pending';
  }
};

const syncLocalJapam = async (
  userId: string,
  japam: Japam,
  ctx?: SyncContext | null,
): Promise<JapamSyncOutcome> => {
  const authContext = ctx ?? await getSyncContext(userId);
  if (!authContext) return 'pending';
  return upsertRemoteJapam(userId, japam, authContext);
};

const syncTargetsForStartup = (local: Japam[], remote: Japam[]): Japam[] => {
  const remoteIds = new Set(remote.map((j) => j.id));
  return local.filter((j) => Boolean(j.userId) && (j.syncStatus !== 'synced' || !remoteIds.has(j.id)));
};

const saveJapamsWithSyncStatus = async (
  userId: string | null | undefined,
  japams: Japam[],
): Promise<void> => {
  await saveJapamsToStorage(userId, japams);
};

export const loadJapams = async (userId: string | null | undefined): Promise<Japam[]> => {
  const local = await loadJapamsFromStorage(userId);
  const ctx = await getSyncContext(userId);
  if (!userId || !ctx) return local;

  const remote = await fetchRemoteJapams(userId, ctx);
  if (remote === null) return local;

  let merged = mergeLocalAndRemoteJapams(local, remote);
  let mutated = JSON.stringify(merged) !== JSON.stringify(local);

  for (const target of syncTargetsForStartup(merged, remote)) {
    const outcome = await syncLocalJapam(userId, target, ctx);
    const nextStatus = outcome === 'synced' ? 'synced' : outcome === 'failed' ? 'failed' : 'pending';
    if (target.syncStatus !== nextStatus) {
      merged = replaceJapam(merged, { ...target, syncStatus: nextStatus });
      mutated = true;
    }
  }

  if (mutated) {
    await saveJapamsWithSyncStatus(userId, merged);
  }

  return merged;
};

export const saveJapams = (userId: string | null | undefined, japams: Japam[]): Promise<void> =>
  saveJapamsWithSyncStatus(userId, japams);

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
  let updated = [...existing, created];
  await saveJapamsWithSyncStatus(userId, updated);

  if (userId) {
    const outcome = await syncLocalJapam(userId, created);
    if (outcome !== created.syncStatus) {
      const syncedCreated = { ...created, syncStatus: outcome };
      updated = replaceJapam(updated, syncedCreated);
      await saveJapamsWithSyncStatus(userId, updated);
      return { created: syncedCreated, japams: updated };
    }
  }

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
  let updated = existing.map((j) => (j.id === japamId ? renamed : j));
  await saveJapamsWithSyncStatus(userId, updated);

  if (userId) {
    const outcome = await syncLocalJapam(userId, renamed);
    if (outcome !== renamed.syncStatus) {
      updated = replaceJapam(updated, { ...renamed, syncStatus: outcome });
      await saveJapamsWithSyncStatus(userId, updated);
    }
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
  let updated = existing.map((j) => (j.id === japamId ? archived : j));
  await saveJapamsWithSyncStatus(userId, updated);

  if (userId) {
    const outcome = await syncLocalJapam(userId, archived);
    if (outcome !== archived.syncStatus) {
      updated = replaceJapam(updated, { ...archived, syncStatus: outcome });
      await saveJapamsWithSyncStatus(userId, updated);
    }
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
  let updated = existing.map((j) => (j.id === japamId ? restored : j));
  await saveJapamsWithSyncStatus(userId, updated);

  if (userId) {
    const outcome = await syncLocalJapam(userId, restored);
    if (outcome !== restored.syncStatus) {
      updated = replaceJapam(updated, { ...restored, syncStatus: outcome });
      await saveJapamsWithSyncStatus(userId, updated);
    }
  }

  return updated;
};

export const ensureRemoteJapamExists = async (
  userId: string | null | undefined,
  japamId: string | null | undefined,
): Promise<boolean> => {
  if (!userId) return false;
  if (!japamId) return true;
  const local = await loadJapamsFromStorage(userId);
  const target = local.find((j) => j.id === japamId);
  if (!target) {
    console.log('[JAPAM_SYNC_SKIPPED] japamId=%s reason=missing-local-japam', japamId);
    return false;
  }
  const outcome = await syncLocalJapam(userId, target);
  const nextStatus = outcome === 'synced' ? 'synced' : outcome === 'failed' ? 'failed' : 'pending';
  if (target.syncStatus !== nextStatus) {
    await saveJapamsWithSyncStatus(userId, replaceJapam(local, { ...target, syncStatus: nextStatus }));
  }
  return outcome === 'synced';
};

export const loadCurrentJapamId = (userId: string | null | undefined): Promise<string | null> =>
  loadCurrentJapamIdFromStorage(userId);

export const saveCurrentJapamId = (
  userId: string | null | undefined,
  japamId: string | null,
): Promise<void> => saveCurrentJapamIdToStorage(userId, japamId);

/**
 * AsyncStorage read/write helpers for Japam Workspaces.
 *
 * This is the thin data-access layer between lib/japams.ts (pure, dependency-free storage
 * shapes/logic) and CurrentJapamContext. It intentionally contains no business logic of its own:
 * all validation/fallback behavior lives in parseStoredJapams, which is fully unit-tested in plain
 * Node. These functions are just I/O, matching how lib/historyStore.ts and the earlier
 * lib/japamSlotsStorage.ts keep AsyncStorage calls in a thin layer around pure functions.
 *
 * Guest (userId null/undefined) Japams and their current-selection are stored under the 'guest'
 * key and never touch the network — nothing in this file calls Supabase. Signed-in users' Japams
 * currently use this same local-only path too; Supabase sync is a separate, later step, not part
 * of this commit.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseStoredJapams, type Japam } from './japams';

const USER_JAPAMS_KEY = 'userJapams';
const CURRENT_JAPAM_ID_KEY = 'currentJapamId';

export const userJapamsStorageKey = (userId: string | null | undefined): string =>
  `${USER_JAPAMS_KEY}:${userId || 'guest'}`;

export const currentJapamIdStorageKey = (userId: string | null | undefined): string =>
  `${CURRENT_JAPAM_ID_KEY}:${userId || 'guest'}`;

/** Load this user's (or guest's) locally-cached Japams. Never touches the network. */
export const loadJapams = async (userId: string | null | undefined): Promise<Japam[]> => {
  try {
    const raw = await AsyncStorage.getItem(userJapamsStorageKey(userId));
    return parseStoredJapams(raw);
  } catch {
    // Storage read failed (rare, but AsyncStorage is not guaranteed) -- degrade to an empty list,
    // same as a first-time user with no Japams yet, never crash the caller.
    return [];
  }
};

/** Persist this user's (or guest's) Japams list locally. Never touches the network. */
export const saveJapams = async (
  userId: string | null | undefined,
  japams: Japam[],
): Promise<void> => {
  try {
    await AsyncStorage.setItem(userJapamsStorageKey(userId), JSON.stringify(japams));
  } catch {
    // Best-effort local cache write -- a failure here must not crash the create/rename/archive flow.
  }
};

/** Load the persisted "last selected Japam" id for this user (or guest), for auto-reopen on launch. */
export const loadCurrentJapamId = async (userId: string | null | undefined): Promise<string | null> => {
  try {
    const raw = await AsyncStorage.getItem(currentJapamIdStorageKey(userId));
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

/** Persist the currently-selected Japam id (or clear it when null) for this user (or guest). */
export const saveCurrentJapamId = async (
  userId: string | null | undefined,
  japamId: string | null,
): Promise<void> => {
  try {
    const key = currentJapamIdStorageKey(userId);
    if (japamId) {
      await AsyncStorage.setItem(key, japamId);
    } else {
      await AsyncStorage.removeItem(key);
    }
  } catch {
    // Best-effort -- a failure here just means the next launch won't auto-reopen correctly.
  }
};

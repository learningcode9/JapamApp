/**
 * AsyncStorage read/write helpers for the one-time legacy history backfill's per-identity
 * "already ran" flag.
 *
 * This is a thin data-access layer, same shape as lib/japamsStorage.ts: no business logic of its
 * own, just I/O. Whether a backfill is actually NEEDED (i.e. whether there's anything left to
 * reassign) is decided by lib/legacyHistoryBackfill.ts's planLegacyHistoryBackfill, which is
 * idempotent on its own -- this flag exists purely so an orchestration layer can skip even
 * *checking* history for a given identity on every launch once it already knows nothing is left to
 * do, not as the source of truth for correctness.
 *
 * Scoped by userId (or 'guest'), same convention as every other per-identity key in this app.
 * Nothing in this file touches the network.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const LEGACY_HISTORY_BACKFILL_COMPLETE_KEY = 'legacyHistoryBackfillComplete';

export const legacyHistoryBackfillCompleteStorageKey = (
  userId: string | null | undefined
): string => `${LEGACY_HISTORY_BACKFILL_COMPLETE_KEY}:${userId || 'guest'}`;

/** Has the legacy history backfill already run for this user (or guest)? */
export const isLegacyHistoryBackfillComplete = async (
  userId: string | null | undefined
): Promise<boolean> => {
  try {
    const raw = await AsyncStorage.getItem(legacyHistoryBackfillCompleteStorageKey(userId));
    return raw === 'true';
  } catch {
    // Storage read failed -- treat as "not yet run" so a future check can retry, rather than
    // silently skipping a legitimate backfill.
    return false;
  }
};

/** Mark the legacy history backfill as complete for this user (or guest). */
export const markLegacyHistoryBackfillComplete = async (
  userId: string | null | undefined
): Promise<void> => {
  try {
    await AsyncStorage.setItem(legacyHistoryBackfillCompleteStorageKey(userId), 'true');
  } catch {
    // Best-effort -- a failure here just means the next launch re-checks (safe: the backfill
    // itself is idempotent, so re-checking is harmless, just not free).
  }
};

/**
 * Shared helper for the Guest Mode -> Supabase Anonymous Auth migration (Phase 2A).
 *
 * Why this exists as one small module instead of inline per-screen logic: the riskiest piece of
 * this migration — branching between `linkIdentity` (anonymous -> Google) and `signInWithIdToken`
 * (direct Google sign-in), plus detecting the identity-already-linked collision — is otherwise
 * implemented independently three times (index.tsx, tap-japam.tsx, timer.tsx). Writing it once
 * here and having each screen call it removes that duplication risk. Nothing in this module
 * changes screen UI/flow; screens still own googleUserId extraction, AsyncStorage writes for
 * USER_ID_KEY/USER_NAME_KEY, and history migration/restore.
 */
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { waitForRecoveryToSettleBeforeInteractiveLogin } from './authRecoveryGate';

export const USER_ID_KEY = 'userId';
export const IS_ANONYMOUS_KEY = 'isAnonymousUser';
// TEMPORARY BRIDGE KEY — remove once db/migrate_numeric_user_ids_to_uuid.sql has been run and its
// post-verification query confirms zero mappable numeric-id rows remain (see that file's header).
// Holds the pre-repair legacy numeric id so history fetch can dual-query it until the DB is clean.
export const LEGACY_USER_ID_KEY = 'legacyUserId';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * If a valid, non-anonymous Supabase session exists and its UUID differs from the
 * stored USER_ID_KEY (a legacy numeric Google subject id), repairs USER_ID_KEY to the
 * session's UUID, remembering the old id under LEGACY_USER_ID_KEY. No-ops for guests,
 * already-UUID ids, or when no session exists. Never touches history rows. Returns the
 * effective userId (repaired or unchanged).
 */
export async function repairLegacyStoredUserId(): Promise<string | null> {
  const storedUserId = await AsyncStorage.getItem(USER_ID_KEY);
  if (!storedUserId || UUID_RE.test(storedUserId)) return storedUserId;

  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const isAnonymous = !!(session?.user as { is_anonymous?: boolean } | undefined)?.is_anonymous;
  const sessionUserId = session?.user?.id;
  if (!sessionUserId || isAnonymous || !UUID_RE.test(sessionUserId) || sessionUserId === storedUserId) {
    return storedUserId;
  }

  await AsyncStorage.setItem(LEGACY_USER_ID_KEY, storedUserId);
  await AsyncStorage.setItem(USER_ID_KEY, sessionUserId);
  console.log('[LEGACY_IDENTITY_UPGRADED] from=%s to=%s', storedUserId, sessionUserId);
  return sessionUserId;
}

/**
 * "Continue as Guest" entry point. On success, writes USER_ID_KEY (the new anonymous auth.uid())
 * and IS_ANONYMOUS_KEY, and returns isAnonymous: true. On failure (offline, or anonymous sign-ins
 * disabled), writes nothing and returns { userId: null, isAnonymous: false } — callers should fall
 * back to today's exact no-userId guest behavior in that case.
 */
export async function signInAsGuest(): Promise<{ userId: string | null; isAnonymous: boolean }> {
  try {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data?.user) {
      return { userId: null, isAnonymous: false };
    }
    const userId = data.user.id;
    await AsyncStorage.setItem(USER_ID_KEY, userId);
    await AsyncStorage.setItem(IS_ANONYMOUS_KEY, 'true');
    return { userId, isAnonymous: true };
  } catch {
    return { userId: null, isAnonymous: false };
  }
}

export async function getIsAnonymous(): Promise<boolean> {
  const value = await AsyncStorage.getItem(IS_ANONYMOUS_KEY);
  return value === 'true';
}

export async function setIsAnonymous(value: boolean): Promise<void> {
  await AsyncStorage.setItem(IS_ANONYMOUS_KEY, value ? 'true' : 'false');
}

export async function clearAnonymousFlag(): Promise<void> {
  await AsyncStorage.removeItem(IS_ANONYMOUS_KEY);
}

export type GoogleSignInResult =
  | { kind: 'linked' }
  | { kind: 'signedIn' }
  | { kind: 'collision' }
  | { kind: 'error'; error: unknown };

/**
 * Branches between linking Google to the current anonymous user and a direct Google sign-in,
 * based on the caller-supplied isAnonymous state (read by the caller via getIsAnonymous() or its
 * own in-memory state — kept explicit here rather than read internally, so this function stays
 * easy to unit test).
 */
export async function signInOrLinkGoogle(
  idToken: string,
  isAnonymous: boolean
): Promise<GoogleSignInResult> {
  try {
    if (isAnonymous) {
      const { error } = await supabase.auth.linkIdentity({ provider: 'google', token: idToken });
      if (error) {
        if ((error as { code?: string }).code === 'identity_already_exists') {
          return { kind: 'collision' };
        }
        return { kind: 'error', error };
      }
      return { kind: 'linked' };
    }

    await waitForRecoveryToSettleBeforeInteractiveLogin();
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error) {
      return { kind: 'error', error };
    }
    return { kind: 'signedIn' };
  } catch (error) {
    return { kind: 'error', error };
  }
}

/**
 * Approved collision UX (no merge, no silent failure — see GUEST_TO_ANON_AUTH_MIGRATION.md
 * Section 4.1): "Sign In" proceeds with a direct Google sign-in into the existing linked account;
 * "Cancel" leaves the current anonymous session untouched.
 */
export function showGoogleAccountCollisionDialog(onSignIn: () => void, onCancel?: () => void): void {
  Alert.alert(
    'Account already linked',
    'This Google account is already linked to another Japam account.',
    [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Sign In', onPress: onSignIn },
    ]
  );
}

/**
 * Migrates all AsyncStorage keys scoped by the legacy numeric userId to the new Supabase UUID
 * AFTER repairLegacyStoredUserId has upgraded USER_ID_KEY and stored the old id under
 * LEGACY_USER_ID_KEY.
 *
 * This is necessary because after identity repair:
 *   - userJapams:{oldId}, currentJapamId:{oldId}, and all timer-scoped keys
 *     ({key}:{oldId} and {key}:{oldId}:{japamId}) become orphaned
 *   - History records with userId === oldId become invisible to syncPendingHistory
 *     (which filters by r.userId === uid)
 *
 * Migration:
 *   1. Reads all AsyncStorage keys
 *   2. For each key containing :{oldId} (including :{oldId}: and :{oldId} at end),
 *      renames it to use {newId} in place of {oldId}
 *   3. Updates the userId field on pending history records
 */
export async function migrateScopedKeysAfterIdentityRepair(): Promise<void> {
  const oldId = await AsyncStorage.getItem(LEGACY_USER_ID_KEY);
  if (!oldId) return;

  const newId = await AsyncStorage.getItem(USER_ID_KEY);
  if (!newId || newId === oldId) return;

  // Step 1: rename all AsyncStorage keys scoped by oldId.
  // Never blindly overwrite an existing new-UUID key: merge JSON arrays
  // (userJapams), skip for scalars (preserve existing). Delete old key only
  // after the destination write succeeds.
  const renames: [string, string][] = [];
  const removals: string[] = [];
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const pattern = new RegExp(`(.*\\:)${escapeRegex(oldId)}(.*)`);
    for (const key of allKeys) {
      const match = key.match(pattern);
      if (match && key.includes(`:${oldId}`)) {
        const newKey = key.replace(`:${oldId}`, `:${newId}`);
        if (newKey !== key) {
          const value = await AsyncStorage.getItem(key);
          if (value !== null) {
            const existing = await AsyncStorage.getItem(newKey);
            if (existing !== null) {
              const merged = mergeScopedValuesForKey(newKey, value, existing);
              if (merged !== null) {
                renames.push([newKey, merged]);
              }
            } else {
              renames.push([newKey, value]);
            }
            removals.push(key);
          }
        }
      }
    }
    if (renames.length > 0) {
      await AsyncStorage.multiSet(renames);
    }
    if (removals.length > 0) {
      await AsyncStorage.multiRemove(removals);
    }
  } catch {
    // Non-fatal: scoped keys remain under oldId; sync may need retry
    return;
  }

  // Step 2: update userId field on pending history records
  try {
    const HISTORY_KEY = 'history';
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    if (raw) {
      const history: Record<string, unknown>[] = JSON.parse(raw);
      let changed = false;
      for (const rec of history) {
        if (rec.userId === oldId) {
          rec.userId = newId;
          changed = true;
        }
      }
      if (changed) {
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      }
    }
  } catch {
    // Non-fatal: pending records keep old userId; sync filter may miss them
  }

  // Step 3: update userId in timerPendingCompletions:v1 entries
  try {
    const PENDING_COMPLETIONS_KEY = 'timerPendingCompletions:v1';
    const raw = await AsyncStorage.getItem(PENDING_COMPLETIONS_KEY);
    if (raw) {
      const entries: Record<string, unknown>[] = JSON.parse(raw);
      let changed = false;
      for (const entry of entries) {
        if (entry.userId === oldId) {
          entry.userId = newId;
          changed = true;
        }
      }
      if (changed) {
        await AsyncStorage.setItem(PENDING_COMPLETIONS_KEY, JSON.stringify(entries));
      }
    }
  } catch {
    // Non-fatal: pending completions keep old userId; timer may re-enqueue
  }

  // Step 4: update timerSessionUserId values (bare key + scoped keys) that
  // still contain the legacy userId after the key rename above.
  try {
    const SESSION_USER_ID_KEY = 'timerSessionUserId';
    // Bare key
    const bareVal = await AsyncStorage.getItem(SESSION_USER_ID_KEY);
    if (bareVal === oldId) {
      await AsyncStorage.setItem(SESSION_USER_ID_KEY, newId);
    }
    // Scoped keys: timerSessionUserId:{newId} and timerSessionUserId:{newId}:{japamId}
    // After the rename above, these keys exist but their values may still be oldId.
    const allKeysAfterRename = await AsyncStorage.getAllKeys();
    for (const key of allKeysAfterRename) {
      if (key.startsWith(`${SESSION_USER_ID_KEY}:${newId}`)) {
        const val = await AsyncStorage.getItem(key);
        if (val === oldId) {
          await AsyncStorage.setItem(key, newId);
        }
      }
    }
  } catch {
    // Non-fatal: stale timerSessionUserId values; next timer session overwrites
  }

  // Step 5: update userId field on japam records inside userJapams:{newId}
  try {
    const japamKey = `userJapams:${newId}`;
    const japamRaw = await AsyncStorage.getItem(japamKey);
    if (japamRaw) {
      const japams: Record<string, unknown>[] = JSON.parse(japamRaw);
      let changed = false;
      for (const japam of japams) {
        if (japam.userId === oldId) {
          japam.userId = newId;
          changed = true;
        }
      }
      if (changed) {
        await AsyncStorage.setItem(japamKey, JSON.stringify(japams));
      }
    }
  } catch {
    // Non-fatal: stale userId fields; syncJapam retries on its own
  }

  console.log(
    '[SCOPED_KEYS_MIGRATED] oldId=%s newId=%s keysRenamed=%d historyRecordsUpdated=true',
    oldId, newId, renames.length
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collision-safe merge for scoped-key migration.
 *
 * - userJapams:{id} (JSON array): merges arrays, dedup by `id`, keeps existing order.
 * - All other keys (scalars): preserves existing value (returns null = skip rename).
 */
function mergeScopedValuesForKey(newKey: string, oldValue: string, existingValue: string): string | null {
  if (newKey.startsWith('userJapams:')) {
    try {
      const oldArr: Record<string, unknown>[] = JSON.parse(oldValue);
      const existingArr: Record<string, unknown>[] = JSON.parse(existingValue);
      const existingIds = new Set(existingArr.map((item) => item.id));
      const toAdd = oldArr.filter((item) => !existingIds.has(item.id));
      if (toAdd.length === 0) return existingValue;
      return JSON.stringify([...existingArr, ...toAdd]);
    } catch {
      return existingValue;
    }
  }
  return null;
}

/** True if a remote Supabase write should be suppressed: no userId at all, or an anonymous user. */
export function shouldSkipRemoteSync(userId: string | null | undefined, isAnonymous: boolean): boolean {
  return !userId || isAnonymous;
}

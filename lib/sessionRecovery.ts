import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { supabase } from './supabase';
import { getIsAnonymous, repairLegacyStoredUserId, migrateScopedKeysAfterIdentityRepair } from './anonymousAuth';
import {
  beginSessionRecovery,
  finishSessionRecovery,
  getRecoveryInFlight,
  isAuthGenerationCurrent,
  resetAuthRecoveryState,
  setRecoveryInFlight,
} from './authRecoveryGate';

const USER_ID_KEY = 'userId';

const isSameSession = (current: Session | null, candidate: Session | null | undefined): boolean =>
  !!current?.access_token &&
  !!candidate?.access_token &&
  current.access_token === candidate.access_token &&
  current.refresh_token === candidate.refresh_token &&
  current.user?.id === candidate.user?.id;

export {
  cancelSessionRecovery,
  getAuthGeneration,
  hasCancelledRecoveryInFlight,
  isAuthGenerationCurrent,
  waitForRecoveryToSettleBeforeInteractiveLogin,
} from './authRecoveryGate';

/**
 * Attempts to recover a lost Supabase auth session using silent Google sign-in.
 *
 * Evidence (from RKStorage on the failing device at inspection time):
 *   1. `userId` exists: `113789561834940779353` (Google numeric subject ID)
 *   2. No `sb-*-auth-token` key exists — the Supabase session is absent
 *   3. `signInWithIdToken` IS called during Android Google sign-in
 *      (`app/(tabs)/index.tsx:1439`), but the code only captures
 *      `authData?.user?.id` (never `authData.session`).
 *   4. The stored `userId` is a numeric Google ID, not a Supabase UUID.
 *
 *   Root cause: at inspection time the Supabase session was absent from
 *   AsyncStorage. Whether it was never created (most likely — the numeric
 *   userId suggests `signInWithIdToken` never returned a valid session
 *   during initial login) or was later removed is not determinable from
 *   the point-in-time RKStorage dump. Both scenarios are handled here:
 *   `signInSilently()` → fresh idToken → `signInWithIdToken()`.
 *
 * Safety properties:
 *   - Serialized via `recoveryInFlight`: concurrent callers share one
 *     in-flight promise (no duplicate Google API calls).
 *   - Requires `authData.session.access_token` to be non-null
 *     (not just `authData.user`).
 *   - Calls `repairLegacyStoredUserId()` after recovery to reconcile
 *     the stored `userId` with the Supabase session's `user.id`
 *     (upgrades legacy numeric IDs to UUIDs).
 *   - Calls `migrateScopedKeysAfterIdentityRepair()` to rename all
 *     AsyncStorage keys scoped by the old numeric userId to the new UUID,
 *     preventing orphaned userJapams, timer state, and history lookups.
 *   - Returns false without side effects for web, anonymous, or
 *     missing-userId users.
 */
export function recoverSessionIfNeeded(): Promise<boolean> {
  const currentRecovery = getRecoveryInFlight();
  if (currentRecovery) return currentRecovery;

  const recoveryGeneration = beginSessionRecovery();
  let recovery!: Promise<boolean>;
  recovery = (async (): Promise<boolean> => {
    try {
      const { data } = await supabase.auth.getSession();
      if (!isAuthGenerationCurrent(recoveryGeneration)) return false;
      if (data.session?.access_token) return true;

      if (Platform.OS === 'web') return false;

      const isAnon = await getIsAnonymous();
      if (!isAuthGenerationCurrent(recoveryGeneration)) return false;
      if (isAnon) return false;

      const uid = await AsyncStorage.getItem(USER_ID_KEY);
      if (!isAuthGenerationCurrent(recoveryGeneration)) return false;
      if (!uid) return false;

      GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
      });
      const userInfo = await GoogleSignin.signInSilently();
      if (!isAuthGenerationCurrent(recoveryGeneration)) return false;
      const idToken = userInfo?.data?.idToken;
      if (!idToken) return false;

      const { data: authData, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });
      if (!isAuthGenerationCurrent(recoveryGeneration)) {
        try {
          const { data: currentData } = await supabase.auth.getSession();
          if (isSameSession(currentData.session, authData?.session)) {
            await supabase.auth.signOut();
          }
        } catch {
          // The explicit logout already attempted signOut; do not disrupt a newer session.
        }
        return false;
      }
      if (error || !authData?.session?.access_token) return false;

      const repaired = await repairLegacyStoredUserId();
      if (!repaired) return false;

      await migrateScopedKeysAfterIdentityRepair();

      return true;
    } catch {
      return false;
    } finally {
      finishSessionRecovery(recoveryGeneration, recovery);
    }
  })();

  setRecoveryInFlight(recovery);
  return recovery;
}

/** Exposed for tests — clears any in-flight recovery promise. */
export function resetRecoveryState(): void {
  resetAuthRecoveryState();
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { supabase } from './supabase';
import { getIsAnonymous, repairLegacyStoredUserId } from './anonymousAuth';

const USER_ID_KEY = 'userId';

let recoveryInFlight: Promise<boolean> | null = null;

/**
 * Attempts to recover a lost Supabase auth session using silent Google sign-in.
 *
 * Evidence (from RKStorage on the failing device):
 *   1. `userId` exists: `113789561834940779353` (Google numeric subject ID)
 *   2. No `sb-*-auth-token` key exists — the Supabase session is absent
 *   3. `signInWithIdToken` IS called during Android Google sign-in
 *      (`app/(tabs)/index.tsx:1439`), but the code only captures
 *      `authData?.user?.id` (never `authData.session`).
 *   4. Because the stored `userId` is a numeric Google ID rather than a
 *      Supabase UUID, the `supabaseUuid ?? googleUserId` fallback
 *      (index.tsx:1454) resolved to `googleUserId` — meaning
 *      `signInWithIdToken` never returned a valid user+session during
 *      the initial Android sign-in for this user.
 *
 *   The session could have been absent since login (most likely, given
 *   the numeric userId) or created and later removed by GoTrue's
 *   auto-refresh failure path. Both scenarios are handled here:
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
 *   - Returns false without side effects for web, anonymous, or
 *     missing-userId users.
 */
export function recoverSessionIfNeeded(): Promise<boolean> {
  if (recoveryInFlight) return recoveryInFlight;

  recoveryInFlight = (async (): Promise<boolean> => {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) return true;

      if (Platform.OS === 'web') return false;

      const isAnon = await getIsAnonymous();
      if (isAnon) return false;

      const uid = await AsyncStorage.getItem(USER_ID_KEY);
      if (!uid) return false;

      GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
      });
      const userInfo = await GoogleSignin.signInSilently();
      const idToken = userInfo?.data?.idToken;
      if (!idToken) return false;

      const { data: authData, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });
      if (error || !authData?.session?.access_token) return false;

      const repaired = await repairLegacyStoredUserId();
      if (!repaired) return false;

      return true;
    } catch {
      return false;
    } finally {
      recoveryInFlight = null;
    }
  })();

  return recoveryInFlight;
}

/** Exposed for tests — clears any in-flight recovery promise. */
export function resetRecoveryState(): void {
  recoveryInFlight = null;
}

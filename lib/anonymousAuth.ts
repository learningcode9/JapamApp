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

export const USER_ID_KEY = 'userId';
export const IS_ANONYMOUS_KEY = 'isAnonymousUser';

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

/** True if a remote Supabase write should be suppressed: no userId at all, or an anonymous user. */
export function shouldSkipRemoteSync(userId: string | null | undefined, isAnonymous: boolean): boolean {
  return !userId || isAnonymous;
}

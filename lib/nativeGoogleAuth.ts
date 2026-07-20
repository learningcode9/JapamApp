import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';

type AuthSessionLike = {
  access_token?: string | null;
  refresh_token?: string | null;
  user?: {
    id?: string | null;
    is_anonymous?: boolean;
  } | null;
} | null | undefined;

type AuthUserLike = {
  id?: string | null;
} | null | undefined;

type NativeGoogleAuthSuccess = {
  ok: true;
  userId: string;
};

type NativeGoogleAuthFailure = {
  ok: false;
  reason: 'auth-error' | 'missing-session';
  error?: unknown;
};

type NativeGoogleAuthResult = NativeGoogleAuthSuccess | NativeGoogleAuthFailure;

function getValidGoogleSessionUserId(session: AuthSessionLike): string | null {
  const userId = session?.user?.id?.trim();
  if (!session?.access_token || !session?.refresh_token || !userId) {
    return null;
  }
  if (session.user?.is_anonymous) {
    return null;
  }
  return userId;
}

async function persistAuthenticatedIdentity(userId: string, userName: string, userEmail: string) {
  await AsyncStorage.setItem(USER_NAME_KEY, userName);
  if (userEmail) {
    await AsyncStorage.setItem(USER_EMAIL_KEY, userEmail);
  }
  await AsyncStorage.setItem(USER_ID_KEY, userId);
}

export async function signInWithGoogleIdTokenAndStoreIdentity(
  idToken: string,
  userName: string,
  userEmail: string
): Promise<NativeGoogleAuthResult> {
  try {
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });
    if (error) {
      return { ok: false, reason: 'auth-error', error };
    }

    const directUserId = getValidGoogleSessionUserId(data?.session as AuthSessionLike);
    if (directUserId) {
      await persistAuthenticatedIdentity(directUserId, userName, userEmail);
      return { ok: true, userId: directUserId };
    }

    const expectedUserId = (data?.user as AuthUserLike)?.id?.trim();
    if (!expectedUserId) {
      return { ok: false, reason: 'missing-session' };
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const restoredUserId = getValidGoogleSessionUserId(sessionData.session as AuthSessionLike);
    if (!restoredUserId || restoredUserId !== expectedUserId) {
      return { ok: false, reason: 'missing-session' };
    }

    await persistAuthenticatedIdentity(restoredUserId, userName, userEmail);
    return { ok: true, userId: restoredUserId };
  } catch (error) {
    return { ok: false, reason: 'auth-error', error };
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { AppState, DeviceEventEmitter, Platform } from 'react-native';
import { supabase } from './supabase';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const IS_ANONYMOUS_KEY = 'isAnonymousUser';
const LEGACY_USER_ID_KEY = 'legacyUserId';
const REFRESH_MARGIN_MS = 60_000;

export const AUTH_REQUIRED_MESSAGE = 'Your session expired. Please sign in again.';

export type AuthResolution =
  | { kind: 'AUTHENTICATED'; session: Session }
  | { kind: 'AUTH_REQUIRED' };

let recoveryPromise: Promise<AuthResolution> | null = null;
let lifecycleStop: (() => void) | null = null;
let lifecycleReady: Promise<AuthResolution> | null = null;
let lifecycleUsers = 0;
let sessionExpired = false;

const isAuthenticatedSession = (session: Session | null): session is Session =>
  !!session?.access_token &&
  !!session.refresh_token &&
  !!session.user?.id &&
  !session.user.is_anonymous;

const emitAuthUpdated = () => {
  DeviceEventEmitter.emit('japam-auth-updated');
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('japam-auth-updated'));
  }
};

export async function clearCachedIdentity(): Promise<void> {
  await AsyncStorage.multiRemove([
    USER_ID_KEY,
    USER_NAME_KEY,
    USER_EMAIL_KEY,
    IS_ANONYMOUS_KEY,
    LEGACY_USER_ID_KEY,
  ]);
}

async function clearStaleCachedIdentity(): Promise<void> {
  const cached = await AsyncStorage.multiGet([USER_ID_KEY, USER_NAME_KEY]);
  if (!cached[0][1] && !cached[1][1]) return;
  sessionExpired = true;
  await clearCachedIdentity();
  emitAuthUpdated();
}

async function persistAuthenticatedIdentity(session: Session): Promise<void> {
  if (!isAuthenticatedSession(session)) return;
  sessionExpired = false;
  const metadata = session.user.user_metadata as { given_name?: string; full_name?: string; name?: string; email?: string } | undefined;
  const userName = metadata?.given_name || metadata?.full_name || metadata?.name || metadata?.email || 'User';
  const entries: [string, string][] = [[USER_ID_KEY, session.user.id]];
  if (userName) entries.push([USER_NAME_KEY, userName]);
  if (session.user.email) entries.push([USER_EMAIL_KEY, session.user.email]);
  await AsyncStorage.multiSet(entries);
  await AsyncStorage.removeItem(IS_ANONYMOUS_KEY);
}

export function getAuthRequiredMessage(): string {
  return sessionExpired ? AUTH_REQUIRED_MESSAGE : '';
}

export function resolveAuthenticatedSession(): Promise<AuthResolution> {
  if (recoveryPromise) return recoveryPromise;

  const recovery = (async (): Promise<AuthResolution> => {
    const { data, error } = await supabase.auth.getSession();
    let session = data.session;

    if (error || !isAuthenticatedSession(session)) {
      if (!session?.user?.is_anonymous) await clearStaleCachedIdentity();
      return { kind: 'AUTH_REQUIRED' };
    }

    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
    if (expiresAt > 0 && expiresAt - Date.now() <= REFRESH_MARGIN_MS) {
      const refreshed = await supabase.auth.refreshSession();
      session = refreshed.data.session;
      if (refreshed.error || !isAuthenticatedSession(session)) {
        await clearStaleCachedIdentity();
        return { kind: 'AUTH_REQUIRED' };
      }
    }

    await persistAuthenticatedIdentity(session);
    return { kind: 'AUTHENTICATED', session };
  })().finally(() => {
    recoveryPromise = null;
  });

  recoveryPromise = recovery;
  return recovery;
}

export function startAuthLifecycle(): { ready: Promise<AuthResolution>; stop: () => void } {
  lifecycleUsers += 1;

  if (!lifecycleStop) {
    const authSubscription = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
        void persistAuthenticatedIdentity(session).then(emitAuthUpdated);
      } else if (event === 'SIGNED_OUT') {
        sessionExpired = false;
        void clearCachedIdentity().then(emitAuthUpdated);
      }
    }).data.subscription;

    let appStateSubscription: { remove: () => void } | null = null;
    if (Platform.OS !== 'web') {
      appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void supabase.auth.startAutoRefresh().then(resolveAuthenticatedSession);
        } else {
          void supabase.auth.stopAutoRefresh();
        }
      });
    }

    lifecycleReady = (async () => {
      if (Platform.OS !== 'web' && AppState.currentState === 'active') {
        await supabase.auth.startAutoRefresh();
      }
      return resolveAuthenticatedSession();
    })();

    lifecycleStop = () => {
      appStateSubscription?.remove();
      authSubscription.unsubscribe();
      if (Platform.OS !== 'web') void supabase.auth.stopAutoRefresh();
      lifecycleStop = null;
      lifecycleReady = null;
    };
  }

  let stopped = false;
  return {
    ready: lifecycleReady!,
    stop: () => {
      if (stopped) return;
      stopped = true;
      lifecycleUsers -= 1;
      if (lifecycleUsers === 0) lifecycleStop?.();
    },
  };
}

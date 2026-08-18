import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { addEventListener as addNetInfoEventListener } from '@react-native-community/netinfo';
import { AppState, DeviceEventEmitter, Platform } from 'react-native';
import {
  getAuthGeneration,
  hasCancelledRecoveryInFlight,
  isAuthGenerationCurrent,
  recoverSessionIfNeeded,
} from './sessionRecovery';
import { supabase } from './supabase';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const IS_ANONYMOUS_KEY = 'isAnonymousUser';
const LEGACY_USER_ID_KEY = 'legacyUserId';
const REFRESH_MARGIN_MS = 60_000;

export const AUTH_REQUIRED_MESSAGE = 'Your session expired. Please sign in again.';

export type AuthResolution =
  | { kind: 'AUTHENTICATED'; session?: Session }
  | { kind: 'AUTH_REQUIRED' };

let recoveryPromise: Promise<AuthResolution> | null = null;
let networkResolutionPromise: Promise<AuthResolution> | null = null;
let networkResolutionGeneration = 0;
let lifecycleStop: (() => void) | null = null;
let lifecycleReady: Promise<AuthResolution> | null = null;
let lifecycleUsers = 0;
let sessionExpired = false;

type AuthErrorLike = {
  code?: string;
  message?: string;
  name?: string;
  status?: number;
};

const asAuthError = (error: unknown): AuthErrorLike =>
  error && typeof error === 'object' ? error as AuthErrorLike : {};

/** Network failures are recoverable and must never invalidate app-owned identity state. */
export function isNetworkAuthError(error: unknown): boolean {
  const { code, message, name, status } = asAuthError(error);
  const text = `${code || ''} ${message || ''} ${name || ''}`.toLowerCase();
  return (
    name === 'AuthRetryableFetchError' ||
    name === 'AbortError' ||
    status === 0 ||
    status === 429 ||
    status !== undefined && status >= 500 ||
    /network|offline|fetch|timeout|timed out|abort|connection|internet|dns|econn|enet|eai_again|unreachable/.test(text)
  );
}

/** Only explicit auth rejection signals may clear a cached signed-in identity. */
export function isDefinitiveAuthFailure(error: unknown): boolean {
  if (isNetworkAuthError(error)) return false;
  const { code, message, name, status } = asAuthError(error);
  const text = `${code || ''} ${message || ''} ${name || ''}`.toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    /invalid_grant|refresh.?token.*(invalid|not found|expired|revoked)|token.*(invalid|revoked)|user.*(not found|disabled|banned)|session.*(invalid|revoked)/.test(text) ||
    status === 400 && /authapierror|refresh|token|session/.test(text)
  );
}

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

async function clearStaleCachedIdentity(expectedUserId?: string | null): Promise<boolean> {
  const cached = await AsyncStorage.multiGet([USER_ID_KEY, USER_NAME_KEY]);
  const cachedUserId = cached[0][1];
  if ((!cachedUserId && !cached[1][1]) || expectedUserId !== undefined && cachedUserId !== expectedUserId) {
    return false;
  }
  sessionExpired = true;
  await clearCachedIdentity();
  emitAuthUpdated();
  return true;
}

async function persistAuthenticatedIdentity(session: Session): Promise<void> {
  if (!isAuthenticatedSession(session)) return;
  sessionExpired = false;
  const metadata = session.user.user_metadata as { full_name?: string; name?: string } | undefined;
  const userName = metadata?.full_name || metadata?.name;
  const entries: [string, string][] = [[USER_ID_KEY, session.user.id]];
  if (userName) entries.push([USER_NAME_KEY, userName]);
  if (session.user.email) entries.push([USER_EMAIL_KEY, session.user.email]);
  await AsyncStorage.multiSet(entries);
  await AsyncStorage.removeItem(IS_ANONYMOUS_KEY);
}

export function getAuthRequiredMessage(): string {
  return sessionExpired ? AUTH_REQUIRED_MESSAGE : '';
}

const authenticatedWithoutNetwork = (): AuthResolution => ({ kind: 'AUTHENTICATED' });

const requiredOrCachedAuthentication = (cachedUserId: string | null): AuthResolution =>
  cachedUserId ? authenticatedWithoutNetwork() : { kind: 'AUTH_REQUIRED' };

const invalidateCachedAuthentication = async (
  cachedUserId: string | null,
  attemptGeneration: number,
): Promise<AuthResolution> => {
  if (!cachedUserId) return { kind: 'AUTH_REQUIRED' };
  if (attemptGeneration !== networkResolutionGeneration) return authenticatedWithoutNetwork();
  const cleared = await clearStaleCachedIdentity(cachedUserId);
  return cleared ? { kind: 'AUTH_REQUIRED' } : authenticatedWithoutNetwork();
};

const runWithAuthTimeout = async <T>(operation: Promise<T>): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('Auth network request timed out');
      error.name = 'AuthNetworkTimeoutError';
      reject(error);
    }, 5_000);
    (timeoutId as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const resolveAuthenticatedSessionNetwork = (
  cachedUserId: string | null,
  force = false,
): Promise<AuthResolution> => {
  if (force) {
    networkResolutionGeneration += 1;
    networkResolutionPromise = null;
  } else if (networkResolutionPromise) {
    return networkResolutionPromise;
  }
  const attemptGeneration = networkResolutionGeneration;
  const authAttemptGeneration = getAuthGeneration();
  const isAttemptCurrent = () =>
    attemptGeneration === networkResolutionGeneration && isAuthGenerationCurrent(authAttemptGeneration);

  const networkResolution = (async (): Promise<AuthResolution> => {
    let response: Awaited<ReturnType<typeof supabase.auth.getSession>>;
    try {
      response = await runWithAuthTimeout(supabase.auth.getSession());
    } catch (error) {
      if (!isAuthGenerationCurrent(authAttemptGeneration)) return requiredOrCachedAuthentication(cachedUserId);
      return isDefinitiveAuthFailure(error)
        ? invalidateCachedAuthentication(cachedUserId, attemptGeneration)
        : requiredOrCachedAuthentication(cachedUserId);
    }
    if (!isAttemptCurrent()) return requiredOrCachedAuthentication(cachedUserId);

    let session = response.data.session;
    if (response.error) {
      if (!isAuthGenerationCurrent(authAttemptGeneration)) return requiredOrCachedAuthentication(cachedUserId);
      return isDefinitiveAuthFailure(response.error)
        ? invalidateCachedAuthentication(cachedUserId, attemptGeneration)
        : requiredOrCachedAuthentication(cachedUserId);
    }

    const sessionIsAnonymous = !!(session?.user as { is_anonymous?: boolean } | undefined)?.is_anonymous;
    if (!isAuthenticatedSession(session)) {
      if (sessionIsAnonymous) return { kind: 'AUTH_REQUIRED' };

      // A missing local Supabase session can be repaired for legacy Google identities. A
      // network error or clean absence during that repair is recoverable; only a definitive
      // auth rejection reaches stale-identity cleanup.
      if (cachedUserId && isAttemptCurrent() && await recoverSessionIfNeeded()) {
        if (!isAttemptCurrent()) return requiredOrCachedAuthentication(cachedUserId);
        try {
          response = await runWithAuthTimeout(supabase.auth.getSession());
        } catch (error) {
          if (!isAuthGenerationCurrent(authAttemptGeneration)) return requiredOrCachedAuthentication(cachedUserId);
          return isDefinitiveAuthFailure(error)
            ? invalidateCachedAuthentication(cachedUserId, attemptGeneration)
            : requiredOrCachedAuthentication(cachedUserId);
        }
        if (!isAttemptCurrent()) return requiredOrCachedAuthentication(cachedUserId);
        session = response.data.session;
        if (response.error) {
          if (!isAuthGenerationCurrent(authAttemptGeneration)) return requiredOrCachedAuthentication(cachedUserId);
          return isDefinitiveAuthFailure(response.error)
            ? invalidateCachedAuthentication(cachedUserId, attemptGeneration)
            : requiredOrCachedAuthentication(cachedUserId);
        }
      }

      if (!isAuthenticatedSession(session)) {
        // A cleanly absent session is not proof that the cached app identity is invalid. The
        // local-only authenticated state remains usable until reconnect can retry recovery.
        return requiredOrCachedAuthentication(cachedUserId);
      }
    }

    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
    if (expiresAt > 0 && expiresAt - Date.now() <= REFRESH_MARGIN_MS) {
      let refreshed: Awaited<ReturnType<typeof supabase.auth.refreshSession>>;
      try {
        refreshed = await runWithAuthTimeout(supabase.auth.refreshSession());
      } catch (error) {
        if (!isAuthGenerationCurrent(authAttemptGeneration)) return requiredOrCachedAuthentication(cachedUserId);
        return isDefinitiveAuthFailure(error)
          ? invalidateCachedAuthentication(cachedUserId, attemptGeneration)
          : requiredOrCachedAuthentication(cachedUserId);
      }
      if (!isAttemptCurrent()) return requiredOrCachedAuthentication(cachedUserId);
      if (refreshed.error) {
        if (!isAuthGenerationCurrent(authAttemptGeneration)) return requiredOrCachedAuthentication(cachedUserId);
        return isDefinitiveAuthFailure(refreshed.error)
          ? invalidateCachedAuthentication(cachedUserId, attemptGeneration)
          : requiredOrCachedAuthentication(cachedUserId);
      }
      session = refreshed.data.session;
      if (!isAuthenticatedSession(session)) {
        // A refresh that returns no session without an auth error is inconclusive offline.
        return requiredOrCachedAuthentication(cachedUserId);
      }
    }

    if (!isAttemptCurrent()) return requiredOrCachedAuthentication(cachedUserId);
    await persistAuthenticatedIdentity(session);
    return { kind: 'AUTHENTICATED', session };
  })().finally(() => {
    if (networkResolutionPromise === networkResolution) networkResolutionPromise = null;
  });

  networkResolutionPromise = networkResolution;
  return networkResolution;
};

export function resolveAuthenticatedSession(forceNetworkRefresh = false): Promise<AuthResolution> {
  if (recoveryPromise) return recoveryPromise;

  const recovery = (async (): Promise<AuthResolution> => {
    const [cachedUserId, isAnonymous] = await Promise.all([
      AsyncStorage.getItem(USER_ID_KEY),
      AsyncStorage.getItem(IS_ANONYMOUS_KEY),
    ]);

    if (cachedUserId && isAnonymous !== 'true') {
      // The render gate is app-owned local state. Supabase may refresh in the background, but
      // it cannot make an offline user wait or clear their local workspace on failure.
      void resolveAuthenticatedSessionNetwork(cachedUserId, forceNetworkRefresh).catch(() => {});
      return authenticatedWithoutNetwork();
    }

    if (cachedUserId && isAnonymous === 'true') return { kind: 'AUTH_REQUIRED' };
    return resolveAuthenticatedSessionNetwork(null, forceNetworkRefresh);
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
        if (hasCancelledRecoveryInFlight()) return;
        void persistAuthenticatedIdentity(session).then(emitAuthUpdated);
      } else if (event === 'SIGNED_OUT') {
        // Explicit logout clears app-owned identity before calling Supabase. For a remote or
        // automatic sign-out, re-check the session first so a transient auth/network failure
        // cannot erase local identity and make screens bounce to logged-out state.
        void AsyncStorage.getItem(USER_ID_KEY).then((cachedUserId) => {
          if (!cachedUserId) {
            sessionExpired = false;
            return;
          }
          return resolveAuthenticatedSessionNetwork(cachedUserId).catch(() => {});
        });
      }
    }).data.subscription;

    let appStateSubscription: { remove: () => void } | null = null;
    let networkSubscription: (() => void) | null = null;
    if (Platform.OS !== 'web') {
      appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void supabase.auth.startAutoRefresh().then(() => resolveAuthenticatedSession(true)).catch(() => {});
        } else {
          void supabase.auth.stopAutoRefresh();
        }
      });
      let wasConnected: boolean | null = null;
      networkSubscription = addNetInfoEventListener((state) => {
        const isConnected = state.isConnected === true && state.isInternetReachable !== false;
        const reconnected = wasConnected === false && isConnected;
        wasConnected = isConnected;
        if (!reconnected) return;
        void supabase.auth.startAutoRefresh().then(() => resolveAuthenticatedSession(true)).catch(() => {});
      });
    } else if (typeof window !== 'undefined') {
      const onOnline = () => {
        void resolveAuthenticatedSession(true).catch(() => {});
      };
      window.addEventListener('online', onOnline);
      networkSubscription = () => window.removeEventListener('online', onOnline);
    }

    lifecycleReady = (async () => {
      if (Platform.OS !== 'web' && AppState.currentState === 'active') {
        void supabase.auth.startAutoRefresh().catch(() => {});
      }
      return resolveAuthenticatedSession();
    })();

    lifecycleStop = () => {
      appStateSubscription?.remove();
      networkSubscription?.();
      authSubscription.unsubscribe();
      networkResolutionGeneration += 1;
      networkResolutionPromise = null;
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

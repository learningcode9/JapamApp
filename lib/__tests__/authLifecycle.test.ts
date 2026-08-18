import {
  cancelSessionRecovery,
  hasCancelledRecoveryInFlight,
  isAuthGenerationCurrent,
  recoverSessionIfNeeded,
} from '../sessionRecovery';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: (callback: (state: { isConnected: boolean; isInternetReachable: boolean | null }) => void) => {
    netInfoCallback = callback;
    return jest.fn();
  },
}));

jest.mock('../sessionRecovery', () => ({
  recoverSessionIfNeeded: jest.fn().mockResolvedValue(false),
  cancelSessionRecovery: jest.fn(),
  getAuthGeneration: jest.fn(() => 0),
  hasCancelledRecoveryInFlight: jest.fn(() => false),
  isAuthGenerationCurrent: jest.fn(() => true),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    signOut: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockGetSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockStartAutoRefresh = jest.fn();
const mockStopAutoRefresh = jest.fn();
const mockSignOut = jest.fn();
const mockUnsubscribe = jest.fn();
let authStateCallback: ((event: string, session: any) => void) | null = null;
let appStateCallback: ((state: string) => void) | null = null;
let netInfoCallback: ((state: { isConnected: boolean; isInternetReachable: boolean | null }) => void) | null = null;

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
      startAutoRefresh: (...args: unknown[]) => mockStartAutoRefresh(...args),
      stopAutoRefresh: (...args: unknown[]) => mockStopAutoRefresh(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
      onAuthStateChange: (callback: (event: string, session: any) => void) => {
        authStateCallback = callback;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      },
    },
  },
}));

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn((_event: string, callback: (state: string) => void) => {
      appStateCallback = callback;
      return { remove: jest.fn() };
    }),
  },
  DeviceEventEmitter: { emit: jest.fn() },
  Platform: { OS: 'android' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { clearCachedIdentity, resolveAuthenticatedSession, startAuthLifecycle } from '../authLifecycle';
import { runSharedLogoutFlow } from '../sharedLogout';

const mockRecoverSessionIfNeeded = recoverSessionIfNeeded as jest.Mock;
const mockCancelSessionRecovery = cancelSessionRecovery as jest.Mock;
const mockHasCancelledRecoveryInFlight = hasCancelledRecoveryInFlight as jest.Mock;
const mockIsAuthGenerationCurrent = isAuthGenerationCurrent as jest.Mock;

const session = (expiresAt = Math.floor(Date.now() / 1000) + 3600) => ({
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: expiresAt,
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: 'user-123',
    email: 'user@example.com',
    is_anonymous: false,
    user_metadata: { full_name: 'Test User' },
  },
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  authStateCallback = null;
  appStateCallback = null;
  netInfoCallback = null;
  mockGetSession.mockResolvedValue({ data: { session: session() }, error: null });
  mockRefreshSession.mockResolvedValue({ data: { session: session() }, error: null });
  mockStartAutoRefresh.mockResolvedValue(undefined);
  mockStopAutoRefresh.mockResolvedValue(undefined);
  mockSignOut.mockResolvedValue({ error: null });
  mockHasCancelledRecoveryInFlight.mockReturnValue(false);
  mockIsAuthGenerationCurrent.mockReturnValue(true);
});

describe('React Native Supabase auth lifecycle', () => {
  it('starts auto refresh when AppState becomes active', async () => {
    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    mockStartAutoRefresh.mockClear();

    appStateCallback?.('active');
    await flush();

    expect(mockStartAutoRefresh).toHaveBeenCalledTimes(1);
    lifecycle.stop();
  });

  it('stops auto refresh when AppState becomes background', async () => {
    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    mockStopAutoRefresh.mockClear();

    appStateCallback?.('background');
    await flush();

    expect(mockStopAutoRefresh).toHaveBeenCalledTimes(1);
    lifecycle.stop();
  });

  it('refreshes a session once when it is close to expiry', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: session(Math.floor(Date.now() / 1000) + 30) },
      error: null,
    });

    const result = await resolveAuthenticatedSession();

    expect(result.kind).toBe('AUTHENTICATED');
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent foreground recovery attempts', async () => {
    let finishGetSession!: (value: unknown) => void;
    mockGetSession.mockImplementation(() => new Promise((resolve) => {
      finishGetSession = resolve;
    }));

    const lifecycle = startAuthLifecycle();
    appStateCallback?.('active');
    appStateCallback?.('active');
    await flush();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    finishGetSession({ data: { session: session() }, error: null });
    await lifecycle.ready;
    lifecycle.stop();
  });

  it('preserves cached auth and local data when session is absent and offline recovery fails', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'cached-user'],
      ['userName', 'Cached User'],
      ['history', 'preserve-me'],
      ['userJapams:cached-user', 'cached-japams'],
      ['timerState:cached-user', 'cached-timer'],
    ]);
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockRecoverSessionIfNeeded.mockResolvedValue(false);

    const result = await resolveAuthenticatedSession();

    expect(result).toEqual({ kind: 'AUTHENTICATED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('userId')).toBe('cached-user');
    expect(await AsyncStorage.getItem('userName')).toBe('Cached User');
    expect(await AsyncStorage.getItem('history')).toBe('preserve-me');
    expect(await AsyncStorage.getItem('userJapams:cached-user')).toBe('cached-japams');
    expect(await AsyncStorage.getItem('timerState:cached-user')).toBe('cached-timer');
    expect(mockRecoverSessionIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('does not restore auth when an in-flight recovery completes after explicit logout', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'cached-user'],
      ['userName', 'Cached User'],
      ['history', 'preserve-me'],
    ]);
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    let finishRecovery!: (result: boolean) => void;
    mockRecoverSessionIfNeeded.mockImplementation(() => new Promise((resolve) => {
      finishRecovery = resolve;
    }));

    await expect(resolveAuthenticatedSession()).resolves.toEqual({ kind: 'AUTHENTICATED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(mockRecoverSessionIfNeeded).toHaveBeenCalledTimes(1);

    await runSharedLogoutFlow();
    mockIsAuthGenerationCurrent.mockReturnValue(false);
    mockHasCancelledRecoveryInFlight.mockReturnValue(true);
    authStateCallback?.('SIGNED_IN', session());
    await flush();

    finishRecovery(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    await flush();

    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userName')).toBeNull();
    expect(await AsyncStorage.getItem('history')).toBe('preserve-me');
    expect(mockSignOut).toHaveBeenCalledTimes(1);

    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    mockIsAuthGenerationCurrent.mockReturnValue(true);
    mockHasCancelledRecoveryInFlight.mockReturnValue(false);
    authStateCallback?.('SIGNED_IN', session());
    await flush();
    expect(await AsyncStorage.getItem('userId')).toBe('user-123');
    lifecycle.stop();
  });

  it('clears stale cached identity on a definitive SIGNED_OUT', async () => {
    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    await AsyncStorage.multiSet([
      ['userId', 'user-123'],
      ['userName', 'Test User'],
    ]);
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: { status: 401, code: 'invalid_token', message: 'Invalid token' },
    });

    authStateCallback?.('SIGNED_OUT', null);
    await flush();
    await flush();

    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userName')).toBeNull();
    lifecycle.stop();
  });

  it('persists authenticated identity on TOKEN_REFRESHED', async () => {
    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    await AsyncStorage.multiRemove(['userId', 'userName', 'userEmail']);

    authStateCallback?.('TOKEN_REFRESHED', session());
    await flush();

    expect(await AsyncStorage.getItem('userId')).toBe('user-123');
    expect(await AsyncStorage.getItem('userName')).toBe('Test User');
    expect(await AsyncStorage.getItem('userEmail')).toBe('user@example.com');
    lifecycle.stop();
  });

  it('keeps a cached signed-in user and local workspace usable with no network', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'user-123'],
      ['userName', 'Test User'],
      ['history', 'cached-history'],
      ['userJapams:user-123', 'cached-japams'],
      ['timerState:user-123', 'cached-timer'],
    ]);
    mockGetSession.mockImplementation(() => new Promise(() => {}));

    const lifecycle = startAuthLifecycle();
    await expect(lifecycle.ready).resolves.toEqual({ kind: 'AUTHENTICATED' });
    expect(await AsyncStorage.getItem('userId')).toBe('user-123');
    expect(await AsyncStorage.getItem('history')).toBe('cached-history');
    expect(await AsyncStorage.getItem('userJapams:user-123')).toBe('cached-japams');
    expect(await AsyncStorage.getItem('timerState:user-123')).toBe('cached-timer');
    lifecycle.stop();
  });

  it('does not clear identity or local state when getSession fails on the network', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'user-123'],
      ['history', 'cached-history'],
      ['timerState:user-123', 'cached-timer'],
    ]);
    mockGetSession.mockRejectedValue(Object.assign(new Error('offline'), { name: 'TypeError' }));

    await expect(resolveAuthenticatedSession()).resolves.toEqual({ kind: 'AUTHENTICATED' });
    await flush();

    expect(await AsyncStorage.getItem('userId')).toBe('user-123');
    expect(await AsyncStorage.getItem('history')).toBe('cached-history');
    expect(await AsyncStorage.getItem('timerState:user-123')).toBe('cached-timer');
  });

  it('does not log out or bounce auth on a transient refresh failure', async () => {
    await AsyncStorage.setItem('userId', 'user-123');
    mockGetSession.mockResolvedValue({ data: { session: session(Math.floor(Date.now() / 1000) - 30) }, error: null });
    mockRefreshSession.mockRejectedValue(new Error('temporary network timeout'));

    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    await flush();

    expect(await AsyncStorage.getItem('userId')).toBe('user-123');
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect((DeviceEventEmitter.emit as jest.Mock).mock.calls).not.toContainEqual(['japam-auth-updated']);
    lifecycle.stop();
  });

  it('refreshes auth after native connectivity returns', async () => {
    await AsyncStorage.setItem('userId', 'user-123');
    mockGetSession
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue({ data: { session: session() }, error: null });

    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    netInfoCallback?.({ isConnected: false, isInternetReachable: false });
    netInfoCallback?.({ isConnected: true, isInternetReachable: true });
    await flush();
    await flush();

    expect(mockGetSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await AsyncStorage.getItem('userId')).toBe('user-123');
    lifecycle.stop();
  });

  it('still logs out for a definitive invalid session', async () => {
    await AsyncStorage.setItem('userId', 'user-123');
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: { status: 401, code: 'invalid_token', message: 'Invalid token' },
    });

    await expect(resolveAuthenticatedSession()).resolves.toEqual({ kind: 'AUTHENTICATED' });
    await flush();

    expect(await AsyncStorage.getItem('userId')).toBeNull();
  });

  it('explicit Sign Out still clears auth normally', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'user-123'],
      ['userName', 'Test User'],
      ['history', 'cached-history'],
    ]);

    await runSharedLogoutFlow();

    expect(mockCancelSessionRecovery).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userName')).toBeNull();
    expect(await AsyncStorage.getItem('history')).toBe('cached-history');
  });
});

afterAll(async () => {
  await clearCachedIdentity();
});

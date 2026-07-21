jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockGetSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockStartAutoRefresh = jest.fn();
const mockStopAutoRefresh = jest.fn();
const mockUnsubscribe = jest.fn();
let authStateCallback: ((event: string, session: any) => void) | null = null;
let appStateCallback: ((state: string) => void) | null = null;

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
      startAutoRefresh: (...args: unknown[]) => mockStartAutoRefresh(...args),
      stopAutoRefresh: (...args: unknown[]) => mockStopAutoRefresh(...args),
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
import { clearCachedIdentity, resolveAuthenticatedSession, startAuthLifecycle } from '../authLifecycle';

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
  mockGetSession.mockResolvedValue({ data: { session: session() }, error: null });
  mockRefreshSession.mockResolvedValue({ data: { session: session() }, error: null });
  mockStartAutoRefresh.mockResolvedValue(undefined);
  mockStopAutoRefresh.mockResolvedValue(undefined);
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

  it('clears stale cached identity when the session is missing', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'cached-user'],
      ['userName', 'Cached User'],
      ['history', 'preserve-me'],
    ]);
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await resolveAuthenticatedSession();

    expect(result).toEqual({ kind: 'AUTH_REQUIRED' });
    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userName')).toBeNull();
    expect(await AsyncStorage.getItem('history')).toBe('preserve-me');
  });

  it('clears stale cached identity on SIGNED_OUT', async () => {
    const lifecycle = startAuthLifecycle();
    await lifecycle.ready;
    await AsyncStorage.multiSet([
      ['userId', 'user-123'],
      ['userName', 'Test User'],
    ]);

    authStateCallback?.('SIGNED_OUT', null);
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

  describe('name precedence — given_name wins over full_name and name', () => {
    const sessionWith = (metadata: Record<string, unknown>) => ({
      ...session(),
      user: { ...session().user, user_metadata: metadata },
    });

    it('given_name is used when present', async () => {
      const lifecycle = startAuthLifecycle();
      await lifecycle.ready;
      await AsyncStorage.multiRemove(['userName']);

      authStateCallback?.('TOKEN_REFRESHED', sessionWith({
        given_name: 'learn',
        full_name: 'learncode',
        name: 'learncode',
      }));
      await flush();

      expect(await AsyncStorage.getItem('userName')).toBe('learn');
      lifecycle.stop();
    });

    it('full_name is used when given_name is absent', async () => {
      const lifecycle = startAuthLifecycle();
      await lifecycle.ready;
      await AsyncStorage.multiRemove(['userName']);

      authStateCallback?.('TOKEN_REFRESHED', sessionWith({
        full_name: 'Full Name',
        name: 'just-name',
      }));
      await flush();

      expect(await AsyncStorage.getItem('userName')).toBe('Full Name');
      lifecycle.stop();
    });

    it('name is used when given_name and full_name are absent', async () => {
      const lifecycle = startAuthLifecycle();
      await lifecycle.ready;
      await AsyncStorage.multiRemove(['userName']);

      authStateCallback?.('TOKEN_REFRESHED', sessionWith({
        name: 'only-name',
      }));
      await flush();

      expect(await AsyncStorage.getItem('userName')).toBe('only-name');
      lifecycle.stop();
    });

    it('falls back to email when no name fields exist', async () => {
      const lifecycle = startAuthLifecycle();
      await lifecycle.ready;
      await AsyncStorage.multiRemove(['userName']);

      authStateCallback?.('TOKEN_REFRESHED', sessionWith({
        email: 'user@example.com',
      }));
      await flush();

      expect(await AsyncStorage.getItem('userName')).toBe('user@example.com');
      lifecycle.stop();
    });

    it('TOKEN_REFRESHED preserves the same resolved name as initial sign-in', async () => {
      const lifecycle = startAuthLifecycle();
      await lifecycle.ready;
      await AsyncStorage.multiRemove(['userName']);

      // Simulate the scenario from the Samsung device: Google returns
      // given_name="learn", name="learncode". The sign-in handler stores
      // "learn" (given_name || name). TOKEN_REFRESHED must NOT overwrite
      // with "learncode" (full_name || name).
      await AsyncStorage.setItem('userName', 'learn');

      authStateCallback?.('TOKEN_REFRESHED', sessionWith({
        given_name: 'learn',
        full_name: 'learncode',
        name: 'learncode',
      }));
      await flush();

      // given_name wins → "learn" is preserved
      expect(await AsyncStorage.getItem('userName')).toBe('learn');
      lifecycle.stop();
    });
  });
});

afterAll(async () => {
  await clearCachedIdentity();
});

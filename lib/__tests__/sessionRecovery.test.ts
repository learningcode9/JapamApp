jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

let mockSessionState: {
  data: { session: { access_token: string; refresh_token?: string; user: { id: string } } | null };
  error: null;
} = {
  data: { session: null },
  error: null,
};
const mockSignInWithIdToken = jest.fn();
const mockSignInSilently = jest.fn();
const mockSignOut = jest.fn();
const mockGetIsAnonymous = jest.fn();
const mockRepairLegacy = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve(mockSessionState)),
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signInSilently: (...args: unknown[]) => mockSignInSilently(...args),
    signOut: jest.fn(),
  },
}));

let mockPlatformOS = 'android';

jest.mock('react-native', () => ({
  DeviceEventEmitter: { emit: jest.fn() },
  Platform: {
    get OS() { return mockPlatformOS; },
  },
}));

const mockMigrateScopedKeys = jest.fn();

jest.mock('../anonymousAuth', () => ({
  clearAnonymousFlag: jest.fn(),
  getIsAnonymous: (...args: unknown[]) => mockGetIsAnonymous(...args),
  repairLegacyStoredUserId: (...args: unknown[]) => mockRepairLegacy(...args),
  migrateScopedKeysAfterIdentityRepair: (...args: unknown[]) => mockMigrateScopedKeys(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  hasCancelledRecoveryInFlight,
  recoverSessionIfNeeded,
  resetRecoveryState,
} from '../sessionRecovery';
import { signInWithGoogleIdTokenAndStoreIdentity } from '../nativeGoogleAuth';
import { runSharedLogoutFlow } from '../sharedLogout';
import { supabase } from '../supabase';

const USER_ID_KEY = 'userId';

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  resetRecoveryState();
  mockPlatformOS = 'android';
  mockSessionState = { data: { session: null }, error: null };
  mockGetIsAnonymous.mockResolvedValue(false);
  mockRepairLegacy.mockResolvedValue('user-id-after-repair');
  mockMigrateScopedKeys.mockResolvedValue(undefined);
  mockSignInSilently.mockRejectedValue(new Error('no cached credentials'));
  mockSignOut.mockImplementation(async () => {
    mockSessionState = { data: { session: null }, error: null };
    return { error: null };
  });
  mockSignInWithIdToken.mockImplementation(async () => {
    mockSessionState = {
      data: { session: { access_token: 'recovered-token', user: { id: 'recovered-uuid' } } },
      error: null,
    };
    return { data: { user: { id: 'recovered-uuid' }, session: { access_token: 'recovered-token' } }, error: null };
  });
});

describe('recoverSessionIfNeeded', () => {
  it('returns true immediately when a valid session already exists', async () => {
    mockSessionState = {
      data: { session: { access_token: 'valid-token', user: { id: 'existing-uuid' } } },
      error: null,
    };

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(true);
    expect(mockSignInSilently).not.toHaveBeenCalled();
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });

  it('returns false on web platform', async () => {
    mockPlatformOS = 'web';

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockSignInSilently).not.toHaveBeenCalled();
  });

  it('returns false for anonymous users', async () => {
    mockGetIsAnonymous.mockResolvedValue(true);

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockSignInSilently).not.toHaveBeenCalled();
  });

  it('returns false when no userId is stored', async () => {
    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockSignInSilently).not.toHaveBeenCalled();
  });

  it('recovers session via Google silent sign-in', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({
      data: { idToken: 'fresh-id-token' },
    });

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(true);
    expect(mockSignInSilently).toHaveBeenCalledTimes(1);
    expect(mockSignInWithIdToken).toHaveBeenCalledWith({
      provider: 'google',
      token: 'fresh-id-token',
    });
  });

  it('calls repairLegacyStoredUserId after successful recovery', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({
      data: { idToken: 'fresh-id-token' },
    });

    await recoverSessionIfNeeded();

    expect(mockRepairLegacy).toHaveBeenCalledTimes(1);
  });

  it('returns false when repairLegacyStoredUserId returns null', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({
      data: { idToken: 'fresh-id-token' },
    });
    mockRepairLegacy.mockResolvedValue(null);

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
  });

  it('returns false when signInWithIdToken returns no access_token', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({
      data: { idToken: 'fresh-id-token' },
    });
    mockSignInWithIdToken.mockResolvedValue({
      data: { user: { id: 'u1' }, session: null },
      error: null,
    });

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockRepairLegacy).not.toHaveBeenCalled();
  });

  it('returns false when signInWithIdToken errors', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({
      data: { idToken: 'fresh-id-token' },
    });
    mockSignInWithIdToken.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('invalid token'),
    });

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockRepairLegacy).not.toHaveBeenCalled();
  });

  it('returns false when silent sign-in returns no idToken', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({ data: { idToken: null } });

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });

  it('returns false when silent sign-in throws', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockRejectedValue(new Error('play services unavailable'));

    const result = await recoverSessionIfNeeded();

    expect(result).toBe(false);
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });

  it('serialises concurrent callers to one in-flight promise', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');

    // signInSilently won't resolve until we control the timing
    let resolveSilentSignIn!: (v: unknown) => void;
    const silentPromise = new Promise((resolve) => { resolveSilentSignIn = resolve; });
    mockSignInSilently.mockReturnValue(silentPromise);
    mockSignInWithIdToken.mockImplementation(async () => {
      mockSessionState = {
        data: { session: { access_token: 'recovered-token', user: { id: 'recovered-uuid' } } },
        error: null,
      };
      return { data: { user: { id: 'recovered-uuid' }, session: { access_token: 'recovered-token' } }, error: null };
    });

    const call1 = recoverSessionIfNeeded();
    const call2 = recoverSessionIfNeeded();

    // Both calls return the same promise
    expect(call1).toBe(call2);

    resolveSilentSignIn({ data: { idToken: 'token' } });

    const result1 = await call1;
    const result2 = await call2;

    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(mockSignInSilently).toHaveBeenCalledTimes(1);
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a session when recovery completes after explicit logout', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'google-user-123'],
      ['userName', 'Cached User'],
      ['history', 'preserve-me'],
    ]);
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'fresh-id-token' } });

    let finishSignIn!: (value: unknown) => void;
    mockSignInWithIdToken.mockReturnValue(new Promise((resolve) => {
      finishSignIn = resolve;
    }));

    const recovery = recoverSessionIfNeeded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);

    await runSharedLogoutFlow();
    expect(hasCancelledRecoveryInFlight()).toBe(true);
    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userName')).toBeNull();
    expect(await AsyncStorage.getItem('history')).toBe('preserve-me');

    finishSignIn({
      data: { user: { id: 'recovered-uuid' }, session: { access_token: 'stale-token' } },
      error: null,
    });

    await expect(recovery).resolves.toBe(false);
    expect(hasCancelledRecoveryInFlight()).toBe(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect((await (jest.requireMock('../supabase').supabase.auth.getSession())).data.session).toBeNull();
    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userName')).toBeNull();
    expect(await AsyncStorage.getItem('history')).toBe('preserve-me');
  });

  it('serializes a manual login until stale recovery cleanup finishes', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'google-user-123'],
      ['userName', 'Cached User'],
      ['history', 'preserve-me'],
    ]);
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'fresh-id-token' } });

    let finishStaleRecovery!: () => void;
    mockSignInWithIdToken.mockImplementationOnce(() => new Promise((resolve) => {
      finishStaleRecovery = () => {
        // Supabase can persist the session before the request promise resolves.
        mockSessionState = {
          data: {
            session: {
              access_token: 'stale-token',
              refresh_token: 'stale-refresh-token',
              user: { id: 'recovered-uuid' },
            },
          },
          error: null,
        };
        resolve({
          data: {
            user: { id: 'recovered-uuid' },
            session: {
              access_token: 'stale-token',
              refresh_token: 'stale-refresh-token',
              user: { id: 'recovered-uuid' },
            },
          },
          error: null,
        });
      };
    }));
    mockSignInWithIdToken.mockImplementationOnce(async () => {
      mockSessionState = {
        data: {
          session: {
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            user: { id: 'new-user' },
          },
        },
        error: null,
      };
      return {
        data: {
          user: { id: 'new-user' },
          session: { access_token: 'new-token', refresh_token: 'new-refresh-token' },
        },
        error: null,
      };
    });

    const recovery = recoverSessionIfNeeded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);

    await runSharedLogoutFlow();

    const interactiveLogin = signInWithGoogleIdTokenAndStoreIdentity('new-id-token', 'New User', 'new@example.com');
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);

    finishStaleRecovery();

    await expect(recovery).resolves.toBe(false);
    await expect(interactiveLogin).resolves.toEqual({ ok: true, userId: 'new-user' });
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(2);
    expect(mockSignInWithIdToken).toHaveBeenLastCalledWith({ provider: 'google', token: 'new-id-token' });
    expect(mockSignOut).toHaveBeenCalledTimes(2);
    expect((await supabase.auth.getSession()).data.session?.access_token).toBe('new-token');
    expect(await AsyncStorage.getItem('userId')).toBe('new-user');
    expect(await AsyncStorage.getItem('userName')).toBe('New User');
    expect(await AsyncStorage.getItem('userEmail')).toBe('new@example.com');
    expect(await AsyncStorage.getItem('history')).toBe('preserve-me');
  });

  it('calls migrateScopedKeysAfterIdentityRepair after successful recovery', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');
    mockSignInSilently.mockResolvedValue({
      data: { idToken: 'fresh-id-token' },
    });

    await recoverSessionIfNeeded();

    expect(mockMigrateScopedKeys).toHaveBeenCalledTimes(1);
  });

  it('does not call migrateScopedKeysAfterIdentityRepair when recovery fails', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');

    await recoverSessionIfNeeded();

    expect(mockMigrateScopedKeys).not.toHaveBeenCalled();
  });

  it('does not call migrateScopedKeysAfterIdentityRepair when session already exists', async () => {
    mockSessionState = {
      data: { session: { access_token: 'valid-token', user: { id: 'existing-uuid' } } },
      error: null,
    };

    await recoverSessionIfNeeded();

    expect(mockMigrateScopedKeys).not.toHaveBeenCalled();
  });

  it('allows a new recovery after previous one finishes', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'google-user-123');

    // First attempt fails (silent sign-in throws)
    mockSignInSilently.mockRejectedValue(new Error('first attempt fails'));
    const first = await recoverSessionIfNeeded();
    expect(first).toBe(false);

    // Reset the sign-in mock for second attempt
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'second-attempt-token' } });

    const second = await recoverSessionIfNeeded();
    expect(second).toBe(true);
    expect(mockSignInSilently).toHaveBeenCalledTimes(2);
  });
});

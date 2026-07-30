jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

let mockSessionState: { data: { session: { access_token: string; user: { id: string } } | null }; error: null } = {
  data: { session: null },
  error: null,
};
const mockSignInWithIdToken = jest.fn();
const mockSignInSilently = jest.fn();
const mockGetIsAnonymous = jest.fn();
const mockRepairLegacy = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve(mockSessionState)),
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
    },
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signInSilently: (...args: unknown[]) => mockSignInSilently(...args),
  },
}));

let mockPlatformOS = 'android';

jest.mock('react-native', () => ({
  Platform: {
    get OS() { return mockPlatformOS; },
  },
}));

const mockMigrateScopedKeys = jest.fn();

jest.mock('../anonymousAuth', () => ({
  getIsAnonymous: (...args: unknown[]) => mockGetIsAnonymous(...args),
  repairLegacyStoredUserId: (...args: unknown[]) => mockRepairLegacy(...args),
  migrateScopedKeysAfterIdentityRepair: (...args: unknown[]) => mockMigrateScopedKeys(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recoverSessionIfNeeded, resetRecoveryState } from '../sessionRecovery';

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

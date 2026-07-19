jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const order: string[] = [];
const mockSupabaseSignOut = jest.fn();
const mockSignInWithIdToken = jest.fn();
const mockLinkIdentity = jest.fn();
const mockGoogleSignOut = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      signOut: (...args: unknown[]) => mockSupabaseSignOut(...args),
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
      linkIdentity: (...args: unknown[]) => mockLinkIdentity(...args),
      storageKey: 'sb-test-auth-token',
    },
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    signOut: (...args: unknown[]) => mockGoogleSignOut(...args),
  },
}));

jest.mock('react-native', () => ({
  DeviceEventEmitter: {
    emit: jest.fn((eventName: string) => {
      order.push(`event:${eventName}`);
    }),
  },
  Platform: {
    OS: 'android',
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, Platform } from 'react-native';
import { getIsAnonymous, IS_ANONYMOUS_KEY, LEGACY_USER_ID_KEY, signInOrLinkGoogle, USER_ID_KEY } from '../anonymousAuth';
import { runSharedLogoutFlow } from '../sharedLogout';

const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';

beforeEach(async () => {
  await AsyncStorage.clear();
  order.length = 0;
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  mockSupabaseSignOut.mockImplementation(async () => {
    order.push('supabase.signOut');
    return { error: null };
  });
  mockGoogleSignOut.mockImplementation(async () => {
    order.push('google.signOut');
  });
  mockSignInWithIdToken.mockResolvedValue({ error: null });
  mockLinkIdentity.mockResolvedValue({ error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runSharedLogoutFlow', () => {
  it('uses one sequence for local auth cleanup, Supabase signOut, native Google signOut, and auth event', async () => {
    await AsyncStorage.multiSet([
      [USER_ID_KEY, 'user-123'],
      [USER_NAME_KEY, 'Test User'],
      [USER_EMAIL_KEY, 'test@example.com'],
      [IS_ANONYMOUS_KEY, 'false'],
      [LEGACY_USER_ID_KEY, '108347881408167165195'],
    ]);

    await runSharedLogoutFlow({
      clearLocalState: async () => {
        order.push('screen.localState');
      },
      onLoggedOut: () => {
        order.push('screen.ui');
      },
    });

    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(IS_ANONYMOUS_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(LEGACY_USER_ID_KEY)).toBeNull();
    expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignOut).toHaveBeenCalledTimes(1);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('japam-auth-updated');
    expect(order).toEqual([
      'screen.localState',
      'supabase.signOut',
      'google.signOut',
      'event:japam-auth-updated',
      'screen.ui',
    ]);
  });

  it('clears anonymous state so the next Google sign-in is direct, while anonymous upgrade still links before logout', async () => {
    await AsyncStorage.multiSet([
      [USER_ID_KEY, 'anon-user-id'],
      [USER_NAME_KEY, 'Guest User'],
      [IS_ANONYMOUS_KEY, 'true'],
    ]);

    await expect(signInOrLinkGoogle('before-logout-token', await getIsAnonymous())).resolves.toEqual({ kind: 'linked' });
    expect(mockLinkIdentity).toHaveBeenCalledWith({ provider: 'google', token: 'before-logout-token' });
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();

    await runSharedLogoutFlow();

    expect(await getIsAnonymous()).toBe(false);
    await expect(signInOrLinkGoogle('after-logout-token', await getIsAnonymous())).resolves.toEqual({ kind: 'signedIn' });
    expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'google', token: 'after-logout-token' });
    expect(mockLinkIdentity).toHaveBeenCalledTimes(1);
  });

  it('skips native Google signOut on web but still dispatches the web auth event', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const dispatchEvent = jest.fn();
    global.window = { dispatchEvent } as unknown as Window & typeof globalThis;

    await runSharedLogoutFlow();

    expect(mockGoogleSignOut).not.toHaveBeenCalled();
    expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('japam-auth-updated');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'japam-auth-updated' }));
  });
});

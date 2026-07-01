jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
}));

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      signInAnonymously: jest.fn(),
      linkIdentity: jest.fn(),
      signInWithIdToken: jest.fn(),
      getSession: jest.fn(),
    },
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { supabase } from '../supabase';
import {
  USER_ID_KEY,
  IS_ANONYMOUS_KEY,
  LEGACY_USER_ID_KEY,
  signInAsGuest,
  getIsAnonymous,
  setIsAnonymous,
  clearAnonymousFlag,
  signInOrLinkGoogle,
  showGoogleAccountCollisionDialog,
  shouldSkipRemoteSync,
  repairLegacyStoredUserId,
} from '../anonymousAuth';

const mockedAuth = supabase.auth as unknown as {
  signInAnonymously: jest.Mock;
  linkIdentity: jest.Mock;
  signInWithIdToken: jest.Mock;
  getSession: jest.Mock;
};

const sessionWith = (userId: string | undefined, isAnonymous = false) => ({
  data: {
    session: userId ? { user: { id: userId, is_anonymous: isAnonymous } } : null,
  },
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('shouldSkipRemoteSync — truth table', () => {
  it.each([
    [null, false, true],
    [null, true, true],
    [undefined, false, true],
    ['uuid-123', false, false],
    ['uuid-123', true, true],
  ])('userId=%p isAnonymous=%p -> %p', (userId, isAnonymous, expected) => {
    expect(shouldSkipRemoteSync(userId as string | null | undefined, isAnonymous as boolean)).toBe(
      expected
    );
  });
});

describe('signInAsGuest', () => {
  it('success: writes USER_ID_KEY and IS_ANONYMOUS_KEY, returns isAnonymous true', async () => {
    mockedAuth.signInAnonymously.mockResolvedValue({
      data: { user: { id: 'anon-uuid-1' }, session: {} },
      error: null,
    });

    const result = await signInAsGuest();

    expect(result).toEqual({ userId: 'anon-uuid-1', isAnonymous: true });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe('anon-uuid-1');
    expect(await AsyncStorage.getItem(IS_ANONYMOUS_KEY)).toBe('true');
  });

  it('failure (e.g. offline or anonymous sign-ins disabled): writes nothing, falls back', async () => {
    mockedAuth.signInAnonymously.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Anonymous sign-ins are disabled', code: 'anonymous_provider_disabled' },
    });

    const result = await signInAsGuest();

    expect(result).toEqual({ userId: null, isAnonymous: false });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(IS_ANONYMOUS_KEY)).toBeNull();
  });

  it('failure (network exception thrown): writes nothing, falls back', async () => {
    mockedAuth.signInAnonymously.mockRejectedValue(new Error('network error'));

    const result = await signInAsGuest();

    expect(result).toEqual({ userId: null, isAnonymous: false });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
  });
});

describe('anonymous flag helpers', () => {
  it('getIsAnonymous defaults to false when unset', async () => {
    expect(await getIsAnonymous()).toBe(false);
  });

  it('setIsAnonymous(true) then getIsAnonymous reflects it', async () => {
    await setIsAnonymous(true);
    expect(await getIsAnonymous()).toBe(true);
  });

  it('setIsAnonymous(false) then getIsAnonymous reflects it', async () => {
    await setIsAnonymous(true);
    await setIsAnonymous(false);
    expect(await getIsAnonymous()).toBe(false);
  });

  it('clearAnonymousFlag removes the key entirely', async () => {
    await setIsAnonymous(true);
    await clearAnonymousFlag();
    expect(await AsyncStorage.getItem(IS_ANONYMOUS_KEY)).toBeNull();
    expect(await getIsAnonymous()).toBe(false);
  });
});

describe('signInOrLinkGoogle', () => {
  it('direct sign-in: not anonymous calls signInWithIdToken, not linkIdentity', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({ data: {}, error: null });

    const result = await signInOrLinkGoogle('id-token-abc', false);

    expect(result).toEqual({ kind: 'signedIn' });
    expect(mockedAuth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'google',
      token: 'id-token-abc',
    });
    expect(mockedAuth.linkIdentity).not.toHaveBeenCalled();
  });

  it('link success: anonymous calls linkIdentity, not signInWithIdToken', async () => {
    mockedAuth.linkIdentity.mockResolvedValue({ data: {}, error: null });

    const result = await signInOrLinkGoogle('id-token-abc', true);

    expect(result).toEqual({ kind: 'linked' });
    expect(mockedAuth.linkIdentity).toHaveBeenCalledWith({
      provider: 'google',
      token: 'id-token-abc',
    });
    expect(mockedAuth.signInWithIdToken).not.toHaveBeenCalled();
  });

  it('collision: anonymous + identity_already_exists error returns kind "collision"', async () => {
    mockedAuth.linkIdentity.mockResolvedValue({
      data: null,
      error: { message: 'Identity is already linked to another user', code: 'identity_already_exists' },
    });

    const result = await signInOrLinkGoogle('id-token-abc', true);

    expect(result).toEqual({ kind: 'collision' });
  });

  it('other linkIdentity error returns kind "error", not "collision"', async () => {
    mockedAuth.linkIdentity.mockResolvedValue({
      data: null,
      error: { message: 'manual linking disabled', code: 'manual_linking_disabled' },
    });

    const result = await signInOrLinkGoogle('id-token-abc', true);

    expect(result.kind).toBe('error');
  });

  it('signInWithIdToken error returns kind "error"', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: null,
      error: { message: 'invalid token', code: 'bad_jwt' },
    });

    const result = await signInOrLinkGoogle('bad-token', false);

    expect(result.kind).toBe('error');
  });

  it('thrown exception is caught and returns kind "error"', async () => {
    mockedAuth.linkIdentity.mockRejectedValue(new Error('network blip'));

    const result = await signInOrLinkGoogle('id-token-abc', true);

    expect(result.kind).toBe('error');
  });
});

describe('repairLegacyStoredUserId', () => {
  const NUMERIC_ID = '108347881408167165195';
  const UUID = '2793fca2-38fa-4c9e-9856-26c2b34d0acb';

  it('no stored USER_ID_KEY (guest): returns null, writes nothing, never calls getSession', async () => {
    const result = await repairLegacyStoredUserId();

    expect(result).toBeNull();
    expect(mockedAuth.getSession).not.toHaveBeenCalled();
  });

  it('already a UUID: returns it unchanged, never calls getSession', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, UUID);

    const result = await repairLegacyStoredUserId();

    expect(result).toBe(UUID);
    expect(mockedAuth.getSession).not.toHaveBeenCalled();
  });

  it('numeric id + no session: leaves USER_ID_KEY untouched, no LEGACY_USER_ID_KEY written', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, NUMERIC_ID);
    mockedAuth.getSession.mockResolvedValue(sessionWith(undefined));

    const result = await repairLegacyStoredUserId();

    expect(result).toBe(NUMERIC_ID);
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe(NUMERIC_ID);
    expect(await AsyncStorage.getItem(LEGACY_USER_ID_KEY)).toBeNull();
  });

  it('numeric id + anonymous session: leaves USER_ID_KEY untouched (guest session, not a real account)', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, NUMERIC_ID);
    mockedAuth.getSession.mockResolvedValue(sessionWith(UUID, true));

    const result = await repairLegacyStoredUserId();

    expect(result).toBe(NUMERIC_ID);
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe(NUMERIC_ID);
  });

  it('numeric id + session whose user.id is not UUID-shaped: leaves USER_ID_KEY untouched', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, NUMERIC_ID);
    mockedAuth.getSession.mockResolvedValue(sessionWith('not-a-uuid'));

    const result = await repairLegacyStoredUserId();

    expect(result).toBe(NUMERIC_ID);
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe(NUMERIC_ID);
  });

  it('numeric id + valid non-anonymous UUID session: repairs USER_ID_KEY and remembers the old id', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, NUMERIC_ID);
    mockedAuth.getSession.mockResolvedValue(sessionWith(UUID, false));

    const result = await repairLegacyStoredUserId();

    expect(result).toBe(UUID);
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe(UUID);
    expect(await AsyncStorage.getItem(LEGACY_USER_ID_KEY)).toBe(NUMERIC_ID);
  });

  it('is idempotent: calling it again after a repair is a no-op (no duplicate log-worthy upgrade)', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, NUMERIC_ID);
    mockedAuth.getSession.mockResolvedValue(sessionWith(UUID, false));
    await repairLegacyStoredUserId();

    mockedAuth.getSession.mockClear();
    const second = await repairLegacyStoredUserId();

    expect(second).toBe(UUID);
    expect(mockedAuth.getSession).not.toHaveBeenCalled(); // short-circuits: already a UUID
    expect(await AsyncStorage.getItem(LEGACY_USER_ID_KEY)).toBe(NUMERIC_ID); // untouched, not cleared
  });
});

describe('showGoogleAccountCollisionDialog', () => {
  it('shows the approved message and wires Sign In / Cancel callbacks', () => {
    const onSignIn = jest.fn();
    const onCancel = jest.fn();

    showGoogleAccountCollisionDialog(onSignIn, onCancel);

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe('Account already linked');
    expect(message).toBe('This Google account is already linked to another Japam account.');
    expect(buttons).toHaveLength(2);

    buttons[0].onPress();
    expect(onCancel).toHaveBeenCalledTimes(1);
    buttons[1].onPress();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});

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
  migrateScopedKeysAfterIdentityRepair,
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

describe('migrateScopedKeysAfterIdentityRepair', () => {
  const NUMERIC_ID = '108347881408167165195';
  const UUID = '2793fca2-38fa-4c9e-9856-26c2b34d0acb';

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    // Provide a simple getAllKeys implementation for the mock
    (AsyncStorage.getAllKeys as jest.Mock).mockImplementation(async () =>
      Object.keys((AsyncStorage as any).__INTERNAL_MOCK_STORAGE__ || {})
    );
  });

  it('no-ops when LEGACY_USER_ID_KEY is not set', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, UUID);

    await migrateScopedKeysAfterIdentityRepair();

    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe(UUID);
  });

  it('no-ops when LEGACY_USER_ID_KEY equals USER_ID_KEY', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, UUID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);

    await migrateScopedKeysAfterIdentityRepair();

    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe(UUID);
  });

  it('migrates userJapams and currentJapamId scoped keys', async () => {
    const JAPAM_LIST = JSON.stringify([{ id: 'japam-1', name: 'My Japam' }]);
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    await AsyncStorage.setItem(`userJapams:${NUMERIC_ID}`, JAPAM_LIST);
    await AsyncStorage.setItem(`currentJapamId:${NUMERIC_ID}`, 'japam-1');

    await migrateScopedKeysAfterIdentityRepair();

    // Old keys removed
    expect(await AsyncStorage.getItem(`userJapams:${NUMERIC_ID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`currentJapamId:${NUMERIC_ID}`)).toBeNull();
    // New keys written
    expect(await AsyncStorage.getItem(`userJapams:${UUID}`)).toBe(JAPAM_LIST);
    expect(await AsyncStorage.getItem(`currentJapamId:${UUID}`)).toBe('japam-1');
  });

  it('migrates timer-scoped keys', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    await AsyncStorage.setItem(`timerSeconds:${NUMERIC_ID}`, '300');
    await AsyncStorage.setItem(`timerRunning:${NUMERIC_ID}`, 'true');
    await AsyncStorage.setItem(`timerSessionId:${NUMERIC_ID}`, 'session-1');

    await migrateScopedKeysAfterIdentityRepair();

    expect(await AsyncStorage.getItem(`timerSeconds:${NUMERIC_ID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerSeconds:${UUID}`)).toBe('300');
    expect(await AsyncStorage.getItem(`timerRunning:${NUMERIC_ID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerRunning:${UUID}`)).toBe('true');
    expect(await AsyncStorage.getItem(`timerSessionId:${NUMERIC_ID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerSessionId:${UUID}`)).toBe('session-1');
  });

  it('migrates per-Japam-scoped keys', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    await AsyncStorage.setItem(`timerTarget:${NUMERIC_ID}:japam-1`, '600');
    await AsyncStorage.setItem(`timerTarget:${NUMERIC_ID}:japam-2`, '300');

    await migrateScopedKeysAfterIdentityRepair();

    expect(await AsyncStorage.getItem(`timerTarget:${NUMERIC_ID}:japam-1`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerTarget:${UUID}:japam-1`)).toBe('600');
    expect(await AsyncStorage.getItem(`timerTarget:${NUMERIC_ID}:japam-2`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerTarget:${UUID}:japam-2`)).toBe('300');
  });

  it('migrates userId in history records', async () => {
    const history = [
      { completionId: 'c1', userId: NUMERIC_ID, totalCount: 108 },
      { completionId: 'c2', userId: 'other-user', totalCount: 108 },
      { completionId: 'c3', userId: NUMERIC_ID, totalCount: 216 },
    ];
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    await AsyncStorage.setItem('history', JSON.stringify(history));

    await migrateScopedKeysAfterIdentityRepair();

    const updated = JSON.parse((await AsyncStorage.getItem('history')) || '[]');
    expect(updated[0].userId).toBe(UUID);
    expect(updated[1].userId).toBe('other-user'); // unchanged
    expect(updated[2].userId).toBe(UUID);
  });

  it('does not migrate non-scoped keys (bare keys without userId prefix)', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    await AsyncStorage.setItem('timerSeconds', '100');
    await AsyncStorage.setItem(NUMERIC_ID, 'should-not-touch'); // bare value with numeric id, no colon

    await migrateScopedKeysAfterIdentityRepair();

    expect(await AsyncStorage.getItem('timerSeconds')).toBe('100'); // untouched
    expect(await AsyncStorage.getItem(NUMERIC_ID)).toBe('should-not-touch'); // untouched
  });

  it('collision: existing userJapams at new-UUID key merges arrays dedup by id', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    // Old key has a unique japam + one that already exists at the destination
    await AsyncStorage.setItem(
      `userJapams:${NUMERIC_ID}`,
      JSON.stringify([
        { id: 'japam-old', name: 'Legacy Japam' },
        { id: 'japam-common', name: 'Common (old name)' },
      ]),
    );
    // Destination already has a japam, plus the common one
    await AsyncStorage.setItem(
      `userJapams:${UUID}`,
      JSON.stringify([
        { id: 'japam-existing', name: 'Existing Japam' },
        { id: 'japam-common', name: 'Common (existing name)' },
      ]),
    );

    await migrateScopedKeysAfterIdentityRepair();

    const merged = JSON.parse((await AsyncStorage.getItem(`userJapams:${UUID}`)) || '[]');
    expect(merged).toHaveLength(3);
    const ids = merged.map((j: Record<string, unknown>) => j.id);
    expect(ids).toContain('japam-existing');
    expect(ids).toContain('japam-common');
    expect(ids).toContain('japam-old');
    // japam-common kept the existing entry's name (not overwritten by old)
    const common = merged.find((j: Record<string, unknown>) => j.id === 'japam-common');
    expect(common.name).toBe('Common (existing name)');
    // Old key is removed
    expect(await AsyncStorage.getItem(`userJapams:${NUMERIC_ID}`)).toBeNull();
  });

  it('collision: existing currentJapamId at new-UUID key preserves existing value', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    await AsyncStorage.setItem(`currentJapamId:${NUMERIC_ID}`, 'old-japam');
    await AsyncStorage.setItem(`currentJapamId:${UUID}`, 'existing-japam');

    await migrateScopedKeysAfterIdentityRepair();

    // Existing value preserved, old value NOT written
    expect(await AsyncStorage.getItem(`currentJapamId:${UUID}`)).toBe('existing-japam');
    expect(await AsyncStorage.getItem(`currentJapamId:${NUMERIC_ID}`)).toBeNull();
  });

  it('collision: existing timer-scoped keys at new-UUID key preserve existing values', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    // Old timer state
    await AsyncStorage.setItem(`timerSeconds:${NUMERIC_ID}`, '500');
    await AsyncStorage.setItem(`timerRunning:${NUMERIC_ID}`, 'true');
    await AsyncStorage.setItem(`timerSessionId:${NUMERIC_ID}`, 'old-session');
    // New timer state (should be preserved)
    await AsyncStorage.setItem(`timerSeconds:${UUID}`, '100');
    await AsyncStorage.setItem(`timerRunning:${UUID}`, 'false');
    await AsyncStorage.setItem(`timerSessionId:${UUID}`, 'new-session');

    await migrateScopedKeysAfterIdentityRepair();

    // Existing values preserved
    expect(await AsyncStorage.getItem(`timerSeconds:${UUID}`)).toBe('100');
    expect(await AsyncStorage.getItem(`timerRunning:${UUID}`)).toBe('false');
    expect(await AsyncStorage.getItem(`timerSessionId:${UUID}`)).toBe('new-session');
    // Old keys removed
    expect(await AsyncStorage.getItem(`timerSeconds:${NUMERIC_ID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerRunning:${NUMERIC_ID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`timerSessionId:${NUMERIC_ID}`)).toBeNull();
  });

  it('collision: existing japam-scoped keys (timerTarget:{oldId}:{japamId}) preserve existing', async () => {
    await AsyncStorage.setItem(LEGACY_USER_ID_KEY, NUMERIC_ID);
    await AsyncStorage.setItem(USER_ID_KEY, UUID);
    // Old japam-scoped key
    await AsyncStorage.setItem(`timerTarget:${NUMERIC_ID}:japam-1`, '900');
    // New japam-scoped key already exists
    await AsyncStorage.setItem(`timerTarget:${UUID}:japam-1`, '300');

    await migrateScopedKeysAfterIdentityRepair();

    // Existing value preserved
    expect(await AsyncStorage.getItem(`timerTarget:${UUID}:japam-1`)).toBe('300');
    expect(await AsyncStorage.getItem(`timerTarget:${NUMERIC_ID}:japam-1`)).toBeNull();
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

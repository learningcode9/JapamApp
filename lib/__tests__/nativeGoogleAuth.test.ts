import mockAsyncStorage from '@react-native-async-storage/async-storage/jest/async-storage-mock';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';
import { signInWithGoogleIdTokenAndStoreIdentity } from '../nativeGoogleAuth';

jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      signInWithIdToken: jest.fn(),
      getSession: jest.fn(),
    },
  },
}));

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';

const mockedAuth = supabase.auth as unknown as {
  signInWithIdToken: jest.Mock;
  getSession: jest.Mock;
};

const validSession = (userId: string) => ({
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  user: { id: userId, is_anonymous: false },
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockedAuth.getSession.mockResolvedValue({ data: { session: null } });
});

describe('signInWithGoogleIdTokenAndStoreIdentity', () => {
  it('signInWithIdToken returns valid session -> local UUID/name/email saved and success returned', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: validSession('uuid-direct-1'), user: { id: 'uuid-direct-1' } },
      error: null,
    });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('id-token-1', 'Sravani', 's@example.com');

    expect(result).toEqual({ ok: true, userId: 'uuid-direct-1' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe('uuid-direct-1');
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBe('Sravani');
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBe('s@example.com');
    expect(mockedAuth.getSession).not.toHaveBeenCalled();
  });

  it('signInWithIdToken returns auth error -> no authenticated local identity written and failure returned', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'bad_jwt', code: 'bad_jwt' },
    });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('bad-token', 'Sravani', 's@example.com');

    expect(result).toMatchObject({ ok: false, reason: 'auth-error' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBeNull();
    expect(mockedAuth.getSession).not.toHaveBeenCalled();
  });

  it('missing id token returns auth failure from Supabase without writing identity', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'missing token', code: 'validation_failed' },
    });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('', 'Sravani', 's@example.com');

    expect(mockedAuth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'google',
      token: '',
    });
    expect(result).toMatchObject({ ok: false, reason: 'auth-error' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBeNull();
  });

  it('signInWithIdToken returns user data but no session -> failure and no authenticated local identity written', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: { id: 'uuid-without-session' } },
      error: null,
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: { user: { id: 'different-uuid' } } } });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('id-token-2', 'Sravani', 's@example.com');

    expect(result).toEqual({ ok: false, reason: 'missing-session' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBeNull();
  });

  it('direct response lacks session but getSession returns valid same-user session -> success allowed and Supabase UUID saved', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: { id: 'uuid-restored-1' } },
      error: null,
    });
    mockedAuth.getSession.mockResolvedValue({
      data: { session: validSession('uuid-restored-1') },
    });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('id-token-3', 'Sravani', 's@example.com');

    expect(result).toEqual({ ok: true, userId: 'uuid-restored-1' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe('uuid-restored-1');
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBe('Sravani');
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBe('s@example.com');
  });

  it('direct response and getSession both lack session -> failure and no authenticated local identity written', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: { id: 'uuid-missing-everywhere' } },
      error: null,
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: null } });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('id-token-4', 'Sravani', 's@example.com');

    expect(result).toEqual({ ok: false, reason: 'missing-session' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBeNull();
  });

  it('existing valid same-user session behavior remains stable when fallback confirms that same user', async () => {
    await AsyncStorage.setItem(USER_ID_KEY, 'uuid-existing');
    await AsyncStorage.setItem(USER_NAME_KEY, 'Old Name');
    await AsyncStorage.setItem(USER_EMAIL_KEY, 'old@example.com');
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: { id: 'uuid-existing' } },
      error: null,
    });
    mockedAuth.getSession.mockResolvedValue({
      data: { session: validSession('uuid-existing') },
    });

    const result = await signInWithGoogleIdTokenAndStoreIdentity('id-token-5', 'New Name', 'new@example.com');

    expect(result).toEqual({ ok: true, userId: 'uuid-existing' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBe('uuid-existing');
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBe('New Name');
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBe('new@example.com');
  });

  it('storage failure returns auth failure instead of reporting successful sign-in', async () => {
    mockedAuth.signInWithIdToken.mockResolvedValue({
      data: { session: validSession('uuid-storage-fails'), user: { id: 'uuid-storage-fails' } },
      error: null,
    });
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));

    const result = await signInWithGoogleIdTokenAndStoreIdentity('id-token-6', 'Sravani', 's@example.com');

    expect(result).toMatchObject({ ok: false, reason: 'auth-error' });
    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
  });
});

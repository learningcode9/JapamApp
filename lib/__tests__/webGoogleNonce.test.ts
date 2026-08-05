import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_WEB_GOOGLE_NONCE_KEY,
  clearPendingWebGoogleNonce,
  readPendingWebGoogleNonce,
  savePendingWebGoogleNonce,
} from '../webGoogleNonce';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    default: {
      getItem: jest.fn(async (key: string) => store[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete store[key]; }),
      clear: jest.fn(async () => { Object.keys(store).forEach((key) => delete store[key]); }),
    },
    __esModule: true,
  };
});

describe('webGoogleNonce', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('saves and reads the raw nonce', async () => {
    await savePendingWebGoogleNonce('raw-google-nonce-123');

    expect(await readPendingWebGoogleNonce()).toBe('raw-google-nonce-123');
    expect(await AsyncStorage.getItem(PENDING_WEB_GOOGLE_NONCE_KEY)).toBe('raw-google-nonce-123');
  });

  it('clears the raw nonce', async () => {
    await savePendingWebGoogleNonce('raw-google-nonce-123');
    await clearPendingWebGoogleNonce();

    expect(await readPendingWebGoogleNonce()).toBeNull();
  });

  it('rejects missing or blank persisted nonce values', async () => {
    expect(await readPendingWebGoogleNonce()).toBeNull();

    await AsyncStorage.setItem(PENDING_WEB_GOOGLE_NONCE_KEY, '   ');

    expect(await readPendingWebGoogleNonce()).toBeNull();
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';

export const PENDING_WEB_GOOGLE_NONCE_KEY = 'pendingWebGoogleNonce';

export async function savePendingWebGoogleNonce(rawNonce: string): Promise<void> {
  await AsyncStorage.setItem(PENDING_WEB_GOOGLE_NONCE_KEY, rawNonce);
}

export async function readPendingWebGoogleNonce(): Promise<string | null> {
  const rawNonce = await AsyncStorage.getItem(PENDING_WEB_GOOGLE_NONCE_KEY);
  return rawNonce && rawNonce.trim() ? rawNonce : null;
}

export async function clearPendingWebGoogleNonce(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_WEB_GOOGLE_NONCE_KEY);
}

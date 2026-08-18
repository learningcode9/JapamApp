import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';
import { clearAnonymousFlag, LEGACY_USER_ID_KEY } from './anonymousAuth';
import { emitJapamAuthUpdated } from './authEvents';
import { cancelSessionRecovery } from './sessionRecovery';
import { supabase } from './supabase';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';

type SharedLogoutOptions = {
  clearLocalState?: () => Promise<void> | void;
  onLoggedOut?: () => Promise<void> | void;
};

const getFallbackStorageKey = (): string | null => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  } catch {
    return null;
  }
};

const getSupabaseSessionStorageKeys = (): string[] => {
  const authClient = supabase.auth as unknown as { storageKey?: string };
  const storageKey = authClient.storageKey || getFallbackStorageKey();
  if (!storageKey) return [];
  return [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`];
};

const clearPersistedSupabaseSession = async () => {
  const keys = getSupabaseSessionStorageKeys();
  if (keys.length > 0) {
    await AsyncStorage.multiRemove(keys);
  }
};

export async function runSharedLogoutFlow(options: SharedLogoutOptions = {}): Promise<void> {
  cancelSessionRecovery();
  await options.clearLocalState?.();

  await AsyncStorage.removeItem(USER_NAME_KEY);
  await AsyncStorage.removeItem(USER_EMAIL_KEY);
  await AsyncStorage.removeItem(USER_ID_KEY);
  await AsyncStorage.removeItem(LEGACY_USER_ID_KEY);
  await clearAnonymousFlag();

  let signOutFailed = false;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      signOutFailed = true;
      console.log('Supabase signOut error:', error);
    }
  } catch (error) {
    signOutFailed = true;
    console.log('Supabase signOut error:', error);
  }

  if (signOutFailed) {
    await clearPersistedSupabaseSession();
  }

  if (Platform.OS !== 'web') {
    try {
      await GoogleSignin.signOut();
    } catch (error) {
      console.log('Google signOut error:', error);
    }
  }

  emitJapamAuthUpdated();

  await options.onLoggedOut?.();
}

import { Linking, Platform } from 'react-native';
import { supabase } from './supabase';

export const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.japamapp.mantrajapam';

type UpdateCheckOptions = {
  platformOS?: string;
  installedBuildVersion?: string | number | null;
  fetchLatestVersionCode?: () => Promise<number | null>;
};

const parseVersionCode = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const getInstalledNativeBuildVersion = (): string | null => {
  try {
    // Load the native-only module when the Android check runs so web and Jest can fail closed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const application = require('expo-application') as typeof import('expo-application');
    return application.nativeBuildVersion ?? null;
  } catch {
    return null;
  }
};

export const fetchLatestAndroidVersionCode = async (): Promise<number | null> => {
  const { data, error } = await supabase.rpc('get_android_latest_version_code');
  if (error) throw error;
  return parseVersionCode(data);
};

export const shouldShowAndroidUpdateBanner = async ({
  platformOS = Platform.OS,
  installedBuildVersion,
  fetchLatestVersionCode = fetchLatestAndroidVersionCode,
}: UpdateCheckOptions = {}): Promise<boolean> => {
  if (platformOS !== 'android') return false;

  const installed = parseVersionCode(
    installedBuildVersion === undefined
      ? getInstalledNativeBuildVersion()
      : installedBuildVersion,
  );
  if (installed === null) return false;

  try {
    const latest = parseVersionCode(await fetchLatestVersionCode());
    return latest !== null && latest > installed;
  } catch {
    return false;
  }
};

export const openAndroidPlayStoreListing = async (): Promise<void> => {
  try {
    await Linking.openURL(ANDROID_PLAY_STORE_URL);
  } catch {
    // A failed handoff must not affect the rest of the app.
  }
};

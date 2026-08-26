import Constants from 'expo-constants';
import { AppState, Linking, Platform } from 'react-native';

export const ANDROID_TARGET_VERSION_CODE = 42;
export const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.japamapp.mantrajapam';

const parseVersionCode = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const getInstalledAndroidVersionCode = (
  androidManifestVersionCode: unknown = Constants.androidManifest?.versionCode,
): number | null => parseVersionCode(androidManifestVersionCode);

export const shouldShowAndroidUpdateBanner = ({
  platformOS = Platform.OS,
  installedVersionCode = getInstalledAndroidVersionCode(),
}: {
  platformOS?: string;
  installedVersionCode?: unknown;
} = {}): boolean => {
  if (platformOS !== 'android') return false;

  const installed = parseVersionCode(installedVersionCode);
  return installed !== null && installed < ANDROID_TARGET_VERSION_CODE;
};

export const subscribeToAndroidUpdateChecks = (
  onAvailabilityChange: (available: boolean) => void,
  check: () => boolean = shouldShowAndroidUpdateBanner,
): (() => void) => {
  if (Platform.OS !== 'android') return () => {};

  let active = true;
  const runCheck = () => {
    if (active) onAvailabilityChange(check());
  };

  runCheck();

  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') runCheck();
  });

  return () => {
    active = false;
    subscription.remove();
  };
};

export const openAndroidPlayStoreListing = async (): Promise<void> => {
  try {
    await Linking.openURL(ANDROID_PLAY_STORE_URL);
  } catch {
    // A failed handoff must not affect the rest of the app.
  }
};

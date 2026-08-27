import Constants from 'expo-constants';
import { AppState, Linking, Platform } from 'react-native';
import { supabase } from './supabase';

/** Compatibility target for the temporary updater during migration. */
export const LEGACY_ANDROID_TARGET_VERSION_CODE = 42;
export const ANDROID_TARGET_VERSION_CODE = LEGACY_ANDROID_TARGET_VERSION_CODE;
export const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.japamapp.mantrajapam';
export const ANDROID_UPDATE_MESSAGE = 'Get the latest version from Google Play.';

export type AndroidUpdateConfig = {
  latestVersionCode: number;
};

const parseVersionCode = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

/**
 * Read expo-application defensively. Older OTA binaries may not contain its
 * native module, so the manifest fallback must remain reachable.
 */
const getNativeBuildVersion = (): unknown => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const application = require('expo-application') as typeof import('expo-application');
    return application.nativeBuildVersion;
  } catch {
    return null;
  }
};

export const getInstalledAndroidVersionCode = (
  nativeBuildVersion: unknown = getNativeBuildVersion(),
  androidManifestVersionCode: unknown = Constants.androidManifest?.versionCode,
): number | null =>
  parseVersionCode(nativeBuildVersion) ?? parseVersionCode(androidManifestVersionCode);

/** Read the existing public read-only RPC; never access the protected table directly. */
export const fetchLatestAndroidVersionCode = async (): Promise<number | null> => {
  try {
    const { data, error } = await supabase.rpc('get_android_latest_version_code');
    if (error) return null;
    return parseVersionCode(data);
  } catch {
    return null;
  }
};

export const shouldShowLegacyAndroidUpdateBanner = ({
  platformOS = Platform.OS,
  installedVersionCode = getInstalledAndroidVersionCode(),
}: {
  platformOS?: string;
  installedVersionCode?: unknown;
} = {}): boolean => {
  if (platformOS !== 'android') return false;

  const installed = parseVersionCode(installedVersionCode);
  return installed !== null && installed < LEGACY_ANDROID_TARGET_VERSION_CODE;
};

/** @deprecated Use shouldShowAndroidUpdateFromConfig for the permanent updater. */
export const shouldShowAndroidUpdateBanner = shouldShowLegacyAndroidUpdateBanner;

export const shouldShowAndroidUpdateFromConfig = ({
  config,
  platformOS = Platform.OS,
  installedVersionCode = getInstalledAndroidVersionCode(),
}: {
  config: AndroidUpdateConfig | null;
  platformOS?: string;
  installedVersionCode?: unknown;
}): boolean => {
  if (platformOS !== 'android' || !config) return false;

  const installed = parseVersionCode(installedVersionCode);
  return installed !== null && installed < config.latestVersionCode;
};

export const resolveAndroidUpdateBannerConfig = ({
  permanentConfig,
  legacyAvailable,
}: {
  permanentConfig: AndroidUpdateConfig | null;
  legacyAvailable: boolean;
}): AndroidUpdateConfig | null =>
  permanentConfig ||
  (legacyAvailable ? { latestVersionCode: LEGACY_ANDROID_TARGET_VERSION_CODE } : null);

export const getAndroidUpdateAvailability = async ({
  platformOS = Platform.OS,
  installedVersionCode = getInstalledAndroidVersionCode(),
  fetchLatestVersionCode = fetchLatestAndroidVersionCode,
}: {
  platformOS?: string;
  installedVersionCode?: unknown;
  fetchLatestVersionCode?: () => Promise<number | null>;
} = {}): Promise<AndroidUpdateConfig | null> => {
  if (platformOS !== 'android') return null;

  const installed = parseVersionCode(installedVersionCode);
  if (installed === null) return null;

  let latest: number | null;
  try {
    latest = parseVersionCode(await fetchLatestVersionCode());
  } catch {
    return null;
  }
  return latest !== null && latest > installed ? { latestVersionCode: latest } : null;
};

type AvailabilityCheck<T> = () => T | Promise<T>;

const subscribeToChecks = <T>(
  onChange: (value: T) => void,
  check: AvailabilityCheck<T>,
  hasChanged: (previous: T | undefined, next: T) => boolean,
): (() => void) => {
  if (Platform.OS !== 'android') return () => {};

  let active = true;
  let inFlight: Promise<void> | null = null;
  let previous: T | undefined;

  const runCheck = () => {
    if (!active || inFlight) return;

    inFlight = Promise.resolve()
      .then(check)
      .then((next) => {
        if (!active || !hasChanged(previous, next)) return;
        previous = next;
        onChange(next);
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
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

/** Permanent server-backed check using get_android_latest_version_code(). */
export const subscribeToAndroidUpdateConfigChecks = (
  onAvailabilityChange: (config: AndroidUpdateConfig | null) => void,
  check: AvailabilityCheck<AndroidUpdateConfig | null> = getAndroidUpdateAvailability,
): (() => void) =>
  subscribeToChecks(onAvailabilityChange, check, (previous, next) => {
    if (previous === undefined) return true;
    if (previous === null || next === null) return previous !== next;
    return previous.latestVersionCode !== next.latestVersionCode;
  });

/** Legacy `<42` check retained for old OTA-compatible binaries and migration fallback. */
export const subscribeToAndroidUpdateChecks = (
  onAvailabilityChange: (available: boolean) => void,
  check: AvailabilityCheck<boolean> = shouldShowLegacyAndroidUpdateBanner,
): (() => void) => subscribeToChecks(onAvailabilityChange, check, (previous, next) => previous !== next);

export const openAndroidPlayStoreListing = async (): Promise<void> => {
  try {
    await Linking.openURL(ANDROID_PLAY_STORE_URL);
  } catch {
    // A failed handoff must not affect the rest of the app.
  }
};

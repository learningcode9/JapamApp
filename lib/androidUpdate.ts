import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { AppState, Linking, Platform } from 'react-native';

/**
 * Compatibility target for the temporary updater. Keep this export until the
 * native build containing the server-backed updater has broad adoption.
 */
export const LEGACY_ANDROID_TARGET_VERSION_CODE = 42;
export const ANDROID_TARGET_VERSION_CODE = LEGACY_ANDROID_TARGET_VERSION_CODE;
export const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.japamapp.mantrajapam';
const ANDROID_UPDATE_CONFIG_TABLE = 'android_app_update_config';
const ANDROID_UPDATE_CONFIG_SELECT =
  'latest_version_code,minimum_supported_version_code,play_store_url,message,force_update';

export type AndroidUpdateConfig = {
  latestVersionCode: number;
  minimumSupportedVersionCode: number | null;
  playStoreUrl: typeof ANDROID_PLAY_STORE_URL;
  message: string;
  forceUpdate: boolean;
};

const parseVersionCode = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the installed Android build number from the native module. The
 * expo-constants value remains a deliberate fallback for old OTA-compatible
 * binaries that predate the direct expo-application dependency.
 */
export const getInstalledAndroidVersionCode = (
  nativeBuildVersion: unknown = Application.nativeBuildVersion,
  androidManifestVersionCode: unknown = Constants.androidManifest?.versionCode,
): number | null =>
  parseVersionCode(nativeBuildVersion) ?? parseVersionCode(androidManifestVersionCode);

const parseAndroidUpdateConfig = (payload: unknown): AndroidUpdateConfig | null => {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(row)) return null;

  const latestVersionCode = parseVersionCode(row.latest_version_code);
  if (latestVersionCode === null) return null;

  const rawMinimum = row.minimum_supported_version_code;
  const minimumSupportedVersionCode =
    rawMinimum === undefined || rawMinimum === null ? null : parseVersionCode(rawMinimum);
  if (rawMinimum !== undefined && rawMinimum !== null && minimumSupportedVersionCode === null) {
    return null;
  }

  const rawPlayStoreUrl = row.play_store_url;
  if (rawPlayStoreUrl !== undefined && rawPlayStoreUrl !== null && rawPlayStoreUrl !== ANDROID_PLAY_STORE_URL) {
    return null;
  }

  const rawMessage = row.message;
  if (rawMessage !== undefined && rawMessage !== null && typeof rawMessage !== 'string') return null;

  const rawForceUpdate = row.force_update;
  if (rawForceUpdate !== undefined && rawForceUpdate !== null && typeof rawForceUpdate !== 'boolean') return null;

  return {
    latestVersionCode,
    minimumSupportedVersionCode,
    playStoreUrl: ANDROID_PLAY_STORE_URL,
    message:
      typeof rawMessage === 'string' && rawMessage.trim().length > 0
        ? rawMessage.trim().slice(0, 160)
        : 'Get the latest version from Google Play.',
    forceUpdate: rawForceUpdate === true,
  };
};

const getSupabaseUpdateConfigEndpoint = (): { endpoint: string; key: string } | null => {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const key = (
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();
  if (!supabaseUrl || !key) return null;

  return {
    endpoint:
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${ANDROID_UPDATE_CONFIG_TABLE}` +
      `?select=${encodeURIComponent(ANDROID_UPDATE_CONFIG_SELECT)}&limit=1`,
    key,
  };
};

export const fetchLatestAndroidUpdateConfig = async (
  fetchImpl: typeof fetch = fetch,
): Promise<AndroidUpdateConfig | null> => {
  if (Platform.OS !== 'android') return null;

  const request = getSupabaseUpdateConfigEndpoint();
  if (!request) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetchImpl(request.endpoint, {
      headers: {
        Accept: 'application/json',
        apikey: request.key,
        Authorization: `Bearer ${request.key}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseAndroidUpdateConfig(await response.json());
  } catch {
    // Update checks are strictly best effort; offline or missing config must
    // never gate startup or change normal app behavior.
    return null;
  } finally {
    clearTimeout(timeout);
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

export const getAndroidUpdateAvailability = async ({
  platformOS = Platform.OS,
  installedVersionCode = getInstalledAndroidVersionCode(),
  fetchConfig = fetchLatestAndroidUpdateConfig,
}: {
  platformOS?: string;
  installedVersionCode?: unknown;
  fetchConfig?: () => Promise<AndroidUpdateConfig | null>;
} = {}): Promise<AndroidUpdateConfig | null> => {
  if (platformOS !== 'android') return null;

  const installed = parseVersionCode(installedVersionCode);
  if (installed === null) return null;

  const config = await fetchConfig();
  return shouldShowAndroidUpdateFromConfig({ config, platformOS, installedVersionCode: installed })
    ? config
    : null;
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

export const subscribeToAndroidUpdateConfigChecks = (
  onAvailabilityChange: (config: AndroidUpdateConfig | null) => void,
  check: AvailabilityCheck<AndroidUpdateConfig | null> = getAndroidUpdateAvailability,
): (() => void) =>
  subscribeToChecks(onAvailabilityChange, check, (previous, next) => {
    if (previous === undefined) return true;
    if (previous === null || next === null) return previous !== next;
    return (
      previous.latestVersionCode !== next.latestVersionCode ||
      previous.message !== next.message ||
      previous.forceUpdate !== next.forceUpdate
    );
  });

/**
 * Boolean compatibility wrapper for callers that only need to know whether a
 * permanent update is available.
 */
export const subscribeToAndroidUpdateChecks = (
  onAvailabilityChange: (available: boolean) => void,
  check: AvailabilityCheck<boolean> = async () => (await getAndroidUpdateAvailability()) !== null,
): (() => void) => subscribeToChecks(onAvailabilityChange, check, (previous, next) => previous !== next);

export const openAndroidPlayStoreListing = async (): Promise<void> => {
  try {
    await Linking.openURL(ANDROID_PLAY_STORE_URL);
  } catch {
    // A failed handoff must not affect the rest of the app.
  }
};

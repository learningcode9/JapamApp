import { AppState, Linking } from 'react-native';
import * as Application from 'expo-application';
import {
  ANDROID_PLAY_STORE_URL,
  ANDROID_TARGET_VERSION_CODE,
  fetchLatestAndroidUpdateConfig,
  getAndroidUpdateAvailability,
  getInstalledAndroidVersionCode,
  openAndroidPlayStoreListing,
  shouldShowAndroidUpdateBanner,
  shouldShowAndroidUpdateFromConfig,
  subscribeToAndroidUpdateChecks,
  subscribeToAndroidUpdateConfigChecks,
} from '../androidUpdate';

jest.mock('expo-application', () => ({
  nativeBuildVersion: '41',
}));

jest.mock('expo-constants', () => ({
  androidManifest: { versionCode: 40 },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn() },
  Linking: { openURL: jest.fn(() => Promise.resolve()) },
  Platform: { OS: 'android' },
}));

const config = {
  latestVersionCode: 42,
  minimumSupportedVersionCode: null,
  playStoreUrl: ANDROID_PLAY_STORE_URL,
  message: 'Get the latest version from Google Play.',
  forceUpdate: false,
} as const;

const response = (body: unknown, ok = true) =>
  ({ ok, json: jest.fn().mockResolvedValue(body) }) as unknown as Response;

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Android update availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-key';
    (AppState.addEventListener as jest.Mock).mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('uses expo-application nativeBuildVersion and keeps the manifest fallback', () => {
    expect(Application.nativeBuildVersion).toBe('41');
    expect(getInstalledAndroidVersionCode()).toBe(41);
    expect(getInstalledAndroidVersionCode(null, 40)).toBe(40);
  });

  it.each([1, 19, 20, 30, 40, 41, '41'])('keeps the legacy popup for versionCode %s', (versionCode) => {
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: versionCode })).toBe(true);
  });

  it.each([ANDROID_TARGET_VERSION_CODE, 43, '42'])('keeps the legacy popup hidden for versionCode %s', (versionCode) => {
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: versionCode })).toBe(false);
  });

  it('shows the permanent banner when installed version is below the server version', () => {
    expect(shouldShowAndroidUpdateFromConfig({ config, installedVersionCode: 41 })).toBe(true);
  });

  it('hides the permanent banner when installed version equals or exceeds the server version', () => {
    expect(shouldShowAndroidUpdateFromConfig({ config, installedVersionCode: 42 })).toBe(false);
    expect(shouldShowAndroidUpdateFromConfig({ config, installedVersionCode: 43 })).toBe(false);
  });

  it('hides on iOS and web without fetching remote config', async () => {
    const fetchConfig = jest.fn().mockResolvedValue(config);
    expect(shouldShowAndroidUpdateFromConfig({ config, platformOS: 'ios', installedVersionCode: 1 })).toBe(false);
    expect(await getAndroidUpdateAvailability({ platformOS: 'web', fetchConfig })).toBeNull();
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it('fetches the public config contract and validates the Play Store URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response([{
      latest_version_code: '43',
      minimum_supported_version_code: 19,
      play_store_url: ANDROID_PLAY_STORE_URL,
      message: 'A calmer, newer Japam experience is ready.',
      force_update: false,
    }]));

    await expect(fetchLatestAndroidUpdateConfig(fetchImpl)).resolves.toEqual({
      latestVersionCode: 43,
      minimumSupportedVersionCode: 19,
      playStoreUrl: ANDROID_PLAY_STORE_URL,
      message: 'A calmer, newer Japam experience is ready.',
      forceUpdate: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v1/android_app_update_config?select='),
      expect.objectContaining({
        headers: expect.objectContaining({ apikey: 'public-key' }),
      }),
    );
  });

  it('fails safely for network errors, non-OK responses, and malformed config', async () => {
    await expect(fetchLatestAndroidUpdateConfig(jest.fn().mockRejectedValue(new Error('offline')))).resolves.toBeNull();
    await expect(fetchLatestAndroidUpdateConfig(jest.fn().mockResolvedValue(response({}, false)))).resolves.toBeNull();
    await expect(fetchLatestAndroidUpdateConfig(jest.fn().mockResolvedValue(response([{ latest_version_code: 'nope' }])))).resolves.toBeNull();
    await expect(fetchLatestAndroidUpdateConfig(jest.fn().mockResolvedValue(response([{ latest_version_code: 43, play_store_url: 'https://example.com' }])))).resolves.toBeNull();
    await expect(fetchLatestAndroidUpdateConfig(jest.fn().mockResolvedValue(response([{ latest_version_code: 43, minimum_supported_version_code: 'nope' }])))).resolves.toBeNull();
  });

  it('does not crash or show a banner when config is unavailable', async () => {
    const fetchConfig = jest.fn().mockResolvedValue(null);
    await expect(getAndroidUpdateAvailability({ installedVersionCode: 41, fetchConfig })).resolves.toBeNull();
  });

  it('checks at startup and again when active without repeating the same banner state', async () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      listeners.push(listener);
      return { remove };
    });
    const check = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onAvailabilityChange = jest.fn();

    const unsubscribe = subscribeToAndroidUpdateChecks(onAvailabilityChange, check);
    await flushAsync();
    expect(check).toHaveBeenCalledTimes(1);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(false);

    listeners[0]('active');
    await flushAsync();
    expect(check).toHaveBeenCalledTimes(2);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(1);

    listeners[0]('active');
    await flushAsync();
    expect(check).toHaveBeenCalledTimes(3);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('supports the reusable config subscription', async () => {
    const onAvailabilityChange = jest.fn();
    const unsubscribe = subscribeToAndroidUpdateConfigChecks(
      onAvailabilityChange,
      jest.fn().mockResolvedValue(config),
    );
    await flushAsync();
    expect(onAvailabilityChange).toHaveBeenCalledWith(config);
    unsubscribe();
  });

  it('opens the exact app Play Store listing', async () => {
    await openAndroidPlayStoreListing();
    expect(Linking.openURL).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL);
  });
});

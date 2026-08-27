import { AppState, Linking } from 'react-native';
import { supabase } from '../supabase';
import {
  ANDROID_PLAY_STORE_URL,
  ANDROID_TARGET_VERSION_CODE,
  fetchLatestAndroidVersionCode,
  getAndroidUpdateAvailability,
  getInstalledAndroidVersionCode,
  openAndroidPlayStoreListing,
  resolveAndroidUpdateBannerConfig,
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

jest.mock('../supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn() },
  Linking: { openURL: jest.fn(() => Promise.resolve()) },
  Platform: { OS: 'android' },
}));

const config = { latestVersionCode: 42 } as const;
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Android update availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState.addEventListener as jest.Mock).mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('reads the RPC latest version and returns the production value', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: '42', error: null });

    await expect(fetchLatestAndroidVersionCode()).resolves.toBe(42);
    expect(supabase.rpc).toHaveBeenCalledWith('get_android_latest_version_code');
  });

  it('prefers expo-application and keeps the expo-constants fallback', () => {
    expect(getInstalledAndroidVersionCode()).toBe(41);
    expect(getInstalledAndroidVersionCode(null, 40)).toBe(40);
  });

  it('shows for installed version 41 when the RPC returns 42', async () => {
    await expect(getAndroidUpdateAvailability({
      installedVersionCode: 41,
      fetchLatestVersionCode: async () => 42,
    })).resolves.toEqual(config);
    expect(shouldShowAndroidUpdateFromConfig({ config, installedVersionCode: 41 })).toBe(true);
  });

  it.each([42, 43])('hides for installed version %s when the RPC returns 42', async (installedVersionCode) => {
    await expect(getAndroidUpdateAvailability({
      installedVersionCode,
      fetchLatestVersionCode: async () => 42,
    })).resolves.toBeNull();
    expect(shouldShowAndroidUpdateFromConfig({ config, installedVersionCode })).toBe(false);
  });

  it('shows when the RPC later returns 43 while installed version is 42', async () => {
    await expect(getAndroidUpdateAvailability({
      installedVersionCode: 42,
      fetchLatestVersionCode: async () => 43,
    })).resolves.toEqual({ latestVersionCode: 43 });
  });

  it('fails safely for RPC errors, null results, and malformed values', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(fetchLatestAndroidVersionCode()).resolves.toBeNull();

    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: new Error('rpc failed') });
    await expect(fetchLatestAndroidVersionCode()).resolves.toBeNull();

    await expect(getAndroidUpdateAvailability({
      installedVersionCode: 41,
      fetchLatestVersionCode: async () => null,
    })).resolves.toBeNull();
    await expect(getAndroidUpdateAvailability({
      installedVersionCode: 41,
      fetchLatestVersionCode: async () => 'not-a-version' as unknown as number,
    })).resolves.toBeNull();
  });

  it('keeps the legacy <42 fallback available when the permanent RPC path fails', () => {
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: 41 })).toBe(true);
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: 42 })).toBe(false);
    expect(resolveAndroidUpdateBannerConfig({ permanentConfig: null, legacyAvailable: true })).toEqual({
      latestVersionCode: ANDROID_TARGET_VERSION_CODE,
    });
  });

  it('uses the permanent result when both paths report availability, so only one UI is rendered', () => {
    expect(resolveAndroidUpdateBannerConfig({ permanentConfig: { latestVersionCode: 43 }, legacyAvailable: true }))
      .toEqual({ latestVersionCode: 43 });
    expect(resolveAndroidUpdateBannerConfig({ permanentConfig: null, legacyAvailable: false })).toBeNull();
  });

  it('hides on iOS and web without invoking the RPC', async () => {
    const fetchLatestVersionCode = jest.fn(async () => 43);
    expect(shouldShowAndroidUpdateFromConfig({ config, platformOS: 'ios', installedVersionCode: 41 })).toBe(false);
    await expect(getAndroidUpdateAvailability({ platformOS: 'web', fetchLatestVersionCode })).resolves.toBeNull();
    expect(fetchLatestVersionCode).not.toHaveBeenCalled();
  });

  it('refreshes in the foreground and deduplicates unchanged banner state', async () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      listeners.push(listener);
      return { remove };
    });
    const check = jest.fn().mockResolvedValueOnce({ latestVersionCode: 42 })
      .mockResolvedValueOnce({ latestVersionCode: 42 })
      .mockResolvedValueOnce({ latestVersionCode: 43 });
    const onAvailabilityChange = jest.fn();
    const unsubscribe = subscribeToAndroidUpdateConfigChecks(onAvailabilityChange, check);

    await flushAsync();
    expect(check).toHaveBeenCalledTimes(1);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(1);

    listeners[0]('active');
    await flushAsync();
    expect(check).toHaveBeenCalledTimes(2);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(1);

    listeners[0]('active');
    await flushAsync();
    expect(check).toHaveBeenCalledTimes(3);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({ latestVersionCode: 43 });
    expect(onAvailabilityChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy subscriber wired and safe on RPC failure', async () => {
    const onAvailabilityChange = jest.fn();
    const unsubscribe = subscribeToAndroidUpdateChecks(onAvailabilityChange, async () => true);
    await flushAsync();
    expect(onAvailabilityChange).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it('opens the exact app Play Store listing', async () => {
    await openAndroidPlayStoreListing();
    expect(Linking.openURL).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL);
  });
});

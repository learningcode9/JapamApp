import { AppState, Linking } from 'react-native';
import {
  ANDROID_PLAY_STORE_URL,
  ANDROID_TARGET_VERSION_CODE,
  getInstalledAndroidVersionCode,
  openAndroidPlayStoreListing,
  shouldShowAndroidUpdateBanner,
  subscribeToAndroidUpdateChecks,
} from '../androidUpdate';

jest.mock('expo-constants', () => ({
  androidManifest: { versionCode: 41 },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn() },
  Linking: { openURL: jest.fn(() => Promise.resolve()) },
  Platform: { OS: 'android' },
}));

describe('Android update availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState.addEventListener as jest.Mock).mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('uses the native Android manifest versionCode without expo-application', () => {
    expect(getInstalledAndroidVersionCode()).toBe(41);
  });

  it.each([1, 19, 20, 30, 40, 41, '41'])('shows for installed versionCode %s', (versionCode) => {
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: versionCode })).toBe(true);
  });

  it.each([ANDROID_TARGET_VERSION_CODE, 43, '42'])('does not show for versionCode %s', (versionCode) => {
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: versionCode })).toBe(false);
  });

  it('does not show for unsupported or malformed version values', () => {
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: null })).toBe(false);
    expect(shouldShowAndroidUpdateBanner({ installedVersionCode: 'not-a-version' })).toBe(false);
    expect(shouldShowAndroidUpdateBanner({ platformOS: 'web', installedVersionCode: 41 })).toBe(false);
  });

  it('checks at startup and again when the app becomes active', () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      listeners.push(listener);
      return { remove };
    });
    const check = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const onAvailabilityChange = jest.fn();

    const unsubscribe = subscribeToAndroidUpdateChecks(onAvailabilityChange, check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(false);

    listeners[0]('background');
    expect(check).toHaveBeenCalledTimes(1);

    listeners[0]('active');
    expect(check).toHaveBeenCalledTimes(2);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(true);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
    listeners[0]('active');
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('opens the app Play Store listing', async () => {
    await openAndroidPlayStoreListing();
    expect(Linking.openURL).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL);
  });
});

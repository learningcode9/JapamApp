jest.mock('../supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

jest.mock('expo-application', () => ({
  nativeBuildVersion: '15',
}));

jest.mock('react-native', () => ({
  Linking: { openURL: jest.fn(() => Promise.resolve()) },
  Platform: { OS: 'android' },
}));

import { Linking } from 'react-native';
import {
  ANDROID_PLAY_STORE_URL,
  openAndroidPlayStoreListing,
  shouldShowAndroidUpdateBanner,
} from '../androidUpdate';

describe('Android update availability', () => {
  it('does not show for installed build 15 when latest is 15', async () => {
    await expect(shouldShowAndroidUpdateBanner({
      platformOS: 'android',
      fetchLatestVersionCode: async () => 15,
    })).resolves.toBe(false);
  });

  it('shows for installed build 15 when latest is 16', async () => {
    await expect(shouldShowAndroidUpdateBanner({
      platformOS: 'android',
      fetchLatestVersionCode: async () => 16,
    })).resolves.toBe(true);
  });

  it('opens the Android package Play Store listing', async () => {
    await openAndroidPlayStoreListing();

    expect(Linking.openURL).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL);
  });

  it('fails closed when the config request fails', async () => {
    await expect(shouldShowAndroidUpdateBanner({
      platformOS: 'android',
      installedBuildVersion: '15',
      fetchLatestVersionCode: async () => {
        throw new Error('offline');
      },
    })).resolves.toBe(false);
  });

  it('does not fetch or show on web', async () => {
    const fetchLatestVersionCode = jest.fn(async () => 16);

    await expect(shouldShowAndroidUpdateBanner({
      platformOS: 'web',
      installedBuildVersion: '15',
      fetchLatestVersionCode,
    })).resolves.toBe(false);
    expect(fetchLatestVersionCode).not.toHaveBeenCalled();
  });
});

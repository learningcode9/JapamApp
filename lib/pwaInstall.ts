import { Platform } from 'react-native';

export const isIOSSafariWeb = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const ua = navigator.userAgent || '';
  const vendor = navigator.vendor || '';
  const isIOSDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari =
    /Safari/.test(ua) &&
    !/(CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android)/.test(ua);

  return isIOSDevice && isSafari && /Apple/.test(vendor);
};

import { DeviceEventEmitter, Platform } from 'react-native';

export type AuthResponseRef<T extends object> = { current: T | null };

/**
 * Expo's auth-session response object remains populated after a successful callback. Effects that
 * also depend on render-driven callbacks must therefore claim the response object before doing
 * any completion work, or an unrelated provider refresh can process the same login again.
 */
export function claimAuthResponse<T extends object>(
  responseRef: AuthResponseRef<T>,
  response: T | null | undefined,
): response is T {
  if (!response || responseRef.current === response) return false;
  responseRef.current = response;
  return true;
}

/** Web uses the DOM event as its single delivery path; native keeps DeviceEventEmitter. */
export function emitJapamAuthUpdated(): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('japam-auth-updated'));
    return;
  }
  DeviceEventEmitter.emit('japam-auth-updated');
}

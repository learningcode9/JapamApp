jest.mock('react-native', () => ({
  DeviceEventEmitter: { emit: jest.fn() },
  Platform: { OS: 'android' },
}));

import { DeviceEventEmitter, Platform } from 'react-native';
import { claimAuthResponse, emitJapamAuthUpdated } from '../authEvents';

describe('auth event delivery', () => {
  const originalWindow = global.window;

  afterEach(() => {
    (Platform as { OS: string }).OS = 'android';
    global.window = originalWindow;
    jest.clearAllMocks();
  });

  it('claims one OAuth response only once across repeated renders', () => {
    const handled = { current: null as object | null };
    const response = { type: 'success', identity: 'A' };

    expect(claimAuthResponse(handled, response)).toBe(true);
    expect(claimAuthResponse(handled, response)).toBe(false);
    expect(claimAuthResponse(handled, response)).toBe(false);
  });

  it('allows legitimate later login responses, including A to B to A', () => {
    const handled = { current: null as object | null };
    const loginA1 = { type: 'success', identity: 'A' };
    const loginB = { type: 'success', identity: 'B' };
    const loginA2 = { type: 'success', identity: 'A' };

    expect(claimAuthResponse(handled, loginA1)).toBe(true);
    expect(claimAuthResponse(handled, loginB)).toBe(true);
    expect(claimAuthResponse(handled, loginA2)).toBe(true);
  });

  it('uses only the window path for one logical web notification', () => {
    const dispatchEvent = jest.fn();
    (Platform as { OS: string }).OS = 'web';
    global.window = { dispatchEvent } as unknown as Window & typeof globalThis;

    emitJapamAuthUpdated();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'japam-auth-updated' }));
    expect(DeviceEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('preserves DeviceEventEmitter delivery on native', () => {
    emitJapamAuthUpdated();

    expect(DeviceEventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('japam-auth-updated');
  });
});

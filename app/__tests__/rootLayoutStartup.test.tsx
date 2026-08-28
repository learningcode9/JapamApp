import React from 'react';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockReact = require('react');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer = require('react-test-renderer');
const { act } = renderer;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const defer = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const mockAppStateListeners: ((state: string) => void)[] = [];
const mockUpdateCheck = jest.fn();
const mockFetchUpdate = jest.fn();
const mockReloadUpdate = jest.fn();
let mockAuthReady: Promise<unknown>;
let mockRepairPromise: Promise<string | null>;
const mockRepairLegacyStoredUserId = jest.fn(() => mockRepairPromise);

const makeHost = (name: string) => {
  const Host = ({ children, ...props }: any) => mockReact.createElement(name, props, children);
  Host.displayName = name;
  return Host;
};

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
      mockAppStateListeners.push(listener);
      return { remove: jest.fn() };
    }),
  },
  Platform: { OS: 'android' },
  Pressable: makeHost('Pressable'),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Text: makeHost('Text'),
  View: makeHost('View'),
}));

jest.mock('@react-navigation/native', () => ({
  DarkTheme: {},
  DefaultTheme: {},
  ThemeProvider: makeHost('ThemeProvider'),
}));
jest.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ downloadAsync: jest.fn(() => Promise.resolve()) }) } }));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.13' }, androidManifest: { versionCode: 42 } }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));
jest.mock('expo-router', () => ({
  Stack: Object.assign(makeHost('Stack'), { Screen: makeHost('Stack.Screen') }),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: makeHost('StatusBar') }));
jest.mock('expo-updates', () => ({
  isEnabled: true,
  checkForUpdateAsync: (...args: unknown[]) => mockUpdateCheck(...args),
  fetchUpdateAsync: (...args: unknown[]) => mockFetchUpdate(...args),
  reloadAsync: (...args: unknown[]) => mockReloadUpdate(...args),
}));
jest.mock('react-native-paper', () => ({ PaperProvider: makeHost('PaperProvider') }));
jest.mock('react-native-reanimated', () => ({}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: jest.fn(() => ({ top: 0 })) }));
jest.mock('@/constants/assets', () => ({ ZEN_BACKGROUND: 1 }));
jest.mock('@/hooks/use-color-scheme', () => ({ useColorScheme: jest.fn(() => 'light') }));
jest.mock('../../components/LegacyHistoryBackfillRunner', () => () => mockReact.createElement('LegacyHistoryBackfillRunner'));
jest.mock('../../contexts/current-japam-context', () => ({ CurrentJapamProvider: makeHost('CurrentJapamProvider') }));
jest.mock('../../contexts/timer-context', () => ({ TimerProvider: makeHost('TimerProvider') }));
jest.mock('../../lib/androidUpdate', () => ({
  ANDROID_UPDATE_MESSAGE: 'Get the latest version from Google Play.',
  openAndroidPlayStoreListing: jest.fn(),
  resolveAndroidUpdateBannerConfig: jest.fn(() => null),
  subscribeToAndroidUpdateChecks: jest.fn(() => jest.fn()),
  subscribeToAndroidUpdateConfigChecks: jest.fn(() => jest.fn()),
}));
jest.mock('../../lib/anonymousAuth', () => ({
  repairLegacyStoredUserId: () => mockRepairLegacyStoredUserId(),
}));
jest.mock('../../lib/authLifecycle', () => ({
  startAuthLifecycle: jest.fn(() => ({ ready: mockAuthReady, stop: jest.fn() })),
}));

// eslint-disable-next-line import/first
import RootLayout from '../_layout';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const hasNavigator = (tree: any): boolean => tree.root.findAllByType('Stack').length > 0;

describe('RootLayout startup safety', () => {
  let auth: Deferred<unknown>;
  let repair: Deferred<string | null>;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    auth = defer<unknown>();
    repair = defer<string | null>();
    mockAuthReady = auth.promise;
    mockRepairPromise = repair.promise;
    mockAppStateListeners.length = 0;
    mockUpdateCheck.mockReset().mockResolvedValue({ isAvailable: false });
    mockFetchUpdate.mockReset().mockResolvedValue({ isNew: true });
    mockReloadUpdate.mockReset().mockResolvedValue(undefined);
    mockRepairLegacyStoredUserId.mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('renders the navigator when auth resolves while legacy repair remains pending', async () => {
    let tree: any;
    act(() => { tree = renderer.create(React.createElement(RootLayout)); });

    await act(async () => {
      auth.resolve({ kind: 'AUTHENTICATED' });
      await flush();
    });

    expect(mockRepairLegacyStoredUserId).toHaveBeenCalledTimes(1);
    expect(hasNavigator(tree)).toBe(true);
    repair.resolve('user-id');
    act(() => tree.unmount());
  });

  it('keeps startup available when legacy repair rejects and logs the failure', async () => {
    let tree: any;
    act(() => { tree = renderer.create(React.createElement(RootLayout)); });

    await act(async () => {
      auth.resolve({ kind: 'AUTHENTICATED' });
      await flush();
    });
    expect(hasNavigator(tree)).toBe(true);

    const repairError = new Error('offline');
    await act(async () => {
      repair.reject(repairError);
      await flush();
    });

    expect(hasNavigator(tree)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('[AUTH] Legacy user ID repair failed:', repairError);
    act(() => tree.unmount());
  });

  it('coalesces simultaneous startup and active OTA checks into one fetch and reload', async () => {
    const update = defer<{ isAvailable: boolean }>();
    mockUpdateCheck.mockReset().mockReturnValue(update.promise);
    let tree: any;
    act(() => { tree = renderer.create(React.createElement(RootLayout)); });

    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
    expect(mockAppStateListeners).toHaveLength(1);
    mockAppStateListeners[0]('active');
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);

    await act(async () => {
      update.resolve({ isAvailable: true });
      await flush();
      await flush();
    });

    expect(mockFetchUpdate).toHaveBeenCalledTimes(1);
    expect(mockReloadUpdate).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('resets the OTA guard after a failed check so a later active check can run', async () => {
    mockUpdateCheck
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ isAvailable: false });
    let tree: any;
    act(() => { tree = renderer.create(React.createElement(RootLayout)); });

    await act(async () => { await flush(); await flush(); });
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
    mockAppStateListeners[0]('active');
    await act(async () => { await flush(); await flush(); });

    expect(mockUpdateCheck).toHaveBeenCalledTimes(2);
    expect(mockFetchUpdate).not.toHaveBeenCalled();
    expect(mockReloadUpdate).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

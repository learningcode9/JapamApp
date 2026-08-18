/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockHydrateHistoryForUserDetails = jest.fn();
const mockRemoteHistoryFetch = jest.fn();
const mockWebListeners = new Map<string, Set<EventListener>>();

jest.mock('react-native', () => {
  const React = require('react');
  const host = (name: string) => React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement(name, { ...props, ref }, children));
  return {
    Alert: { alert: jest.fn() },
    DeviceEventEmitter: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
    Dimensions: { get: jest.fn(() => ({ width: 1024, height: 900 })) },
    ImageBackground: host('ImageBackground'),
    Keyboard: { dismiss: jest.fn() },
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => visible ? children : null,
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { absoluteFillObject: {}, create: (styles: Record<string, unknown>) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = require('react');
    React.useEffect(() => callback(), [callback]);
  },
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-auth-session/providers/google', () => ({ useAuthRequest: () => [{}, null, jest.fn()] }));
jest.mock('expo-auth-session', () => ({ ResponseType: { IdToken: 'id_token' } }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), signIn: jest.fn(), hasPlayServices: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../contexts/timer-context', () => ({
  LOOP_OPTIONS: [1, 2, 3, 5, 10],
  STD_DURATIONS: [1, 3, 5, 10, 15],
  formatTimer: (seconds: number) => String(seconds),
  useTimer: () => ({
    canStart: true,
    completedLoops: 0,
    isPaused: false,
    isRunning: false,
    pause: jest.fn(),
    reset: jest.fn(),
    selectDuration: jest.fn(),
    selectLoops: jest.fn(),
    selectedDuration: 10,
    selectedLoops: 1,
    setActiveJapamSelection: jest.fn(),
    start: jest.fn(),
    timeLeft: 600,
  }),
}));
jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => ({
    currentJapam: { id: 'japam-1', name: 'Morning Japam' },
    japams: [{ id: 'japam-1', name: 'Morning Japam', archivedAt: null }],
    isLoading: false,
  }),
}));
jest.mock('../../components/CurrentJapamHeaderButton', () => 'CurrentJapamHeaderButton');
jest.mock('../../lib/anonymousAuth', () => ({
  getIsAnonymous: jest.fn(),
  setIsAnonymous: jest.fn(),
  showGoogleAccountCollisionDialog: jest.fn(),
  signInAsGuest: jest.fn(),
  signInOrLinkGoogle: jest.fn(),
}));
jest.mock('../../lib/authEvents', () => ({ claimAuthResponse: jest.fn(() => false), emitJapamAuthUpdated: jest.fn() }));
jest.mock('../../lib/japams', () => ({ activeJapams: (japams: any[]) => japams.filter((japam) => !japam.archivedAt) }));
jest.mock('../../lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock('../../lib/supabaseRestHelper', () => ({
  fetchJapamHistoryRows: (...args: unknown[]) => mockRemoteHistoryFetch(...args),
}));
jest.mock('../../lib/historyRepository', () => ({
  hydrateHistoryForUserDetails: (...args: unknown[]) => mockHydrateHistoryForUserDetails(...args),
}));
jest.mock('../../constants/assets', () => ({ ZEN_BACKGROUND: 'zen-background' }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';

const renderer = require('react-test-renderer');
const { act } = renderer;
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';

const row = {
  date: new Date().toISOString(),
  malas: 2,
  totalCount: 216,
  duration: 0,
  manual: false,
  userId: 'user-1',
  completionId: 'remote-completion-1',
  syncStatus: 'synced',
  japamId: 'japam-1',
  japamName: 'Morning Japam',
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const dispatchWebEvent = async (eventName: string) => {
  await act(async () => {
    for (const listener of mockWebListeners.get(eventName) ?? []) listener(new Event(eventName));
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockWebListeners.clear();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(USER_ID_KEY, 'user-1');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (eventName: string, listener: EventListener) => {
        const listeners = mockWebListeners.get(eventName) ?? new Set<EventListener>();
        listeners.add(listener);
        mockWebListeners.set(eventName, listeners);
      },
      removeEventListener: (eventName: string, listener: EventListener) => mockWebListeners.get(eventName)?.delete(listener),
      location: { origin: 'https://local.example.test' },
      navigator: { standalone: false },
      matchMedia: () => ({ matches: false }),
    },
  });
});

describe('Timer local stats egress', () => {
  it('hydrates an empty cache once and keeps repeated stats events local-only', async () => {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
    mockHydrateHistoryForUserDetails.mockImplementation(async () => {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([row]));
      return { records: [row], hydrationSucceeded: true };
    });
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();

    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledWith(
      'user-1',
      undefined,
      { localFirst: false },
    );
    for (let i = 0; i < 5; i += 1) {
      await dispatchWebEvent('japam-stats-updated');
      await dispatchWebEvent('japam-history-updated');
    }
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();

    await act(async () => tree.unmount());
  });

  it('does not hydrate when the signed-in user already has local History', async () => {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([row]));
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();
    for (let i = 0; i < 5; i += 1) await dispatchWebEvent('japam-history-updated');

    expect(mockHydrateHistoryForUserDetails).not.toHaveBeenCalled();
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});

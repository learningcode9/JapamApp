/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockDeviceListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const mockWebListeners = new Map<string, Set<EventListener>>();
const mockRemoteHistoryFetch = jest.fn();
const mockHydrateHistoryForUserDetails = jest.fn();
const mockUseFocusEffect = (callback: () => void | (() => void)) => {
  const React = require('react');
  // The mock intentionally invokes the hook supplied by the screen under test.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  React.useEffect(() => callback(), [callback]);
};

jest.mock('react-native', () => {
  const React = require('react');
  const makeHost = (name: string) =>
    React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement(name, { ...props, ref }, children)
    );

  return {
    Alert: { alert: jest.fn() },
    DeviceEventEmitter: {
      addListener: jest.fn((eventName: string, callback: (...args: unknown[]) => void) => {
        const listeners = mockDeviceListeners.get(eventName) ?? new Set<(...args: unknown[]) => void>();
        listeners.add(callback);
        mockDeviceListeners.set(eventName, listeners);
        return { remove: () => listeners.delete(callback) };
      }),
      emit: jest.fn((eventName: string, ...args: unknown[]) => {
        for (const callback of mockDeviceListeners.get(eventName) ?? []) callback(...args);
      }),
    },
    Dimensions: { get: jest.fn(() => ({ width: 1024, height: 900 })) },
    ImageBackground: makeHost('ImageBackground'),
    Keyboard: { dismiss: jest.fn() },
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement(React.Fragment, null, children) : null,
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: makeHost('Pressable'),
    ScrollView: makeHost('ScrollView'),
    StyleSheet: { absoluteFillObject: {}, create: (styles: Record<string, unknown>) => styles },
    Text: makeHost('Text'),
    TextInput: makeHost('TextInput'),
    View: makeHost('View'),
  };
});

jest.mock('expo-router', () => ({
  useFocusEffect: mockUseFocusEffect,
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: () => [{}, null, jest.fn()],
}));
jest.mock('expo-auth-session', () => ({ ResponseType: { IdToken: 'id_token' } }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), signIn: jest.fn(), hasPlayServices: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
jest.mock('../../lib/anonymousAuth', () => ({
  getIsAnonymous: jest.fn(),
  setIsAnonymous: jest.fn(),
  showGoogleAccountCollisionDialog: jest.fn(),
  signInAsGuest: jest.fn(),
  signInOrLinkGoogle: jest.fn(),
}));
jest.mock('../../lib/authEvents', () => ({
  claimAuthResponse: jest.fn(() => false),
  emitJapamAuthUpdated: jest.fn(),
}));
jest.mock('../../lib/japams', () => ({
  activeJapams: (japams: { archivedAt: string | null }[]) => japams.filter((japam) => !japam.archivedAt),
}));
jest.mock('../../lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));
jest.mock('../../lib/supabaseRestHelper', () => ({
  fetchJapamHistoryRows: (...args: unknown[]) => mockRemoteHistoryFetch(...args),
}));
jest.mock('../../lib/historyRepository', () => ({
  hydrateHistoryForUserDetails: (...args: unknown[]) => mockHydrateHistoryForUserDetails(...args),
}));
jest.mock('../../constants/assets', () => ({ ZEN_BACKGROUND: 'zen-background' }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { DeviceEventEmitter } from 'react-native';

const renderer = require('react-test-renderer');
const { act } = renderer;
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';

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
  mockDeviceListeners.clear();
  mockWebListeners.clear();
  jest.clearAllMocks();
  mockHydrateHistoryForUserDetails.mockResolvedValue({
    records: [],
    hydrationSucceeded: false,
    localRecordCount: 0,
    hadLocalTombstones: false,
    scopedLocalTombstoneApplied: false,
    localStateAuthoritativelyChanged: false,
  });
  await AsyncStorage.clear();
  await AsyncStorage.setItem(USER_ID_KEY, 'user-1');
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([{
    date: '2026-08-17T09:00:00.000Z',
    malas: 2,
    totalCount: 216,
    duration: 0,
    manual: false,
    userId: 'user-1',
    completionId: 'completion-1',
    syncStatus: 'synced',
    japamId: 'japam-1',
    japamName: 'Morning Japam',
  }]));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (eventName: string, listener: EventListener) => {
        const listeners = mockWebListeners.get(eventName) ?? new Set<EventListener>();
        listeners.add(listener);
        mockWebListeners.set(eventName, listeners);
      },
      removeEventListener: (eventName: string, listener: EventListener) => {
        mockWebListeners.get(eventName)?.delete(listener);
      },
      location: { origin: 'https://staging.example.test' },
      navigator: { standalone: false },
      matchMedia: () => ({ matches: false }),
    },
  });
});

describe('Timer local stats egress', () => {
  it('hydrates a cold cache once and recomputes Timer stats after remote History lands', async () => {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
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

    const remoteRow = {
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
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([remoteRow]));
    await dispatchWebEvent('japam-history-updated');

    const malasLabel = tree.root.findAll((node: any) => node.props?.children === 'Malas Today')[0];
    const countLabel = tree.root.findAll((node: any) => node.props?.children === 'Today Count')[0];
    expect(malasLabel.parent.children[0].props.children).toBe(2);
    expect(countLabel.parent.children[0].props.children).toBe(216);
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('does not rehydrate after ten repeated web events following cold-cache hydration', async () => {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);

    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([{
      date: new Date().toISOString(),
      malas: 1,
      totalCount: 108,
      duration: 0,
      userId: 'user-1',
      completionId: 'remote-completion-2',
      syncStatus: 'synced',
      japamId: 'japam-1',
      japamName: 'Morning Japam',
    }]));
    for (let i = 0; i < 10; i += 1) {
      await dispatchWebEvent('japam-stats-updated');
      await dispatchWebEvent('japam-history-updated');
    }

    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('does not trigger remote hydration when the signed-in user already has local History', async () => {
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();

    expect(mockHydrateHistoryForUserDetails).not.toHaveBeenCalled();
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('keeps an offline empty cache safe without retrying hydration on events', async () => {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
    mockHydrateHistoryForUserDetails.mockRejectedValue(new Error('offline'));
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();

    for (let i = 0; i < 10; i += 1) {
      await dispatchWebEvent('japam-stats-updated');
      await dispatchWebEvent('japam-history-updated');
    }

    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('retries cold-cache hydration from auth recovery after an offline failure', async () => {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
    mockHydrateHistoryForUserDetails.mockRejectedValueOnce(new Error('offline'));
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);

    const recoveredRow = {
      date: new Date().toISOString(),
      malas: 2,
      totalCount: 216,
      duration: 0,
      userId: 'user-1',
      completionId: 'recovered-completion',
      syncStatus: 'synced',
      japamId: 'japam-1',
      japamName: 'Morning Japam',
    };
    mockHydrateHistoryForUserDetails.mockImplementationOnce(async () => {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([recoveredRow]));
      return {
        records: [recoveredRow],
        hydrationSucceeded: true,
        localRecordCount: 1,
        hadLocalTombstones: false,
        scopedLocalTombstoneApplied: false,
        localStateAuthoritativelyChanged: false,
      };
    });
    await dispatchWebEvent('japam-auth-updated');
    await flush();

    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(2);
    expect(mockHydrateHistoryForUserDetails).toHaveBeenLastCalledWith(
      'user-1',
      undefined,
      { localFirst: false },
    );
    const malasLabel = tree.root.findAll((node: any) => node.props?.children === 'Malas Today')[0];
    const countLabel = tree.root.findAll((node: any) => node.props?.children === 'Today Count')[0];
    expect(malasLabel.parent.children[0].props.children).toBe(2);
    expect(countLabel.parent.children[0].props.children).toBe(216);

    for (let i = 0; i < 10; i += 1) {
      await dispatchWebEvent('japam-stats-updated');
      await dispatchWebEvent('japam-history-updated');
    }
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(2);
    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('does not refetch remote history when repeated web stats/history events arrive', async () => {
    const historyReads = jest.spyOn(AsyncStorage, 'getItem');
    const TimerScreen = require('../(tabs)/timer').default;
    let tree: any;

    await act(async () => {
      tree = renderer.create(React.createElement(TimerScreen));
      await Promise.resolve();
    });
    await flush();

    expect(mockWebListeners.get('japam-stats-updated')?.size).toBe(1);
    expect(mockWebListeners.get('japam-history-updated')?.size).toBe(1);
    expect(DeviceEventEmitter.addListener).not.toHaveBeenCalledWith('japam-stats-updated', expect.any(Function));
    expect(DeviceEventEmitter.addListener).not.toHaveBeenCalledWith('japam-history-updated', expect.any(Function));

    for (let i = 0; i < 5; i += 1) {
      await dispatchWebEvent('japam-stats-updated');
      await dispatchWebEvent('japam-history-updated');
    }

    expect(mockRemoteHistoryFetch).not.toHaveBeenCalled();
    expect(historyReads.mock.calls.filter(([key]) => key === HISTORY_KEY).length).toBeGreaterThan(1);

    await act(async () => {
      tree.unmount();
    });
  });
});

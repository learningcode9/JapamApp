/* eslint-disable import/first, @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockJapams = [
  { id: 'workspace-a', userId: 'user-1', name: 'Japam A', syncStatus: 'synced', displayOrder: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null },
  { id: 'workspace-b', userId: 'user-1', name: 'Japam B', syncStatus: 'synced', displayOrder: null, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', archivedAt: null },
];
let mockCurrentJapamId = 'workspace-a';
const mockRpcResolvers: ((value: unknown) => void)[] = [];
const mockRpc = jest.fn();
const mockFetchJapamHistoryRows = jest.fn();
type MockDeviceListener = (payload?: unknown) => void;
const mockDeviceListeners = new Map<string, Set<MockDeviceListener>>();
const mockDeviceEventEmitter = {
  addListener: jest.fn((event: string, listener: MockDeviceListener) => {
    const listeners = mockDeviceListeners.get(event) ?? new Set<MockDeviceListener>();
    listeners.add(listener);
    mockDeviceListeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  }),
  emit: jest.fn((event: string, payload?: unknown) => {
    for (const listener of [...(mockDeviceListeners.get(event) ?? [])]) listener(payload);
  }),
};

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signInSilently: jest.fn(async () => ({ data: null })),
    signIn: jest.fn(async () => ({ data: null })),
    signOut: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: () => [{}, null, jest.fn()],
}));
jest.mock('expo-auth-session', () => ({ ResponseType: { IdToken: 'id_token' } }));
jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: jest.fn(async () => undefined),
    Sound: { createAsync: jest.fn(async () => ({ sound: { unloadAsync: jest.fn() } })) },
  },
}));
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(async () => undefined) }));
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  dismissNotificationAsync: jest.fn(async () => undefined),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => callback(), [callback]);
    },
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../../components/CurrentJapamHeaderButton', () => 'CurrentJapamHeaderButton');
jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => ({
    currentJapam: mockJapams.find((japam) => japam.id === mockCurrentJapamId) ?? null,
    japams: mockJapams,
    isLoading: false,
  }),
}));
jest.mock('../../lib/pwaInstall', () => ({
  isIOSDeviceWeb: jest.fn(() => false),
  isStandaloneOrInstalledWeb: jest.fn(() => false),
}));
jest.mock('../../lib/sharedLogout', () => ({ runSharedLogoutFlow: jest.fn(async () => undefined) }));
jest.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { getSession: jest.fn(async () => ({ data: { session: null } })) },
  },
}));
jest.mock('../../lib/supabaseRestHelper', () => ({
  fetchJapamHistoryRows: (...args: unknown[]) => mockFetchJapamHistoryRows(...args),
}));
jest.mock('../../lib/japamsRepository', () => ({ ensureJapamSyncedForHistory: jest.fn(async () => true) }));
jest.mock('../../lib/authEvents', () => ({ claimAuthResponse: jest.fn(), emitJapamAuthUpdated: jest.fn() }));

jest.mock('react-native', () => {
  const React = require('react');
  const host = (name: string) => {
    const Component = React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement(name, { ...props, ref }, children));
    Component.displayName = name;
    return Component;
  };
  return {
    Alert: { alert: jest.fn() },
    Animated: {
      Value: jest.fn(() => ({ setValue: jest.fn(), interpolate: jest.fn(() => 0) })),
      timing: jest.fn(() => ({ start: jest.fn() })),
      loop: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
      parallel: jest.fn(() => ({ start: jest.fn() })),
      sequence: jest.fn(() => ({ start: jest.fn() })),
      View: host('Animated.View'),
    },
    AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    get DeviceEventEmitter() {
      return mockDeviceEventEmitter;
    },
    Dimensions: { get: jest.fn(() => ({ width: 390, height: 844 })) },
    ImageBackground: host('ImageBackground'),
    Modal: ({ visible, children }: any) => (visible ? React.createElement(React.Fragment, null, children) : null),
    Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    Vibration: { vibrate: jest.fn() },
    View: host('View'),
    useWindowDimensions: jest.fn(() => ({ width: 390, height: 844 })),
  };
});

import JapamMain, {
  isCurrentHomeWorkspaceRefresh,
  resolveHomeWorkspaceTotal,
} from '../(tabs)/index';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const renderer = require('react-test-renderer');
const { act } = renderer;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

const localDayKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const localNoon = (daysAgo: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
};

const renderHome = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(JapamMain));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const statValue = (tree: any, label: string) => {
  const order = ['Malas today', 'Day streak', 'Today count'];
  const values = tree.root.findAll((node: any) =>
    node.type === 'Text' && node.props.style?.fontSize === 32
  );
  return values[order.indexOf(label)]?.props.children;
};

describe('Home bounded stats RPC and workspace isolation', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockCurrentJapamId = 'workspace-a';
    mockRpc.mockReset();
    mockRpcResolvers.length = 0;
    mockRpc.mockImplementation(() => new Promise((resolve) => {
      mockRpcResolvers.push(resolve);
    }));
    mockFetchJapamHistoryRows.mockClear();
    mockDeviceListeners.clear();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('loads the selected Japam through the bounded Home stats RPC', async () => {
    await AsyncStorage.setItem('userId', 'user-1');
    mockRpc.mockResolvedValueOnce({
      data: [{ today_count: 216, today_malas: 2, day_streak: 3 }],
      error: null,
    });

    const tree = await renderHome();

    expect(mockRpc).toHaveBeenCalledWith('get_home_stats', expect.objectContaining({
      p_japam_id: 'workspace-a',
      p_device_timezone: expect.any(String),
      p_today_start: expect.any(String),
      p_today_end: expect.any(String),
    }));
    expect(statValue(tree, 'Malas today')).toBe(2);
    expect(statValue(tree, 'Today count')).toBe(216);
    expect(statValue(tree, 'Day streak')).toBe(3);
  });

  it('ignores a stale RPC result after switching workspaces', async () => {
    await AsyncStorage.setItem('userId', 'user-1');
    const tree = await renderHome();
    expect(mockRpc).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockCurrentJapamId = 'workspace-b';
      mockDeviceEventEmitter.emit('japam-did-switch', { japamId: 'workspace-b' });
      tree.update(React.createElement(JapamMain));
      await Promise.resolve();
    });
    await flush();
    expect(mockRpc).toHaveBeenCalledTimes(2);

    mockRpcResolvers[1]({ data: [{ today_count: 54, today_malas: 0, day_streak: 2 }], error: null });
    await flush();
    const writesBeforeStaleA = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

    mockRpcResolvers[0]({ data: [{ today_count: 999, today_malas: 9, day_streak: 10 }], error: null });
    await flush();

    expect(statValue(tree, 'Today count')).toBe(54);
    expect(statValue(tree, 'Day streak')).toBe(2);
    expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(writesBeforeStaleA);
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-a')).toBeNull();
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-b')).toBe('54');
  });

  it('keeps local cached stats visible when the RPC fails', async () => {
    await AsyncStorage.multiSet([
      ['userId', 'user-1'],
      [`totalCount:user-1:workspace-a`, '324'],
      [`totalDate:user-1:workspace-a`, localDayKey()],
      ['history', JSON.stringify([
        { date: localNoon(0), totalCount: 108, malas: 1, userId: 'user-1', japamId: 'workspace-a', completionId: 'today-local' },
        { date: localNoon(1), totalCount: 108, malas: 1, userId: 'user-1', japamId: 'workspace-a', completionId: 'yesterday-local' },
      ])],
    ]);
    mockRpc.mockRejectedValueOnce(new Error('offline'));

    const tree = await renderHome();

    expect(statValue(tree, 'Today count')).toBe(324);
    expect(statValue(tree, 'Malas today')).toBe(3);
    expect(statValue(tree, 'Day streak')).toBe(2);
  });

  it('lets an unsynced local completion win over a stale server summary', async () => {
    const localPending = {
      date: localNoon(0),
      totalCount: 108,
      malas: 1,
      userId: 'user-1',
      japamId: 'workspace-a',
      completionId: 'pending-local',
      syncStatus: 'pending',
    };
    await AsyncStorage.multiSet([
      ['userId', 'user-1'],
      ['history', JSON.stringify([localPending])],
    ]);
    mockRpc.mockResolvedValueOnce({
      data: [{ today_count: 0, today_malas: 0, day_streak: 0 }],
      error: null,
    });

    const tree = await renderHome();

    expect(statValue(tree, 'Today count')).toBe(108);
    expect(statValue(tree, 'Malas today')).toBe(1);
    expect(statValue(tree, 'Day streak')).toBe(1);
    expect(JSON.parse(await AsyncStorage.getItem('history') || '[]')).toEqual([localPending]);
  });

  it('does not issue a raw full-history Home fetch', async () => {
    await AsyncStorage.setItem('userId', 'user-1');
    mockRpc.mockResolvedValueOnce({
      data: [{ today_count: 0, today_malas: 0, day_streak: 0 }],
      error: null,
    });

    await renderHome();

    expect(mockFetchJapamHistoryRows).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('get_home_stats', expect.any(Object));
  });

  it('rejects stale refreshes and preserves per-workspace non-regression', () => {
    const totalsByWorkspace = new Map<string | null, number>();
    const requestA = { generation: 1, workspaceId: 'workspace-a', workspaceVersion: 1 };

    expect(resolveHomeWorkspaceTotal(324, 'workspace-a', totalsByWorkspace)).toBe(324);
    expect(resolveHomeWorkspaceTotal(216, 'workspace-a', totalsByWorkspace)).toBe(324);
    expect(resolveHomeWorkspaceTotal(216, 'workspace-b', totalsByWorkspace)).toBe(216);
    expect(isCurrentHomeWorkspaceRefresh(requestA, 1, 2, 'workspace-b')).toBe(false);
    expect(isCurrentHomeWorkspaceRefresh(requestA, 2, 2, 'workspace-b')).toBe(false);
  });
});

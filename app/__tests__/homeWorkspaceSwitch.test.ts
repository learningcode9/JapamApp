/* eslint-disable import/first, @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockJapams = [
  { id: 'workspace-a', userId: 'user-1', name: 'Japam A', syncStatus: 'synced', displayOrder: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null },
  { id: 'workspace-b', userId: 'user-1', name: 'Japam B', syncStatus: 'synced', displayOrder: null, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', archivedAt: null },
];
let mockCurrentJapamId = 'workspace-a';
const mockFetchResolvers: ((value: unknown) => void)[] = [];
const mockFetchJapamHistoryRows = jest.fn(() => new Promise((resolve) => {
  mockFetchResolvers.push(resolve);
}));
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
    auth: { getSession: jest.fn(async () => ({ data: { session: null } })) },
  },
}));
jest.mock('../../lib/supabaseRestHelper', () => ({
  get fetchJapamHistoryRows() {
    return mockFetchJapamHistoryRows;
  },
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

describe('Home offline workspace total isolation', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockCurrentJapamId = 'workspace-a';
    mockFetchJapamHistoryRows.mockClear();
    mockFetchResolvers.length = 0;
    mockDeviceListeners.clear();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('never carries Workspace A total into Workspace B offline, then restores A when switching back', () => {
    const totalsByWorkspace = new Map<string | null, number>();

    expect(resolveHomeWorkspaceTotal(216, 'workspace-a', totalsByWorkspace)).toBe(216);
    expect(resolveHomeWorkspaceTotal(0, 'workspace-b', totalsByWorkspace)).toBe(0);
    expect(resolveHomeWorkspaceTotal(0, 'workspace-a', totalsByWorkspace)).toBe(216);
  });

  it('rejects a stale Workspace A refresh after Workspace B becomes active', () => {
    const requestA = { generation: 1, workspaceId: 'workspace-a', workspaceVersion: 1 };

    expect(isCurrentHomeWorkspaceRefresh(requestA, 1, 2, 'workspace-b')).toBe(false);
    expect(isCurrentHomeWorkspaceRefresh(requestA, 2, 2, 'workspace-b')).toBe(false);
  });

  it('preserves same-workspace non-regression while allowing a new workspace to start at zero', () => {
    const totalsByWorkspace = new Map<string | null, number>();

    expect(resolveHomeWorkspaceTotal(324, 'workspace-a', totalsByWorkspace)).toBe(324);
    expect(resolveHomeWorkspaceTotal(216, 'workspace-a', totalsByWorkspace)).toBe(324);
    expect(resolveHomeWorkspaceTotal(216, 'workspace-b', totalsByWorkspace)).toBe(216);
  });

  it('mounts Home, switches A→B offline, and ignores a stale A refresh without unscoped writes', async () => {
    const today = new Date().toISOString();
    const localHistory = [{
      date: today,
      malas: 2,
      totalCount: 217,
      duration: 0,
      manual: false,
      userId: 'user-1',
      completionId: 'a-local',
      syncStatus: 'synced' as const,
      japamId: 'workspace-a',
      japamName: 'Japam A',
    }];
    await AsyncStorage.multiSet([
      ['userId', 'user-1'],
      ['totalCount:user-1', '217'],
      ['totalDate:user-1', today.slice(0, 10)],
      ['history', JSON.stringify(localHistory)],
    ]);
    (AsyncStorage.setItem as jest.Mock).mockClear();

    let tree: any;
    await act(async () => {
      tree = renderer.create(React.createElement(JapamMain));
      await Promise.resolve();
    });
    await flush();

    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-a')).toBe('217');
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-b')).toBeNull();
    expect((AsyncStorage.setItem as jest.Mock).mock.calls.some(([key]) => key === 'totalCount:user-1')).toBe(false);

    const staleAResolver = mockFetchResolvers[0];
    await act(async () => {
      mockCurrentJapamId = 'workspace-b';
      mockDeviceEventEmitter.emit('japam-did-switch', { japamId: 'workspace-b' });
      tree.update(React.createElement(JapamMain));
      await Promise.resolve();
    });
    await flush();

    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(2);
    const writesBeforeStaleA = (AsyncStorage.setItem as jest.Mock).mock.calls.length;
    await act(async () => {
      staleAResolver([{ created_at: today, malas: 2, count: 217, completion_id: 'a-remote', japam_id: 'workspace-a', japam_name: 'Japam A' }]);
      await Promise.resolve();
    });
    await flush();

    expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(writesBeforeStaleA);
    expect(await AsyncStorage.getItem('history')).toBe(JSON.stringify(localHistory));
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-b')).toBeNull();
    expect(await AsyncStorage.getItem('totalCount:user-1')).toBe('217');

    const progressCount = tree.root.findAll((node: any) => node.type === 'Text' && node.props.style?.fontSize === 72);
    expect(progressCount[0]?.children).toEqual(['0']);

    mockFetchResolvers[1]?.(null);
    await flush();
  });

  it('does not persist Workspace A totals under Workspace B when the persistence user read resolves after switching', async () => {
    const today = new Date().toISOString();
    const localHistory = [{
      date: today,
      malas: 2,
      totalCount: 217,
      duration: 0,
      manual: false,
      userId: 'user-1',
      userName: 'Test User',
      completionId: 'a-local',
      syncStatus: 'synced' as const,
      japamId: 'workspace-a',
      japamName: 'Japam A',
    }];
    await AsyncStorage.multiSet([
      ['userId', 'user-1'],
      ['userName', 'Test User'],
      ['history', JSON.stringify(localHistory)],
    ]);

    let tree: any;
    await act(async () => {
      tree = renderer.create(React.createElement(JapamMain));
      await Promise.resolve();
    });
    await flush();

    const originalGetItem = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
    const releaseUserIdRead = jest.fn();
    let resolveUserIdRead!: (value: string) => void;
    let holdNextUserIdRead = true;
    (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) => {
      if (key === 'userId' && holdNextUserIdRead) {
        holdNextUserIdRead = false;
        return new Promise<string>((resolve) => {
          resolveUserIdRead = (value: string) => {
            releaseUserIdRead();
            resolve(value);
          };
        });
      }
      return originalGetItem?.(key);
    });

    const multiSetMock = AsyncStorage.multiSet as jest.Mock;
    multiSetMock.mockClear();
    const pressables = tree.root.findAll((node: any) => typeof node.props.onPress === 'function');
    expect(pressables.length).toBeGreaterThan(1);
    await act(async () => {
      pressables[2].props.onPress();
      await Promise.resolve();
    });

    await act(async () => {
      mockCurrentJapamId = 'workspace-b';
      mockDeviceEventEmitter.emit('japam-did-switch', { japamId: 'workspace-b' });
      tree.update(React.createElement(JapamMain));
      await Promise.resolve();
      resolveUserIdRead?.('user-1');
      await Promise.resolve();
    });
    await flush();

    expect(releaseUserIdRead).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-a')).toBe('218');
    expect(await AsyncStorage.getItem('totalCount:user-1:workspace-b')).not.toBe('218');
    const persistedPairs = multiSetMock.mock.calls.flatMap(([pairs]) => pairs as [string, string][]);
    expect(persistedPairs).not.toContainEqual(['totalCount:user-1:workspace-b', '218']);

    (AsyncStorage.getItem as jest.Mock).mockImplementation(originalGetItem);
    mockFetchResolvers.forEach((resolve) => resolve(null));
    await flush();
  });

  it('lets the current Workspace B refresh own the final shared history write after A is switched away', async () => {
    const today = new Date().toISOString();
    const localHistory = [{
      date: today,
      malas: 1,
      totalCount: 108,
      duration: 0,
      manual: false,
      userId: 'user-1',
      completionId: 'a-local',
      syncStatus: 'synced' as const,
      japamId: 'workspace-a',
      japamName: 'Japam A',
    }];
    await AsyncStorage.multiSet([
      ['userId', 'user-1'],
      ['history', JSON.stringify(localHistory)],
    ]);

    let tree: any;
    await act(async () => {
      tree = renderer.create(React.createElement(JapamMain));
      await Promise.resolve();
    });
    await flush();
    expect(mockFetchResolvers).toHaveLength(1);

    const originalSetItem = (AsyncStorage.setItem as jest.Mock).getMockImplementation();
    const historyPayloads: string[] = [];
    let historyWriteStarted = false;
    let releaseHistoryWrite!: () => void;
    const historyWriteGate = new Promise<void>((resolve) => {
      releaseHistoryWrite = resolve;
    });
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      if (key === 'history') {
        historyPayloads.push(value);
        if (!historyWriteStarted) {
          historyWriteStarted = true;
          await historyWriteGate;
        }
      }
      return originalSetItem?.(key, value);
    });

    await act(async () => {
      mockFetchResolvers[0]([{ created_at: today, malas: 1, count: 108, completion_id: 'a-remote', japam_id: 'workspace-a', japam_name: 'Japam A' }]);
      await Promise.resolve();
    });
    await flush();
    expect(historyWriteStarted).toBe(true);

    await act(async () => {
      mockCurrentJapamId = 'workspace-b';
      mockDeviceEventEmitter.emit('japam-did-switch', { japamId: 'workspace-b' });
      tree.update(React.createElement(JapamMain));
      await Promise.resolve();
    });
    await flush();
    expect(mockFetchResolvers).toHaveLength(2);

    releaseHistoryWrite();
    await act(async () => {
      mockFetchResolvers[1]([{ created_at: today, malas: 1, count: 108, completion_id: 'b-remote', japam_id: 'workspace-b', japam_name: 'Japam B' }]);
      await Promise.resolve();
    });
    await flush();

    expect(historyPayloads.length).toBeGreaterThanOrEqual(2);
    const finalHistory = JSON.parse(historyPayloads[historyPayloads.length - 1]);
    expect(finalHistory.some((session: any) => session.completionId === 'b-remote')).toBe(true);
    expect(await AsyncStorage.getItem('history')).toBe(historyPayloads[historyPayloads.length - 1]);

    (AsyncStorage.setItem as jest.Mock).mockImplementation(originalSetItem);
  });
});

/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

/**
 * Component tests for app/(tabs)/groups-dashboard.tsx's workspace scope (Issue 3).
 *
 * The dashboard shows a group through the VIEWER's membership, which is tied to the Japam the
 * viewer created/joined the group under. These tests pin that the load passes that japamId to
 * get_group_dashboard (so the server scopes the whole roster per member), that a slow response
 * for a previously-selected workspace never paints rows into the new workspace, and that once a
 * load has established a workspace, switching the selected Japam bounces the viewer back to the
 * workspace-scoped group list instead of showing a stale/incorrect dashboard.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const mockReplace = jest.fn();

jest.mock('react-native', () => {
  const React = require('react');
  const makeHost = (name: string, mapProps?: (props: any) => any) =>
    React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement(name, { ...(mapProps ? mapProps(props) : props), ref }, children)
    );

  return {
    View: makeHost('View'),
    Text: makeHost('Text'),
    ScrollView: makeHost('ScrollView'),
    TextInput: makeHost('TextInput'),
    ActivityIndicator: makeHost('ActivityIndicator'),
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement(React.Fragment, null, children) : null,
    Alert: { alert: jest.fn() },
    Share: { share: jest.fn() },
    Dimensions: { get: jest.fn(() => ({ width: 400, height: 800 })) },
    Pressable: makeHost('Pressable', (props: any) => ({
      ...props,
      style: typeof props.style === 'function' ? props.style({ pressed: false }) : props.style,
    })),
    DeviceEventEmitter: {
      addListener: jest.fn((eventName: string, callback: (...args: unknown[]) => void) => {
        const set = mockListeners.get(eventName) ?? new Set<(...args: unknown[]) => void>();
        set.add(callback);
        mockListeners.set(eventName, set);
        return { remove: () => set.delete(callback) };
      }),
      emit: jest.fn((eventName: string, ...args: unknown[]) => {
        for (const callback of mockListeners.get(eventName) ?? []) {
          callback(...args);
        }
      }),
    },
    Platform: {
      OS: 'android',
      select: (options: Record<string, unknown>) => options.android ?? options.default,
    },
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
    },
  };
});

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ back: jest.fn(), replace: mockReplace }),
    useLocalSearchParams: () => ({ groupId: 'group-1', groupName: 'Family' }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = callback();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, [callback]);
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name),
  };
});

const mockGetGroupDashboard = jest.fn();
const mockGetGroupInviteCode = jest.fn();
const mockRenameGroup = jest.fn();
const mockRemoveGroupMember = jest.fn();
const mockDeleteGroup = jest.fn();
const mockLeaveGroup = jest.fn();

jest.mock('../../lib/groupsRepository', () => ({
  getGroupDashboard: (...args: unknown[]) => mockGetGroupDashboard(...args),
  getGroupInviteCode: (...args: unknown[]) => mockGetGroupInviteCode(...args),
  renameGroup: (...args: unknown[]) => mockRenameGroup(...args),
  removeGroupMember: (...args: unknown[]) => mockRemoveGroupMember(...args),
  deleteGroup: (...args: unknown[]) => mockDeleteGroup(...args),
  leaveGroup: (...args: unknown[]) => mockLeaveGroup(...args),
}));

let mockCurrentJapamState: { currentJapamId: string | null };

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => mockCurrentJapamState,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import GroupsDashboardScreen from '../(tabs)/groups-dashboard';

const UID = 'user-a';
const WORKSPACE_A = '550e8400-e29b-41d4-a716-446655440001';
const WORKSPACE_B = '550e8400-e29b-41d4-a716-446655440002';

const row = (userId: string, userName: string) => ({
  userId,
  userName,
  role: 'member' as const,
  joinedAt: '2026-01-01T00:00:00Z',
  todayMalas: 3,
  todayCount: 2,
  totalMalas: 12,
  totalCount: 8,
  lastUpdated: '2026-07-31T05:00:00.000Z',
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const renderScreen = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(GroupsDashboardScreen));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const updateTree = async (tree: any) => {
  await act(async () => {
    tree.update(React.createElement(GroupsDashboardScreen));
    await Promise.resolve();
  });
  await flush();
};

const extractText = (value: any): string => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractText).join('');
  return extractText(value.props?.children);
};

const allText = (tree: any) =>
  tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => extractText(node));

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  mockListeners.clear();
  jest.clearAllMocks();
  // The dashboard's 12s polling interval would otherwise keep the Node event loop alive.
  jest.spyOn(global, 'setInterval').mockImplementation(() => 1 as any);
  jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
  await AsyncStorage.clear();
  await AsyncStorage.setItem('userId', UID);
  mockCurrentJapamState = { currentJapamId: WORKSPACE_A };
  mockGetGroupDashboard.mockResolvedValue([row(`${UID}-b`, 'Person B')]);
  mockGetGroupInviteCode.mockResolvedValue('ABCDEFG');
});

describe('Groups dashboard workspace scope', () => {
  it('loads the dashboard with the viewer current japamId', async () => {
    await renderScreen();
    expect(mockGetGroupDashboard).toHaveBeenCalledWith(
      'group-1',
      UID,
      expect.any(String),
      expect.any(String),
      WORKSPACE_A
    );
  });

  it('does not navigate back before any load has established a workspace (first mount)', async () => {
    const pending = createDeferred<any[]>();
    mockGetGroupDashboard.mockImplementationOnce(() => pending.promise);
    await renderScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('bounces back to the group list when the selected Japam changes after a load', async () => {
    const tree = await renderScreen();
    expect(mockReplace).not.toHaveBeenCalled();

    mockGetGroupDashboard.mockResolvedValue([row(`${UID}-b`, 'Person B')]);
    mockCurrentJapamState = { currentJapamId: WORKSPACE_B };
    await updateTree(tree);

    expect(mockReplace).toHaveBeenCalledWith('/groups');
  });

  it('never paints a slow prior-workspace response into the new workspace', async () => {
    const staleA = createDeferred<any[]>();
    mockGetGroupDashboard.mockImplementationOnce(() => staleA.promise);
    const tree = await renderScreen();

    // Switch to Workspace B while the Workspace-A load is still in flight.
    mockCurrentJapamState = { currentJapamId: WORKSPACE_B };
    await updateTree(tree);

    // The switch bounces the viewer back to the list (the group is scoped to Workspace A)...
    expect(mockReplace).toHaveBeenCalledWith('/groups');

    // ...and the stale Workspace-A response that lands late must not paint Person A rows.
    staleA.resolve([row(`${UID}-a`, 'Person A')]);
    await flush();
    expect(allText(tree).join(' ')).not.toContain('Person A');
  });
});

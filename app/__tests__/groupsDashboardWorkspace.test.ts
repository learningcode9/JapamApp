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
const mockBackHandlers = new Set<() => boolean>();
const browserListeners = new Map<string, Set<() => void>>();
const mockReplace = jest.fn();
let mockIsFocused = true;
let mockPathname = '/groups-dashboard';
let mockAuthCallback: ((event: string, session: unknown) => void) | null = null;
let mockPlatformOS = 'android';

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
    BackHandler: {
      addEventListener: jest.fn((_eventName: string, callback: () => boolean) => {
        mockBackHandlers.add(callback);
        return { remove: () => mockBackHandlers.delete(callback) };
      }),
    },
    Platform: {
      get OS() {
        return mockPlatformOS;
      },
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
    usePathname: () => mockPathname,
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = callback();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, [callback]);
    },
  };
});

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockIsFocused,
}));

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
const mockGetCachedGroupDashboard = jest.fn();
const mockGetGroupInviteCode = jest.fn();
const mockRenameGroup = jest.fn();
const mockRemoveGroupMember = jest.fn();
const mockDeleteGroup = jest.fn();
const mockLeaveGroup = jest.fn();
const mockGetSession = jest.fn();
const mockIsNetworkFailure = jest.fn();

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      onAuthStateChange: (_event: string, callback: (event: string, session: unknown) => void) => {
        mockAuthCallback = callback;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
    },
  },
}));

jest.mock('../../lib/groupsRepository', () => ({
  getCachedGroupDashboard: (...args: unknown[]) => mockGetCachedGroupDashboard(...args),
  getGroupDashboard: (...args: unknown[]) => mockGetGroupDashboard(...args),
  getGroupInviteCode: (...args: unknown[]) => mockGetGroupInviteCode(...args),
  isNetworkFailure: (...args: unknown[]) => mockIsNetworkFailure(...args),
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

const setBrowserOnline = (online: boolean) => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: online },
  });
};

const dispatchBrowserEvent = (eventName: string) => {
  for (const listener of browserListeners.get(eventName) ?? []) listener();
};

const row = (userId: string, userName: string, role: 'admin' | 'member' = 'member') => ({
  userId,
  userName,
  role,
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

const press = async (tree: any, label: string) => {
  const button = tree.root.findAll(
    (node: any) => node.type === 'Pressable' && node.findAll(
      (child: any) => child.type === 'Text' && extractText(child) === label
    ).length > 0
  )[0];
  expect(button).toBeDefined();
  await act(async () => {
    button.props.onPress();
    await Promise.resolve();
  });
  await flush();
};

const pressByAccessibilityLabel = async (tree: any, label: string) => {
  const button = tree.root.findAll(
    (node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === label
  )[0];
  expect(button).toBeDefined();
  await act(async () => {
    button.props.onPress();
    await Promise.resolve();
  });
  await flush();
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  mockListeners.clear();
  browserListeners.clear();
  mockBackHandlers.clear();
  mockAuthCallback = null;
  jest.clearAllMocks();
  mockPlatformOS = 'android';
  setBrowserOnline(true);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (eventName: string, listener: () => void) => {
        const listeners = browserListeners.get(eventName) ?? new Set<() => void>();
        listeners.add(listener);
        browserListeners.set(eventName, listeners);
      },
      removeEventListener: (eventName: string, listener: () => void) => {
        browserListeners.get(eventName)?.delete(listener);
      },
    },
  });
  mockIsFocused = true;
  mockPathname = '/groups-dashboard';
  // The dashboard's 12s polling interval would otherwise keep the Node event loop alive.
  jest.spyOn(global, 'setInterval').mockImplementation(() => 1 as any);
  jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
  await AsyncStorage.clear();
  await AsyncStorage.setItem('userId', UID);
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'fresh-session-token', user: { id: UID } } },
  });
  mockCurrentJapamState = { currentJapamId: WORKSPACE_A };
  mockGetCachedGroupDashboard.mockResolvedValue(null);
  mockGetGroupDashboard.mockResolvedValue([row(`${UID}-b`, 'Person B')]);
  mockGetGroupInviteCode.mockResolvedValue('ABCDEFG');
  mockDeleteGroup.mockResolvedValue({ kind: 'success' });
  mockLeaveGroup.mockResolvedValue({ kind: 'success' });
  mockIsNetworkFailure.mockImplementation((error: unknown) => error instanceof TypeError);
});

describe('Groups dashboard leave and delete actions', () => {
  it('lets the last admin delete the group and returns to Groups without using Leave', async () => {
    mockGetGroupDashboard.mockResolvedValue([row(UID, 'Admin', 'admin')]);
    const tree = await renderScreen();

    await pressByAccessibilityLabel(tree, 'Open group admin menu');
    await press(tree, 'Delete Group');

    expect(allText(tree)).toContain('Delete group?');
    expect(allText(tree)).not.toContain('Leave group?');
    expect(allText(tree).join(' ')).toContain('Personal Japam history will stay safe.');

    await press(tree, 'Delete');

    expect(mockDeleteGroup).toHaveBeenCalledWith('group-1', UID);
    expect(mockLeaveGroup).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/groups');
  });

  it('opens Leave confirmation and invokes only the leave action', async () => {
    mockGetGroupDashboard.mockResolvedValue([row(UID, 'Member')]);
    const tree = await renderScreen();

    await press(tree, 'Leave Group');

    expect(allText(tree)).toContain('Leave group?');
    expect(allText(tree)).not.toContain('Delete group?');

    await press(tree, 'Leave');

    expect(mockLeaveGroup).toHaveBeenCalledWith('group-1', UID);
    expect(mockDeleteGroup).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/groups');
  });

  it('returns to Groups on Android hardware back', async () => {
    await renderScreen();
    mockReplace.mockClear();

    expect(mockBackHandlers.size).toBe(1);
    const [hardwareBackHandler] = [...mockBackHandlers];
    expect(hardwareBackHandler()).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith('/groups');
  });
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

  it('does not replace History when the dashboard is unfocused during a workspace switch', async () => {
    const tree = await renderScreen();
    expect(mockReplace).not.toHaveBeenCalled();

    // The dashboard remains mounted in the tab navigator, but History is now the focused route.
    mockIsFocused = false;
    mockPathname = '/history';
    mockCurrentJapamState = { currentJapamId: WORKSPACE_B };
    await updateTree(tree);

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not call the dashboard RPC when workspace switches while /groups is active', async () => {
    const tree = await renderScreen();
    const callsBeforeSwitch = mockGetGroupDashboard.mock.calls.length;
    expect(callsBeforeSwitch).toBeGreaterThan(0);

    // The dashboard remains mounted in the tab navigator, but Groups is now the active route.
    mockIsFocused = false;
    mockPathname = '/groups';
    mockCurrentJapamState = { currentJapamId: WORKSPACE_B };
    await updateTree(tree);

    expect(mockGetGroupDashboard).toHaveBeenCalledTimes(callsBeforeSwitch);
    expect(allText(tree).join(' ')).not.toContain('Person B');
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

describe('Groups dashboard auth hydration', () => {
  it('skips the RPC while auth is unresolved and retries after a fresh session hydrates', async () => {
    const pendingSession = createDeferred<any>();
    mockGetSession.mockReturnValueOnce(pendingSession.promise);

    await renderScreen();
    expect(mockGetGroupDashboard).not.toHaveBeenCalled();

    pendingSession.resolve({
      data: { session: { access_token: 'fresh-login-token', user: { id: UID } } },
    });
    await flush();

    expect(mockGetGroupDashboard).toHaveBeenCalledWith(
      'group-1',
      UID,
      expect.any(String),
      expect.any(String),
      WORKSPACE_A
    );
  });

  it('does not call the RPC without a session and clears the dashboard identity', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });

    const tree = await renderScreen();

    expect(mockGetGroupDashboard).not.toHaveBeenCalled();
    expect(allText(tree).join(' ')).toContain('Sign in required');
  });

  it('never paints the old account after logout and login switch while its request is pending', async () => {
    const staleOldUser = createDeferred<any[]>();
    const oldUser = UID;
    const newUser = 'user-b';
    mockGetGroupDashboard
      .mockImplementationOnce(() => staleOldUser.promise)
      .mockResolvedValue([row(`${newUser}-b`, 'New User')]);

    const tree = await renderScreen();
    expect(mockGetGroupDashboard).toHaveBeenCalledWith(
      'group-1',
      oldUser,
      expect.any(String),
      expect.any(String),
      WORKSPACE_A
    );
    expect(mockAuthCallback).not.toBeNull();

    await act(async () => {
      mockAuthCallback?.('SIGNED_OUT', null);
      await Promise.resolve();
    });
    await AsyncStorage.setItem('userId', newUser);
    mockCurrentJapamState = { currentJapamId: WORKSPACE_B };
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'new-user-token', user: { id: newUser } } },
    });
    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', {
        access_token: 'new-user-token',
        user: { id: newUser },
      });
      await Promise.resolve();
    });
    await flush();
    await updateTree(tree);

    staleOldUser.resolve([row(`${oldUser}-old`, 'Old User')]);
    await flush();

    expect(allText(tree).join(' ')).not.toContain('Old User');
  });

});

describe('Groups dashboard render containment', () => {
  it('shows a recoverable fallback when dashboard rendering throws', async () => {
    mockGetGroupDashboard.mockResolvedValueOnce([
      { ...row(UID, 'Member'), userName: {} },
    ]);

    const tree = await renderScreen();

    expect(allText(tree).join(' ')).toContain('This group could not be displayed.');
    expect(allText(tree).join(' ')).toContain('Back to Groups');
  });
});

describe('Groups dashboard cache-first and offline UX', () => {
  it('renders the scoped cached dashboard before unresolved auth or network', async () => {
    const pendingSession = createDeferred<any>();
    mockGetSession.mockReturnValueOnce(pendingSession.promise);
    mockGetCachedGroupDashboard.mockResolvedValue([row(UID, 'Cached Person')]);
    mockGetGroupDashboard.mockImplementation(() => new Promise(() => {}));

    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain('Cached Person');
    expect(tree.root.findAll((node: any) => node.type === 'ActivityIndicator')).toHaveLength(0);
    expect(mockGetCachedGroupDashboard).toHaveBeenCalledWith('group-1', UID, WORKSPACE_A);
    expect(mockGetGroupDashboard).not.toHaveBeenCalled();
  });

  it('keeps cached dashboard data visible while offline', async () => {
    mockPlatformOS = 'web';
    setBrowserOnline(false);
    mockGetCachedGroupDashboard.mockResolvedValue([row(UID, 'Offline Person')]);
    mockGetGroupDashboard.mockRejectedValue(new TypeError('Network request failed'));

    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain('Offline Person');
    expect(texts).toContain("You're offline. Changes will sync when you're back online.");
    expect(texts).not.toContain('Network request failed');
    expect(tree.root.findAll((node: any) => node.type === 'ActivityIndicator')).toHaveLength(0);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('clears the offline message and reconciles when the browser comes online', async () => {
    mockPlatformOS = 'web';
    setBrowserOnline(false);
    mockGetCachedGroupDashboard.mockResolvedValue([row(UID, 'Offline Person')]);
    mockGetGroupDashboard.mockResolvedValue([row(UID, 'Reconciled Person')]);

    const tree = await renderScreen();
    expect(allText(tree).join(' ')).toContain("You're offline. Changes will sync when you're back online.");

    await act(async () => {
      dispatchBrowserEvent('online');
      await Promise.resolve();
    });
    await flush();

    const texts = allText(tree).join(' ');
    expect(texts).toContain('Reconciled Person');
    expect(texts).not.toContain("You're offline. Changes will sync when you're back online.");
    expect(mockGetGroupDashboard).toHaveBeenCalled();
  });

  it('shows the explicit no-cache offline message', async () => {
    mockPlatformOS = 'web';
    setBrowserOnline(false);
    mockGetGroupDashboard.mockRejectedValue(new TypeError('Network request failed'));

    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain("You're offline. No saved group data is available yet.");
    expect(texts).not.toContain('Network request failed');
    expect(tree.root.findAll((node: any) => node.type === 'ActivityIndicator')).toHaveLength(0);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('does not render raw network errors from a failed reconciliation', async () => {
    mockGetGroupDashboard.mockRejectedValueOnce(new TypeError('Network request failed'));

    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain("You're offline. No saved group data is available yet.");
    expect(texts).not.toContain('Network request failed');
  });
});

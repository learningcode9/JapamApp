/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

/**
 * Component tests for app/(tabs)/groups.tsx's workspace isolation (Issue 3).
 *
 * Covers the client-side half of the isolation contract that the unit tests in
 * lib/__tests__/groupsRepository.test.ts and the DB test in
 * db/__tests__/groups_workspace_isolation.local.sql cannot: what the SCREEN renders per
 * workspace — the workspace-scoped list (Group A never shown under Workspace B), the stale
 * response guard (a slow Workspace-A response can never overwrite Workspace-B state), the
 * disabled Create/Join + guidance when no Japam is selected, the separate Unassigned section
 * with its attach flow, and that create/join send the current japamId to the repository.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const mockBack = jest.fn();
const mockPush = jest.fn();

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
    useRouter: () => ({ back: mockBack, push: mockPush, replace: mockPush }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = callback();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, [callback]);
    },
  };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => React.createElement(View, props, children),
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

const mockGetMyGroups = jest.fn();
const mockGetMyUnassignedGroups = jest.fn();
const mockGetCachedMyGroups = jest.fn();
const mockGetCachedMyUnassignedGroups = jest.fn();
const mockIsNetworkFailure = jest.fn();
const mockCreateGroup = jest.fn();
const mockJoinGroupByInviteCode = jest.fn();
const mockAttachGroupMembershipToJapam = jest.fn();

jest.mock('../../lib/groupsRepository', () => ({
  getMyGroups: (...args: unknown[]) => mockGetMyGroups(...args),
  getMyUnassignedGroups: (...args: unknown[]) => mockGetMyUnassignedGroups(...args),
  getCachedMyGroups: (...args: unknown[]) => mockGetCachedMyGroups(...args),
  getCachedMyUnassignedGroups: (...args: unknown[]) => mockGetCachedMyUnassignedGroups(...args),
  isNetworkFailure: (...args: unknown[]) => mockIsNetworkFailure(...args),
  createGroup: (...args: unknown[]) => mockCreateGroup(...args),
  joinGroupByInviteCode: (...args: unknown[]) => mockJoinGroupByInviteCode(...args),
  attachGroupMembershipToJapam: (...args: unknown[]) => mockAttachGroupMembershipToJapam(...args),
}));

let mockCurrentJapamState: {
  japams: { id: string; name: string; archivedAt: string | null }[];
  currentJapamId: string | null;
  currentJapam: { id: string; name: string } | null;
  isLoading: boolean;
};

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => mockCurrentJapamState,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import GroupsScreen from '../(tabs)/groups';

const UID = 'user-a';
const WORKSPACE_A = '550e8400-e29b-41d4-a716-446655440001';
const WORKSPACE_B = '550e8400-e29b-41d4-a716-446655440002';
const GROUP_A = '660e8400-e29b-41d4-a716-44665544000a';
const GROUP_B = '660e8400-e29b-41d4-a716-44665544000b';
const GROUP_UNASSIGNED = '660e8400-e29b-41d4-a716-44665544000c';

const groupRow = (groupId: string, name: string, role: 'admin' | 'member' = 'member') => ({
  groupId,
  name,
  role,
  isActive: true,
  joinedAt: '2026-01-01T00:00:00Z',
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
    tree = renderer.create(React.createElement(GroupsScreen));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const updateTree = async (tree: any) => {
  await act(async () => {
    tree.update(React.createElement(GroupsScreen));
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

const findPressableByChildText = (tree: any, text: string): any =>
  tree.root.findAll((node: any) => {
    if (node.type !== 'Pressable') return false;
    return extractText(node).trim() === text;
  })[0];

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
  await AsyncStorage.clear();
  await AsyncStorage.setItem('userId', UID);
  await AsyncStorage.setItem('userName', 'Test User');
  mockCurrentJapamState = {
    japams: [
      { id: WORKSPACE_A, name: 'Gayatri', archivedAt: null },
      { id: WORKSPACE_B, name: 'Shiva', archivedAt: null },
    ],
    currentJapamId: WORKSPACE_A,
    currentJapam: { id: WORKSPACE_A, name: 'Gayatri' },
    isLoading: false,
  };
  mockGetMyGroups.mockResolvedValue([groupRow(GROUP_A, 'Group A', 'admin')]);
  mockGetMyUnassignedGroups.mockResolvedValue([]);
  mockGetCachedMyGroups.mockResolvedValue(null);
  mockGetCachedMyUnassignedGroups.mockResolvedValue(null);
  mockIsNetworkFailure.mockReturnValue(false);
  mockCreateGroup.mockResolvedValue({ groupId: GROUP_A, groupName: 'New Group', inviteCode: 'ABCDEFG' });
  mockJoinGroupByInviteCode.mockResolvedValue({ kind: 'joined', groupId: GROUP_B, groupName: 'Group B' });
  mockAttachGroupMembershipToJapam.mockResolvedValue({ kind: 'success' });
});

describe('Groups workspace list', () => {
  it('loads groups for the selected Japam workspace only, scoping both list RPCs', async () => {
    mockGetMyGroups.mockResolvedValue([groupRow(GROUP_A, 'Group A')]);
    mockGetMyUnassignedGroups.mockResolvedValue([groupRow(GROUP_UNASSIGNED, 'Legacy Group')]);
    await renderScreen();

    expect(mockGetMyGroups).toHaveBeenCalledWith(UID, WORKSPACE_A);
    expect(mockGetMyUnassignedGroups).toHaveBeenCalled();
  });

  it('renders the selected workspace banner and its groups, but never another workspace group', async () => {
    mockGetMyGroups.mockResolvedValue([groupRow(GROUP_A, 'Group A')]);
    mockGetMyUnassignedGroups.mockResolvedValue([groupRow(GROUP_UNASSIGNED, 'Legacy Group')]);
    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain('Showing groups for: Gayatri');
    expect(texts).toContain('Group A');
    expect(texts).not.toContain('Group B');
  });

  it('renders the unassigned section separately, never mixed into the workspace list', async () => {
    mockGetMyGroups.mockResolvedValue([groupRow(GROUP_A, 'Group A')]);
    mockGetMyUnassignedGroups.mockResolvedValue([groupRow(GROUP_UNASSIGNED, 'Legacy Group')]);
    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain('Unassigned Groups');
    expect(texts).toContain('Legacy Group');
  });

  it('shows guidance and skips the RPCs when no Japam is selected', async () => {
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      currentJapamId: null,
      currentJapam: null,
      isLoading: false,
    };
    const tree = await renderScreen();
    const texts = allText(tree).join(' ');
    expect(texts).toContain('Select a Japam to manage your groups');
    expect(mockGetMyGroups).not.toHaveBeenCalled();
    expect(mockGetMyUnassignedGroups).not.toHaveBeenCalled();
  });

  it('does not refetch when the selected Japam stays unchanged', async () => {
    const tree = await renderScreen();

    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);
    expect(mockGetMyUnassignedGroups).toHaveBeenCalledTimes(1);

    await updateTree(tree);

    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);
    expect(mockGetMyUnassignedGroups).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a simultaneous same-key reload while the first request is in flight', async () => {
    const pending = createDeferred<typeof mockGetMyGroups extends (...a: any[]) => Promise<infer R> ? R : never>();
    mockGetMyGroups.mockImplementationOnce(() => pending.promise);

    const tree = await renderScreen();
    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);

    await updateTree(tree);
    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);

    pending.resolve([groupRow(GROUP_A, 'Group A')]);
    await flush();
    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);
  });

  it('performs one intentional refresh when the screen is remounted after blur', async () => {
    const tree = await renderScreen();
    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
      await Promise.resolve();
    });
    const nextTree = await renderScreen();
    expect(mockGetMyGroups).toHaveBeenCalledTimes(2);
    expect(allText(nextTree).join(' ')).toContain('Groups');
  });

  it('opens from an empty cache while the initial RPC refresh remains pending', async () => {
    const pending = createDeferred<ReturnType<typeof groupRow>[]>();
    mockGetMyGroups.mockReturnValueOnce(pending.promise);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: true,
    };

    const tree = await renderScreen();
    const texts = allText(tree).join(' ');

    expect(texts).toContain('Groups');
    expect(texts).toContain('Showing groups for: Gayatri');
    expect(texts).toContain('Create Group');
    expect(texts).toContain('Join Group');
    expect(texts).toContain("You're not in any groups for this Japam yet. Create one or join with an invite code.");
    expect(tree.root.findAll((node: any) => node.type === 'ActivityIndicator')).toHaveLength(0);
    expect(mockGetMyGroups).toHaveBeenCalledWith(UID, WORKSPACE_A);

    pending.resolve([groupRow(GROUP_A, 'Group A')]);
    await flush();
  });

  it('keeps loaded rows, banner, and actions mounted during a background provider refresh', async () => {
    mockGetMyGroups.mockResolvedValue([groupRow(GROUP_A, 'Group A')]);
    const tree = await renderScreen();
    expect(allText(tree).join(' ')).toContain('Group A');

    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: true,
    };
    await updateTree(tree);

    const texts = allText(tree).join(' ');
    expect(texts).toContain('Group A');
    expect(texts).toContain('Showing groups for: Gayatri');
    expect(texts).toContain('Create Group');
    expect(texts).toContain('Join Group');
    expect(tree.root.findAll((node: any) => node.type === 'ActivityIndicator')).toHaveLength(0);
    expect(mockGetMyGroups).toHaveBeenCalledTimes(1);
  });
});

describe('workspace switch reload + stale-response guard', () => {
  it('ignores a slow prior-workspace response after switching, keeping the new workspace list', async () => {
    const staleA = createDeferred<typeof mockGetMyGroups extends (...a: any[]) => Promise<infer R> ? R : never>();
    // First load (Workspace A) stays pending.
    mockGetMyGroups.mockImplementationOnce(() => staleA.promise);
    const tree = await renderScreen();

    // Switch to Workspace B — loadGroups re-runs and resolves immediately with B's groups.
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      currentJapamId: WORKSPACE_B,
      currentJapam: { id: WORKSPACE_B, name: 'Shiva' },
    };
    mockGetMyGroups.mockResolvedValueOnce([groupRow(GROUP_B, 'Group B')]);
    await updateTree(tree);
    let texts = allText(tree).join(' ');
    expect(texts).toContain('Group B');

    // Now the stale Workspace-A response finally lands — it must NOT overwrite the B list.
    staleA.resolve([groupRow(GROUP_A, 'Group A')]);
    await flush();
    texts = allText(tree).join(' ');
    expect(texts).toContain('Group B');
    expect(texts).not.toContain('Group A');
  });

  it('does not repopulate the list from a stale response after the Japam is deselected', async () => {
    const staleA = createDeferred<typeof mockGetMyGroups extends (...a: any[]) => Promise<infer R> ? R : never>();
    mockGetMyGroups.mockImplementationOnce(() => staleA.promise);
    const tree = await renderScreen();

    // Deselect the Japam (no workspace selected) while the load is still in flight.
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      currentJapamId: null,
      currentJapam: null,
      isLoading: false,
    };
    await updateTree(tree);
    expect(allText(tree).join(' ')).toContain('Select a Japam to manage your groups');

    // The slow Workspace-A response lands after the deselect — it must not repopulate groups.
    staleA.resolve([groupRow(GROUP_A, 'Group A')]);
    await flush();
    const texts = allText(tree).join(' ');
    expect(texts).not.toContain('Group A');
  });
});

describe('create/join flows are workspace-bound', () => {
  it('create sends the current japamId', async () => {
    const tree = await renderScreen();
    await act(async () => {
      findPressableByChildText(tree, 'Create Group').props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findAll((n: any) => n.type === 'TextInput')[0];
    await act(async () => {
      input.props.onChangeText('Family Group');
      await Promise.resolve();
    });
    await act(async () => {
      findPressableByChildText(tree, 'Create').props.onPress();
      await Promise.resolve();
    });
    await flush();

    expect(mockCreateGroup).toHaveBeenCalledWith('Family Group', UID, 'Test User', WORKSPACE_A);
  });

  it('join sends the current japamId', async () => {
    const tree = await renderScreen();
    await act(async () => {
      findPressableByChildText(tree, 'Join Group').props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findAll((n: any) => n.type === 'TextInput')[0];
    await act(async () => {
      input.props.onChangeText('abcdef');
      await Promise.resolve();
    });
    await act(async () => {
      findPressableByChildText(tree, 'Join').props.onPress();
      await Promise.resolve();
    });
    await flush();

    expect(mockJoinGroupByInviteCode).toHaveBeenCalledWith('ABCDEF', UID, 'Test User', WORKSPACE_A);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/groups-dashboard',
      params: { groupId: GROUP_B, groupName: 'Group B' },
    });
  });
});

describe('unassigned attach flow', () => {
  it('attaches the caller-only membership to the current Japam and reloads', async () => {
    mockGetMyUnassignedGroups.mockResolvedValue([groupRow(GROUP_UNASSIGNED, 'Legacy Group')]);
    const tree = await renderScreen();
    expect(allText(tree).join(' ')).toContain('Legacy Group');

    await act(async () => {
      findPressableByChildText(tree, 'Attach').props.onPress();
      await Promise.resolve();
    });
    await flush();

    expect(mockAttachGroupMembershipToJapam).toHaveBeenCalledWith(GROUP_UNASSIGNED, WORKSPACE_A);
    // The reload re-fetches both lists after a successful attach.
    expect(mockGetMyGroups).toHaveBeenCalledTimes(2);
    expect(mockGetMyUnassignedGroups).toHaveBeenCalledTimes(2);
  });
});

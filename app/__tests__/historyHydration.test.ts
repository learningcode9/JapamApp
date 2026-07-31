/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name, react-hooks/exhaustive-deps */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockListeners = new Map<string, Set<(...args: unknown[]) => void>>();
let mockCurrentJapamState: {
  currentJapam: { id: string; name: string } | null;
  currentJapamId: string | null;
  japams: { id: string; name: string; archivedAt: string | null }[];
  isLoading: boolean;
};
let mockSessionToken: string | null = null;
let mockRemoteRows: Record<string, unknown>[] = [];
let mockRemoteFetch = jest.fn(async () => ({ data: mockRemoteRows, error: null }));

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
    RefreshControl: makeHost('RefreshControl'),
    KeyboardAvoidingView: makeHost('KeyboardAvoidingView'),
    TextInput: makeHost('TextInput'),
    Pressable: makeHost('Pressable', (props: any) => ({
      ...props,
      style: typeof props.style === 'function' ? props.style({ pressed: false }) : props.style,
    })),
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement(React.Fragment, null, children) : null,
    Alert: { alert: jest.fn() },
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
    Dimensions: {
      get: jest.fn(() => ({ width: 390, height: 844 })),
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
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = callback();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
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

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///',
  writeAsStringAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

jest.mock('../../components/CurrentJapamHeaderButton', () => {
  const React = require('react');
  const { View } = require('react-native');
  return () => React.createElement(View, null);
});

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => mockCurrentJapamState,
}));

jest.mock('../../lib/japams', () => ({
  activeJapams: (japams: { archivedAt: string | null }[]) => japams.filter((j) => !j.archivedAt),
}));

jest.mock('../../lib/japamsRepository', () => ({
  ensureJapamSyncedForHistory: jest.fn(async () => true),
}));

jest.mock('../../lib/anonymousAuth', () => ({
  repairLegacyStoredUserId: jest.fn(async () => undefined),
  LEGACY_USER_ID_KEY: 'legacyUserId',
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: mockSessionToken
            ? { access_token: mockSessionToken }
            : null,
        },
      })),
    },
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          order: jest.fn(() => ({
            limit: jest.fn(() => mockRemoteFetch()),
          })),
        })),
      })),
    })),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { DeviceEventEmitter } from 'react-native';
import HistoryScreen from '../(tabs)/history';
import { repairLegacyStoredUserId } from '../../lib/anonymousAuth';
import { loadLifetimeStats } from '../../lib/historyRepository';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const HISTORY_KEY = 'history';
const UID = 'user-a';
const JAPAM_ID = 'japam-1';
const JAPAM_NAME = 'PR55-RERUN-1785366136325';
const OTHER_JAPAM_ID = 'japam-2';
const OTHER_JAPAM_NAME = 'Other Japam';

const mockRepairLegacyStoredUserId = repairLegacyStoredUserId as jest.MockedFunction<typeof repairLegacyStoredUserId>;

const buildCurrentJapamState = (overrides?: Partial<typeof mockCurrentJapamState>) => ({
  currentJapam: { id: JAPAM_ID, name: JAPAM_NAME },
  currentJapamId: JAPAM_ID,
  japams: [
    { id: JAPAM_ID, name: JAPAM_NAME, archivedAt: null },
    { id: OTHER_JAPAM_ID, name: OTHER_JAPAM_NAME, archivedAt: null },
  ],
  isLoading: false,
  ...overrides,
});

const buildRemoteRows = () => [
  {
    id: 1,
    created_at: '2026-07-29T10:00:00.000Z',
    malas: 1,
    count: 108,
    user_name: 'Test User',
    completion_id: 'completion-1',
    japam_id: JAPAM_ID,
    japam_name: JAPAM_NAME,
  },
  {
    id: 2,
    created_at: '2026-07-29T11:00:00.000Z',
    malas: 1,
    count: 108,
    user_name: 'Test User',
    completion_id: 'completion-2',
    japam_id: JAPAM_ID,
    japam_name: JAPAM_NAME,
  },
  {
    id: 3,
    created_at: '2026-07-29T12:00:00.000Z',
    malas: 1,
    count: 108,
    user_name: 'Test User',
    completion_id: 'completion-other',
    japam_id: OTHER_JAPAM_ID,
    japam_name: OTHER_JAPAM_NAME,
  },
];

const extractText = (value: any): string => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractText).join('');
  return extractText(value.props?.children);
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

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
    tree = renderer.create(React.createElement(HistoryScreen));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const allText = (tree: any) =>
  tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => extractText(node));

const expectSummary = (tree: any, malas: number, totalCount: number) => {
  const texts = allText(tree);
  expect(texts).toContain(`📿 Total Malas: ${malas}`);
  expect(texts).toContain(`🔢 Total Count: ${totalCount}`);
};

const expectLoadingState = (tree: any) => {
  const texts = allText(tree);
  expect(texts).toContain('Loading history...');
  expect(texts.some((text: string) => text.startsWith('📿 Total Malas:'))).toBe(false);
  expect(texts).not.toContain('No Japam history yet');
};

const expectStableRowsVisible = (tree: any, malas: number, totalCount: number) => {
  expectSummary(tree, malas, totalCount);
  const texts = allText(tree);
  expect(texts).not.toContain('Loading history...');
  expect(texts).not.toContain('No Japam history yet');
};

const getVisibleHistoryState = (tree: any) => {
  const texts = allText(tree);
  if (texts.includes('Loading history...')) return 'loading';
  if (texts.includes('No Japam history yet')) return 'empty';
  if (texts.some((text: string) => text.startsWith('📿 Total Malas:'))) return 'rows';
  return 'unknown';
};

const getRefreshControl = (tree: any) => {
  const scrollView = tree.root.find((node: any) => node.type === 'ScrollView');
  return scrollView.props.refreshControl;
};

const updateTree = async (tree: any) => {
  await act(async () => {
    tree.update(React.createElement(HistoryScreen));
    await Promise.resolve();
  });
  await flush();
};

const seedHistory = async () => {
  const records = [
    {
      date: '2026-07-29T10:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 0,
      manual: false,
      userId: UID,
      userName: 'Test User',
      completionId: 'completion-1',
      syncStatus: 'synced',
      japamId: JAPAM_ID,
      japamName: JAPAM_NAME,
    },
    {
      date: '2026-07-29T10:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 0,
      manual: false,
      userId: UID,
      userName: 'Test User',
      completionId: 'completion-1',
      syncStatus: 'synced',
      japamId: JAPAM_ID,
      japamName: JAPAM_NAME,
    },
    {
      date: '2026-07-29T11:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 0,
      manual: false,
      userId: UID,
      userName: 'Test User',
      completionId: 'completion-2',
      syncStatus: 'synced',
      japamId: JAPAM_ID,
      japamName: JAPAM_NAME,
    },
    {
      date: '2026-07-29T12:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 0,
      manual: false,
      userId: UID,
      userName: 'Test User',
      completionId: 'completion-other',
      syncStatus: 'synced',
      japamId: OTHER_JAPAM_ID,
      japamName: OTHER_JAPAM_NAME,
    },
  ];
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(records));
};

beforeEach(async () => {
  mockListeners.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockSessionToken = null;
  mockRemoteRows = [];
  mockRemoteFetch = jest.fn(async () => ({ data: mockRemoteRows, error: null }));
  mockRepairLegacyStoredUserId.mockImplementation(async () => null);
  mockCurrentJapamState = buildCurrentJapamState();
  await AsyncStorage.clear();
  await seedHistory();
  await AsyncStorage.setItem(USER_ID_KEY, UID);
  await AsyncStorage.setItem(USER_NAME_KEY, 'Test User');
  await AsyncStorage.setItem(USER_EMAIL_KEY, 'test@example.com');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('HistoryScreen auth/current-Japam hydration regression', () => {
  it('hydrates after auth and current-Japam restore, clears on logout, survives refresh, preserves dedupe, and matches selector totals', async () => {
    mockCurrentJapamState = buildCurrentJapamState({
      currentJapam: null,
      currentJapamId: null,
      isLoading: true,
    });
    await AsyncStorage.removeItem(USER_ID_KEY);

    const tree = await renderScreen();
    expectLoadingState(tree);

    await AsyncStorage.setItem(USER_ID_KEY, UID);
    await act(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
      await Promise.resolve();
    });
    await flush();
    expectLoadingState(tree);

    mockCurrentJapamState = buildCurrentJapamState();
    await updateTree(tree);
    expectSummary(tree, 2, 216);

    mockSessionToken = 'session-token';
    mockRemoteRows = buildRemoteRows();
    await act(async () => {
      await getRefreshControl(tree).props.onRefresh();
    });
    await flush();
    expectSummary(tree, 2, 216);

    const selectorTotals = await loadLifetimeStats(UID, JAPAM_ID);
    expect(selectorTotals).toEqual({ malas: 2, totalCount: 216 });

    await AsyncStorage.removeItem(USER_ID_KEY);
    await act(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
      await Promise.resolve();
    });
    await flush();
    expectLoadingState(tree);

    const persistedAfterLogout = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]') as { completionId?: string }[];
    expect(persistedAfterLogout.filter((row) => row.completionId === 'completion-1')).toHaveLength(1);
    expect(persistedAfterLogout.filter((row) => row.completionId === 'completion-2')).toHaveLength(1);

    mockCurrentJapamState = buildCurrentJapamState({
      currentJapam: null,
      currentJapamId: null,
      isLoading: false,
    });
    await updateTree(tree);
    expect(allText(tree)).toContain('No Japam selected. Create or select a Japam to see its history.');

    await AsyncStorage.setItem(USER_ID_KEY, UID);
    mockCurrentJapamState = buildCurrentJapamState({
      currentJapam: null,
      currentJapamId: null,
      isLoading: true,
    });
    await act(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
      await Promise.resolve();
    });
    await flush();
    expectLoadingState(tree);

    mockCurrentJapamState = buildCurrentJapamState();
    await updateTree(tree);
    expectSummary(tree, 2, 216);

    mockRemoteRows = [];
    await act(async () => {
      await getRefreshControl(tree).props.onRefresh();
    });
    await flush();
    expectSummary(tree, 2, 216);

    const persisted = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]') as { completionId?: string }[];
    expect(persisted.filter((row) => row.completionId === 'completion-1')).toHaveLength(1);
    expect(persisted.filter((row) => row.completionId === 'completion-2')).toHaveLength(1);
  });

  it('ignores a slow pre-login request after relogin restores the user and current Japam', async () => {
    const staleGuestLoad = createDeferred<string | null>();
    mockRepairLegacyStoredUserId.mockImplementation(() => staleGuestLoad.promise);

    await AsyncStorage.removeItem(USER_ID_KEY);
    const tree = await renderScreen();
    mockRepairLegacyStoredUserId.mockImplementation(async () => null);

    await AsyncStorage.setItem(USER_ID_KEY, UID);
    mockCurrentJapamState = buildCurrentJapamState({
      currentJapam: null,
      currentJapamId: null,
      isLoading: true,
    });
    await act(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
      await Promise.resolve();
    });
    await flush();
    expectStableRowsVisible(tree, 2, 216);

    mockCurrentJapamState = buildCurrentJapamState();
    await updateTree(tree);
    expectSummary(tree, 2, 216);

    await act(async () => {
      staleGuestLoad.resolve(null);
      await Promise.resolve();
    });
    await flush();
    expectSummary(tree, 2, 216);
  });

  it('keeps current rows visible during repeated same-scope auth and history reload events', async () => {
    mockSessionToken = 'session-token';
    const remoteFetchDeferred = createDeferred<{ data: Record<string, unknown>[]; error: null }>();
    mockRemoteFetch = jest.fn(() => remoteFetchDeferred.promise);

    const tree = await renderScreen();
    expectStableRowsVisible(tree, 2, 216);

    await act(async () => {
      DeviceEventEmitter.emit('japam-history-updated');
      DeviceEventEmitter.emit('japam-auth-updated');
      await Promise.resolve();
    });
    await flush();

    expectStableRowsVisible(tree, 2, 216);

    await act(async () => {
      remoteFetchDeferred.resolve({ data: buildRemoteRows(), error: null });
      await Promise.resolve();
    });
    await flush();

    expectStableRowsVisible(tree, 2, 216);
  });

  it('goes from loading to rows without rendering the empty history state in between', async () => {
    mockSessionToken = 'session-token';
    const remoteFetchDeferred = createDeferred<{ data: Record<string, unknown>[]; error: null }>();
    mockRemoteFetch = jest.fn(() => remoteFetchDeferred.promise);
    mockCurrentJapamState = buildCurrentJapamState({
      currentJapam: null,
      currentJapamId: null,
      isLoading: true,
    });

    const tree = await renderScreen();
    const states = [getVisibleHistoryState(tree)];
    expect(states).toEqual(['loading']);

    mockCurrentJapamState = buildCurrentJapamState();
    await updateTree(tree);

    states.push(getVisibleHistoryState(tree));
    expectStableRowsVisible(tree, 2, 216);

    await act(async () => {
      remoteFetchDeferred.resolve({ data: buildRemoteRows(), error: null });
      await Promise.resolve();
    });
    await flush();

    states.push(getVisibleHistoryState(tree));
    expect(states).toEqual(['loading', 'rows', 'rows']);
  });

  it('prevents rapid Japam switching from leaking rows from the old Japam', async () => {
    const tree = await renderScreen();
    expectSummary(tree, 2, 216);

    mockCurrentJapamState = buildCurrentJapamState({
      currentJapam: { id: OTHER_JAPAM_ID, name: OTHER_JAPAM_NAME },
      currentJapamId: OTHER_JAPAM_ID,
    });
    await updateTree(tree);
    expectSummary(tree, 1, 108);
    expectSummary(tree, 1, 108);
    expect(allText(tree)).not.toContain('📿 Total Malas: 2');
  });
});

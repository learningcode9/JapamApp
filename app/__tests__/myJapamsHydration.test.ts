/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const mockBack = jest.fn();
const mockHydrateHistoryForUser = jest.fn();

let mockCurrentJapamState: {
  japams: { id: string; name: string; archivedAt: string | null }[];
  currentJapamId: string | null;
  isLoading: boolean;
  selectJapam: jest.Mock;
  createJapam: jest.Mock;
  renameJapam: jest.Mock;
  archiveJapam: jest.Mock;
  restoreJapam: jest.Mock;
  deleteJapam: jest.Mock;
};

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
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement(React.Fragment, null, children) : null,
    Alert: { alert: jest.fn() },
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
        for (const callback of mockListeners.get(eventName) ?? []) callback(...args);
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
    useRouter: () => ({ back: mockBack }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      const hasRunRef = React.useRef(false);
      React.useEffect(() => {
        if (hasRunRef.current) return undefined;
        hasRunRef.current = true;
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

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => mockCurrentJapamState,
}));

jest.mock('../../lib/japams', () => ({
  activeJapams: (japams: { archivedAt: string | null }[]) => japams.filter((j) => !j.archivedAt),
  archivedJapams: (japams: { archivedAt: string | null }[]) => japams.filter((j) => j.archivedAt),
}));

jest.mock('../../lib/historyRepository', () => {
  const actual = jest.requireActual('../../lib/historyRepository');
  return {
    ...actual,
    hydrateHistoryForUserDetails: (...args: unknown[]) => mockHydrateHistoryForUser(...args),
  };
});

jest.mock('../../lib/anonymousAuth', () => ({
  LEGACY_USER_ID_KEY: 'legacyUserId',
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { DeviceEventEmitter } from 'react-native';
const renderer = require('react-test-renderer');
const { act } = renderer;
import MyJapamsScreen from '../my-japams';
import { toLocalDayKey } from '../../lib/historyStore';

const UID = 'user-a';
const JAPAM_ID = 'japam-1';

const makeRecord = (overrides: Partial<Record<string, unknown>> = {}) => ({
  date: '2026-07-20T09:00:00.000Z',
  malas: 2,
  totalCount: 216,
  duration: 0,
  manual: false,
  userId: UID,
  completionId: 'remote-1',
  syncStatus: 'synced' as const,
  japamId: JAPAM_ID,
  japamName: 'Morning Japam',
  ...overrides,
});

const makeHydrationResult = (records: ReturnType<typeof makeRecord>[] = [makeRecord()], hydrationSucceeded = true) => ({
  records,
  hydrationSucceeded,
  localRecordCount: records.length,
  hadLocalTombstones: false,
});

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
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  });
};

const renderScreen = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(MyJapamsScreen));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const updateTree = async (tree: any) => {
  await act(async () => {
    tree.update(React.createElement(MyJapamsScreen));
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

const allText = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => extractText(node));

const countByTestId = (tree: any, testID: string) =>
  tree.root.findAll((node: any) => node.type === 'View' && node.props?.testID === testID).length;

const getStatBoxTexts = (tree: any) =>
  tree.root
    .findAll((node: any) => node.type === 'View' && node.props?.testID === 'japam-stat-box')
    .map((node: any) => extractText(node));

const findPressableByAccessibilityLabel = (tree: any, label: string): any =>
  tree.root.findAll((node: any) => node.type === 'Pressable' && node.props?.accessibilityLabel === label)[0];

const getScreenState = (tree: any) => {
  const statBoxCount = countByTestId(tree, 'japam-stat-box');
  const skeletonCount = countByTestId(tree, 'japam-stat-skeleton');
  const texts = allText(tree);
  const hasVisibleValues = texts.some((text: string) => /\d+ malas$/.test(text));

  if (statBoxCount > 0 && skeletonCount === statBoxCount) return 'loading';
  if (hasVisibleValues) return 'ready';
  return 'unknown';
};

const expectShowsStats = (tree: any, value: string) => {
  const texts = allText(tree);
  expect(texts).toContain(value);
  expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);
};

beforeEach(async () => {
  mockListeners.clear();
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-07-20T09:00:00.000Z'));
  await AsyncStorage.clear();
  mockCurrentJapamState = {
    japams: [{ id: JAPAM_ID, name: 'Morning Japam', archivedAt: null }],
    currentJapamId: JAPAM_ID,
    isLoading: true,
    selectJapam: jest.fn(),
    createJapam: jest.fn(async () => null),
    renameJapam: jest.fn(async () => undefined),
    archiveJapam: jest.fn(async () => undefined),
    restoreJapam: jest.fn(async () => undefined),
    deleteJapam: jest.fn(async () => undefined),
  };
  mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
    if (userId !== UID) return makeHydrationResult([], true);
    return makeHydrationResult();
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MyJapamsScreen hydration regression', () => {
  it('hydrates lifetime totals after login and Japam restore without rendering loading text or changing card stats structure', async () => {
    const tree = await renderScreen();
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);
    expect(allText(tree)).not.toContain('2 malas');

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    await updateTree(tree);

    expectShowsStats(tree, '2 malas');
    expect(mockHydrateHistoryForUser).toHaveBeenCalledWith(UID, null, { force: false, localFirst: true });
  });

  it('requests local-first history hydration so stats do not wait for the network', async () => {
    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();

    expectShowsStats(tree, '2 malas');
    expect(mockHydrateHistoryForUser).toHaveBeenCalledWith(UID, null, { force: false, localFirst: true });
  });

  it('renders a clean incognito first load with skeletons before auth resolves', async () => {
    const tree = await renderScreen();
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);
    expect(allText(tree)).not.toContain('2 malas');
  });

  it('shows loading at most once per user change and never returns to loading after ready during same-user Japam updates', async () => {
    const secondLoadDeferred = createDeferred<ReturnType<typeof makeHydrationResult>>();
    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID ? makeHydrationResult() : makeHydrationResult([], true)))
      .mockImplementationOnce(async (userId: string | null) => (userId === UID ? secondLoadDeferred.promise : makeHydrationResult([], true)))
      .mockImplementation(async (userId: string | null) => (userId === UID ? makeHydrationResult() : makeHydrationResult([], true)));

    const tree = await renderScreen();
    const states = [getScreenState(tree)];
    expect(states).toEqual(['loading']);

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    await updateTree(tree);
    states.push(getScreenState(tree));

    expect(states).toEqual(['loading', 'ready']);
    expect(allText(tree)).toContain('2 malas');
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);

    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: true,
    };
    await updateTree(tree);
    states.push(getScreenState(tree));

    expect(states).toEqual(['loading', 'ready', 'ready']);
    expect(allText(tree)).toContain('2 malas');
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);

    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
      japams: [
        { id: JAPAM_ID, name: 'Morning Japam', archivedAt: null },
        { id: 'japam-2', name: 'Evening Japam', archivedAt: null },
      ],
    };
    await updateTree(tree);
    states.push(getScreenState(tree));

    expect(states).toEqual(['loading', 'ready', 'ready', 'ready']);
    expect(allText(tree)).toContain('2 malas');
    expect(countByTestId(tree, 'japam-stat-box')).toBe(4);
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);

    await act(async () => {
      secondLoadDeferred.resolve(makeHydrationResult([makeRecord()], true));
      await Promise.resolve();
    });
    await flush();

    states.push(getScreenState(tree));
    expect(states).toEqual(['loading', 'ready', 'ready', 'ready', 'ready']);
    expect(allText(tree)).toContain('2 malas');
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);
  });

  it('keeps current stats visible during same-user background refreshes and updates after the new data lands', async () => {
    const refreshDeferred = createDeferred<ReturnType<typeof makeRecord>[]>();
    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID ? makeHydrationResult() : makeHydrationResult([], true)))
      .mockImplementationOnce(async (userId: string | null) => (userId === UID ? makeHydrationResult(await refreshDeferred.promise) : makeHydrationResult([], true)));

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      DeviceEventEmitter.emit('japam-stats-updated');
      await Promise.resolve();
    });
    await flush();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      refreshDeferred.resolve([
        makeRecord({
          completionId: 'remote-2',
          malas: 3,
          totalCount: 324,
        }),
      ]);
      await Promise.resolve();
    });
    await flush();
    expectShowsStats(tree, '3 malas');
  });

  it('moves the selection indicator immediately when the current Japam changes', async () => {
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      japams: [
        { id: JAPAM_ID, name: 'Morning Japam', archivedAt: null },
        { id: 'japam-2', name: 'Evening Japam', archivedAt: null },
      ],
      currentJapamId: JAPAM_ID,
      isLoading: false,
    };

    const tree = await renderScreen();
    expect(findPressableByAccessibilityLabel(tree, 'Select Morning Japam, currently selected')).toBeDefined();

    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      currentJapamId: 'japam-2',
    };
    await updateTree(tree);

    expect(findPressableByAccessibilityLabel(tree, 'Select Evening Japam, currently selected')).toBeDefined();
    expect(findPressableByAccessibilityLabel(tree, 'Select Morning Japam')).toBeDefined();
  });

  it('keeps showing ready stats instead of zeroing them out when a stale same-user refresh fails', async () => {
    const staleDeferred = createDeferred<void>();
    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID ? makeHydrationResult() : makeHydrationResult([], true)))
      .mockImplementationOnce(async (userId: string | null) => {
        if (userId !== UID) return makeHydrationResult([], true);
        await staleDeferred.promise;
        return makeHydrationResult([makeRecord()], false);
      });

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      DeviceEventEmitter.emit('japam-history-updated');
      await Promise.resolve();
    });
    await flush();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      staleDeferred.resolve();
      await Promise.resolve();
    });
    await flush();
    expectShowsStats(tree, '2 malas');
  });

  it('updates from 2 to 3 when a new local pending completion exists and remote hydration fails', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', malas: 2, totalCount: 216 }),
      makeRecord({ completionId: 'local-2', malas: 1, totalCount: 108, syncStatus: 'pending', date: '2026-07-20T10:30:00.000Z' }),
    ]));

    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID
        ? makeHydrationResult([makeRecord({ completionId: 'local-1' })], true)
        : makeHydrationResult([], true)))
      .mockImplementationOnce(async (userId: string | null) => (userId === UID
        ? { records: [
            makeRecord({ completionId: 'local-1' }),
            makeRecord({ completionId: 'local-2', malas: 1, totalCount: 108, syncStatus: 'pending', date: '2026-07-20T10:30:00.000Z' }),
          ], hydrationSucceeded: false, localRecordCount: 2, hadLocalTombstones: false, scopedLocalTombstoneApplied: false, localStateAuthoritativelyChanged: true }
        : makeHydrationResult([], true)));

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      DeviceEventEmitter.emit('japam-stats-updated');
      await Promise.resolve();
    });
    await flush();

    expectShowsStats(tree, '3 malas');
  });

  it('updates from 2 to 0 when the final local completion is tombstoned and remote hydration fails', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', malas: 2, totalCount: 216 }),
    ]));
    await AsyncStorage.setItem('deletedCompletions', JSON.stringify(['local-1']));

    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID
        ? makeHydrationResult([makeRecord({ completionId: 'local-1' })], true)
        : makeHydrationResult([], true)))
      .mockImplementationOnce(async (userId: string | null) => (userId === UID
        ? { records: [], hydrationSucceeded: false, localRecordCount: 0, hadLocalTombstones: true, scopedLocalTombstoneApplied: true, localStateAuthoritativelyChanged: true }
        : makeHydrationResult([], true)));

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      DeviceEventEmitter.emit('japam-stats-updated');
      await Promise.resolve();
    });
    await flush();

    expectShowsStats(tree, '0 malas');
  });

  it('preserves the previously displayed 2 malas when remote hydration fails without an authoritative local change', async () => {
    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID
        ? makeHydrationResult([makeRecord({ completionId: 'local-1' })], true)
        : makeHydrationResult([], true)))
      .mockImplementationOnce(async (userId: string | null) => (userId === UID
        ? { records: [makeRecord({ completionId: 'local-1' })], hydrationSucceeded: false, localRecordCount: 1, hadLocalTombstones: false, scopedLocalTombstoneApplied: false, localStateAuthoritativelyChanged: false }
        : makeHydrationResult([], true)));

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      DeviceEventEmitter.emit('japam-stats-updated');
      await Promise.resolve();
    });
    await flush();

    expectShowsStats(tree, '2 malas');
  });

  it('protects against stale request results when Japam scope changes mid-load', async () => {
    const firstLoadDeferred = createDeferred<ReturnType<typeof makeRecord>[]>();
    mockHydrateHistoryForUser
      .mockImplementationOnce(async (userId: string | null) => (userId === UID ? makeHydrationResult(await firstLoadDeferred.promise) : makeHydrationResult([], true)))
      .mockImplementation(async (userId: string | null) => (userId === UID ? makeHydrationResult([makeRecord({ completionId: 'remote-2' })]) : makeHydrationResult([], true)));

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    const tree = await renderScreen();
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);

    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      japams: [
        { id: JAPAM_ID, name: 'Morning Japam', archivedAt: null },
        { id: 'japam-2', name: 'Evening Japam', archivedAt: null },
      ],
    };
    await updateTree(tree);
    expectShowsStats(tree, '2 malas');

    await act(async () => {
      firstLoadDeferred.resolve([makeRecord()]);
      await Promise.resolve();
    });
    await flush();
    expectShowsStats(tree, '2 malas');
  });

  it('counts Today using local calendar day boundaries instead of UTC midnight', async () => {
    const previousTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      jest.setSystemTime(new Date('2026-07-30T05:30:00.000Z'));
      mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
        if (userId !== UID) return makeHydrationResult([], true);
        return makeHydrationResult([makeRecord({
          date: '2026-07-30T05:00:00.000Z',
          completionId: 'midnight-boundary',
          malas: 1,
          totalCount: 108,
        })]);
      });

      await AsyncStorage.setItem('userId', UID);
      mockCurrentJapamState = {
        ...mockCurrentJapamState,
        isLoading: false,
      };
      const tree = await renderScreen();

      const statBoxes = getStatBoxTexts(tree);
      const todayBox = statBoxes.find((text: string) => text.includes('Today'));
      const lifetimeBox = statBoxes.find((text: string) => text.includes('Lifetime'));
      expect(todayBox).toContain('1 malas');
      expect(lifetimeBox).toContain('1 malas');
    } finally {
      process.env.TZ = previousTZ;
    }
  });

  it('treats a local late-night completion as the same local day even when the UTC date differs', () => {
    const localLateNight = new Date(2026, 5, 6, 23, 30, 0).toISOString();
    expect(toLocalDayKey(localLateNight)).toBe('2026-06-06');
  });
});

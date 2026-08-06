/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockHydrateHistoryForUser = jest.fn();
const mockEnsureDefaultJapam = jest.fn();

jest.mock('../../lib/japamsRepository', () => ({
  loadJapams: jest.fn(),
  loadCurrentJapamId: jest.fn(),
  saveCurrentJapamId: jest.fn(),
  ensureDefaultJapam: (...args: unknown[]) => mockEnsureDefaultJapam(...args),
  reconcileAllJapams: jest.fn(),
  createJapam: jest.fn(),
  renameJapam: jest.fn(),
  archiveJapam: jest.fn(),
  restoreJapam: jest.fn(),
  deleteJapam: jest.fn(),
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

jest.mock('../../lib/japams', () => ({
  activeJapams: (japams: { archivedAt: string | null }[]) =>
    japams.filter((j) => !j.archivedAt),
  archivedJapams: (japams: { archivedAt: string | null }[]) =>
    japams.filter((j) => j.archivedAt),
  normalizeJapamName: (name: string) => name.trim(),
}));

jest.mock('react-native', () => {
  const React = require('react');
  const makeHost = (name: string, mapProps?: (props: any) => any) =>
    React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement(name, {
        ...(mapProps ? mapProps(props) : props),
        ref,
      }, children)
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
      style: typeof props.style === 'function'
        ? props.style({ pressed: false })
        : props.style,
    })),
    DeviceEventEmitter: {
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      emit: jest.fn(),
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
    useRouter: () => ({ back: jest.fn() }),
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
    LinearGradient: ({ children, ...props }: any) =>
      React.createElement(View, props, children),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: ({ name }: { name: string }) =>
      React.createElement(Text, null, name),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { CurrentJapamProvider } from '../../contexts/current-japam-context';
import MyJapamsScreen from '../my-japams';

const UID = 'user-integration';
const JAPAM_ID = 'japam-1';
const HISTORY_KEY = 'history';

const extractText = (value: any): string => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractText).join('');
  return extractText(value.props?.children);
};

const allText = (tree: any) =>
  tree.root
    .findAll((node: any) => node.type === 'Text')
    .map((node: any) => extractText(node));

const countByTestId = (tree: any, testID: string) =>
  tree.root.findAll(
    (node: any) => node.type === 'View' && node.props?.testID === testID,
  ).length;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  });
};

const renderProviderAndScreen = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(
      React.createElement(
        CurrentJapamProvider,
        null,
        React.createElement(MyJapamsScreen),
      ),
    );
    await Promise.resolve();
  });
  await flush();
  await flush();
  return tree;
};

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

const makeHydrationResult = (
  records: ReturnType<typeof makeRecord>[] = [makeRecord()],
  hydrationSucceeded = true,
) => ({
  records,
  hydrationSucceeded,
  localRecordCount: records.length,
  hadLocalTombstones: false,
  scopedLocalTombstoneApplied: false,
  localStateAuthoritativelyChanged: false,
});

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-07-20T09:00:00.000Z'));
  await AsyncStorage.clear();
  mockEnsureDefaultJapam.mockResolvedValue({
    japams: [
      {
        id: JAPAM_ID,
        userId: UID,
        name: 'Morning Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      },
    ],
    currentJapamId: JAPAM_ID,
    created: null,
  });
  mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
    if (userId !== UID) return makeHydrationResult([], true);
    return makeHydrationResult();
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CurrentJapamProvider + MyJapamsScreen cold-start integration', () => {
  it('provider hydrates History, screen shows correct lifetime total without visiting History', async () => {
    const lifetimeMalas = 63;
    const records = Array.from({ length: lifetimeMalas }, (_, i) =>
      makeRecord({
        completionId: `remote-intg-${i}`,
        malas: 1,
        totalCount: 108,
      }),
    );

    mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
      if (userId !== UID) return makeHydrationResult([], true);
      const result = makeHydrationResult(records, true);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(records));
      return result;
    });

    await AsyncStorage.setItem('userId', UID);
    const tree = await renderProviderAndScreen();

    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);
    expect(allText(tree)).toContain(`${lifetimeMalas} malas`);
    expect(allText(tree)).not.toContain('0 malas');

    const providerCalls = mockHydrateHistoryForUser.mock.calls.filter(
      ([userId, , options]: [string, unknown?, { force?: boolean }?]) =>
        userId === UID && !(options && options.force === true),
    );
    expect(providerCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('while provider hydration is pending, skeleton is displayed and 0 malas is not rendered', async () => {
    let resolveHydration!: (value: ReturnType<typeof makeHydrationResult>) => void;
    const deferredHydration = new Promise<ReturnType<typeof makeHydrationResult>>(
      (resolve) => {
        resolveHydration = resolve;
      },
    );

    const lifetimeMalas = 63;
    const records = Array.from({ length: lifetimeMalas }, (_, i) =>
      makeRecord({
        completionId: `remote-pending-${i}`,
        malas: 1,
        totalCount: 108,
      }),
    );

    mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
      if (userId !== UID) return makeHydrationResult([], true);
      const result = await deferredHydration;
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(result.records));
      return result;
    });

    await AsyncStorage.setItem('userId', UID);

    let tree: any;
    await act(async () => {
      tree = renderer.create(
        React.createElement(
          CurrentJapamProvider,
          null,
          React.createElement(MyJapamsScreen),
        ),
      );
      await Promise.resolve();
    });
    await flush();

    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);
    expect(allText(tree).some((t: string) => /^\d+ malas$/.test(t))).toBe(false);

    await act(async () => {
      resolveHydration(makeHydrationResult(records, true));
      await Promise.resolve();
    });
    await flush();
    await flush();

    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);
    expect(allText(tree)).toContain(`${lifetimeMalas} malas`);
    expect(allText(tree)).not.toContain('0 malas');
  });

  it('provider does not mark ready before History is persisted', async () => {
    let resolveHydration!: (value: ReturnType<typeof makeHydrationResult>) => void;
    const deferredHydration = new Promise<ReturnType<typeof makeHydrationResult>>(
      (resolve) => {
        resolveHydration = resolve;
      },
    );

    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        completionId: `remote-ready-${i}`,
        malas: 1,
        totalCount: 108,
      }),
    );

    mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
      if (userId !== UID) return makeHydrationResult([], true);
      const result = await deferredHydration;
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(result.records));
      return result;
    });

    await AsyncStorage.setItem('userId', UID);

    let tree: any;
    await act(async () => {
      tree = renderer.create(
        React.createElement(
          CurrentJapamProvider,
          null,
          React.createElement(MyJapamsScreen),
        ),
      );
      await Promise.resolve();
    });
    await flush();

    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);

    await act(async () => {
      resolveHydration(makeHydrationResult(records, true));
      await Promise.resolve();
    });
    await flush();
    await flush();

    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);
    expect(allText(tree)).toContain('5 malas');

    const persistedHistory = await AsyncStorage.getItem(HISTORY_KEY);
    expect(persistedHistory).not.toBeNull();
    const parsed = JSON.parse(persistedHistory!);
    expect(parsed).toHaveLength(5);
  });

  it('startup stats event causes the screen to re-read persisted History', async () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      makeRecord({
        completionId: `remote-startup-${i}`,
        malas: 1,
        totalCount: 108,
      }),
    );

    mockHydrateHistoryForUser.mockImplementation(async (userId: string | null) => {
      if (userId !== UID) return makeHydrationResult([], true);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(records));
      return makeHydrationResult(records, true);
    });

    await AsyncStorage.setItem('userId', UID);
    const tree = await renderProviderAndScreen();

    expect(allText(tree)).toContain('12 malas');
    expect(allText(tree)).not.toContain('0 malas');
  });
});

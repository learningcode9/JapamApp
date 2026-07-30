/* eslint-disable import/first, @typescript-eslint/no-require-imports, react/display-name */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const mockBack = jest.fn();
const mockLoadJapamStats = jest.fn();
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
    useRouter: () => ({ back: mockBack }),
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

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => mockCurrentJapamState,
}));

jest.mock('../../lib/japams', () => ({
  activeJapams: (japams: { archivedAt: string | null }[]) => japams.filter((j) => !j.archivedAt),
  archivedJapams: (japams: { archivedAt: string | null }[]) => japams.filter((j) => j.archivedAt),
}));

jest.mock('../../lib/historyRepository', () => ({
  loadJapamStats: (...args: unknown[]) => mockLoadJapamStats(...args),
  japamStatsFor: (statsMap: Map<string | null, any>, japamId: string | null) => (
    statsMap.get(japamId) ?? statsMap.get(null) ?? null
  ),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import MyJapamsScreen from '../my-japams';

const UID = 'user-a';
const JAPAM_ID = 'japam-1';

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

const allText = (tree: any) =>
  tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => extractText(node));

const countByTestId = (tree: any, testID: string) =>
  tree.root.findAll((node: any) => node.type === 'View' && node.props?.testID === testID).length;

beforeEach(async () => {
  mockListeners.clear();
  jest.clearAllMocks();
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
  mockLoadJapamStats.mockImplementation(async (userId: string | null) => {
    if (userId !== UID) return new Map();
    return new Map([
      [JAPAM_ID, {
        todayMalas: 1,
        todayTotalCount: 108,
        lifetimeMalas: 2,
        lifetimeTotalCount: 216,
      }],
    ]);
  });
});

describe('MyJapamsScreen hydration regression', () => {
  it('hydrates lifetime totals after login and Japam restore without rendering loading text or changing card stats structure', async () => {
    const tree = await renderScreen();
    expect(allText(tree)).not.toContain('Loading...');
    expect(allText(tree)).not.toContain('2 malas');
    expect(mockLoadJapamStats).not.toHaveBeenCalled();
    expect(countByTestId(tree, 'japam-stat-box')).toBe(2);
    expect(countByTestId(tree, 'japam-stat-value-shell')).toBe(2);
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(2);

    await AsyncStorage.setItem('userId', UID);
    mockCurrentJapamState = {
      ...mockCurrentJapamState,
      isLoading: false,
    };
    await updateTree(tree);

    const texts = allText(tree);
    expect(texts).toContain('Lifetime');
    expect(texts).toContain('2 malas');
    expect(texts).not.toContain('0 malas');
    expect(texts).not.toContain('Loading...');
    expect(countByTestId(tree, 'japam-stat-box')).toBe(2);
    expect(countByTestId(tree, 'japam-stat-value-shell')).toBe(2);
    expect(countByTestId(tree, 'japam-stat-skeleton')).toBe(0);
    expect(mockLoadJapamStats).toHaveBeenCalledTimes(1);
    expect(mockLoadJapamStats).toHaveBeenCalledWith(UID);
  });
});

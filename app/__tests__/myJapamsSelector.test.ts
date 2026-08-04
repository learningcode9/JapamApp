jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockRouter = { push: jest.fn(), back: jest.fn() };
let mockParams: Record<string, string | undefined> = {};

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = callback();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
      }, [callback]);
    },
  };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const LinearGradient = ({ children, ...props }: any) => React.createElement(View, props, children);
  LinearGradient.displayName = 'LinearGradient';
  return { LinearGradient };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const Ionicons = ({ name, size, color }: any) =>
    React.createElement('Ionicons', { name, size, color }, `${name}:${size}`);
  Ionicons.displayName = 'Ionicons';
  return { Ionicons };
});

jest.mock('../../lib/historyRepository', () => ({
  loadJapamStats: jest.fn(async () => new Map()),
  japamStatsFor: jest.fn(() => ({
    todayMalas: 0,
    todayTotalCount: 0,
    lifetimeMalas: 0,
    lifetimeTotalCount: 0,
  })),
}));

const mockSelectJapam = jest.fn();

let mockJapams: any[] = [];
let mockCurrentJapamId: string | null = null;
let mockIsLoading = false;

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => ({
    japams: mockJapams,
    currentJapamId: mockCurrentJapamId,
    isLoading: mockIsLoading,
    selectJapam: mockSelectJapam,
    createJapam: jest.fn(),
    renameJapam: jest.fn(),
    archiveJapam: jest.fn(),
    restoreJapam: jest.fn(),
  }),
}));

jest.mock('react-native', () => {
  const React = require('react');
  const makeHost = (name: string, mapProps?: (props: any) => any) => {
    const Host = ({ children, ...props }: any) =>
      React.createElement(name, mapProps ? mapProps(props) : props, children);
    Host.displayName = name;
    return Host;
  };

  const Modal = ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
    visible ? React.createElement(React.Fragment, null, children) : null;
  Modal.displayName = 'Modal';

  return {
    View: makeHost('View'),
    Text: makeHost('Text'),
    ScrollView: makeHost('ScrollView'),
    TextInput: makeHost('TextInput'),
    Pressable: makeHost('Pressable', (props: any) => ({
      ...props,
      style: typeof props.style === 'function' ? props.style({ pressed: false }) : props.style,
    })),
    Platform: { OS: 'android' },
    Alert: { alert: jest.fn() },
    Modal,
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  };
});

import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import AsyncStorage from '@react-native-async-storage/async-storage';

import MyJapamsScreen from '../my-japams';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
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

const textContent = (tree: any) => JSON.stringify(tree.toJSON());

const allPressables = (tree: any) => tree.root.findAll((node: any) => node.type === 'Pressable');

const pressableWithLabel = (tree: any, label: string) =>
  allPressables(tree).find((p: any) => p.props.accessibilityLabel === label);

const makeJapam = (overrides: Partial<any> = {}) => ({
  id: 'japam-1',
  userId: 'user-123',
  name: 'My Japam',
  syncStatus: 'synced',
  displayOrder: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  archivedAt: null,
  ...overrides,
});

describe('MyJapamsScreen selector vs management modes', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRouter.push.mockClear();
    mockRouter.back.mockClear();
    mockParams = {};
    mockJapams = [];
    mockCurrentJapamId = null;
    mockIsLoading = false;
    await AsyncStorage.clear();
  });

  it('selector mode hides archived Japams and shows a manage button', async () => {
    mockParams = { mode: 'selector' };
    mockJapams = [
      makeJapam({ id: 'active-1', name: 'My Japam', archivedAt: null }),
      makeJapam({ id: 'archived-1', name: 'Old My Japam', archivedAt: '2026-08-02T00:00:00.000Z' }),
      makeJapam({ id: 'archived-2', name: 'Test Japam', archivedAt: '2026-08-03T00:00:00.000Z' }),
    ];
    mockCurrentJapamId = 'active-1';
    const tree = await renderScreen();
    const content = textContent(tree);

    expect(content).toContain('My Japam');
    expect(content).not.toContain('Archived Japams');
    expect(content).not.toContain('Restore Old My Japam');
    expect(content).not.toContain('Restore Test Japam');
    expect(content).toContain('Manage My Japams');

    const manageButton = pressableWithLabel(tree, 'Manage My Japams');
    expect(manageButton).toBeTruthy();

    await act(async () => {
      manageButton.props.onPress();
    });
    expect(mockRouter.push).toHaveBeenCalledWith('/my-japams');
  });

  it('management mode shows archived Japams with Restore buttons', async () => {
    mockParams = {};
    mockJapams = [
      makeJapam({ id: 'active-1', name: 'My Japam', archivedAt: null }),
      makeJapam({ id: 'archived-1', name: 'Old My Japam', archivedAt: '2026-08-02T00:00:00.000Z' }),
      makeJapam({ id: 'archived-2', name: 'Test Japam', archivedAt: '2026-08-03T00:00:00.000Z' }),
    ];
    mockCurrentJapamId = 'active-1';
    const tree = await renderScreen();
    const content = textContent(tree);

    expect(content).toContain('My Japam');
    expect(content).toContain('Archived Japams');
    expect(content).toContain('Restore Old My Japam');
    expect(content).toContain('Restore Test Japam');
    expect(content).not.toContain('Manage My Japams');
  });

  it('selector mode does not show the manage button when there are no archived Japams', async () => {
    mockParams = { mode: 'selector' };
    mockJapams = [makeJapam({ id: 'active-1', name: 'My Japam', archivedAt: null })];
    mockCurrentJapamId = 'active-1';
    const tree = await renderScreen();
    const content = textContent(tree);

    expect(content).not.toContain('Archived Japams');
    expect(content).not.toContain('Manage My Japams');
  });

  it('selecting an active Japam in selector mode calls selectJapam and goes back', async () => {
    mockParams = { mode: 'selector' };
    mockJapams = [
      makeJapam({ id: 'active-1', name: 'My Japam', archivedAt: null }),
      makeJapam({ id: 'active-2', name: 'Evening Japam', archivedAt: null }),
    ];
    mockCurrentJapamId = 'active-1';
    const tree = await renderScreen();

    const evening = pressableWithLabel(tree, 'Select Evening Japam');
    expect(evening).toBeTruthy();

    await act(async () => {
      evening.props.onPress();
    });

    expect(mockSelectJapam).toHaveBeenCalledWith('active-2');
    expect(mockRouter.back).toHaveBeenCalled();
  });

});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const order: string[] = [];
const mockSupabaseSignOut = jest.fn();
const mockGoogleSignOut = jest.fn();

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: (...args: unknown[]) => mockSupabaseSignOut(...args),
    },
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    signOut: (...args: unknown[]) => mockGoogleSignOut(...args),
  },
}));

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => callback(), [callback]);
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

jest.mock('../../lib/historyStore', () => ({
  dedupeByCompletionId: (records: unknown[]) => records,
}));

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
    Switch: makeHost('Switch'),
    Pressable: makeHost('Pressable', (props: any) => ({
      ...props,
      style: typeof props.style === 'function' ? props.style({ pressed: false }) : props.style,
    })),
    Platform: {
      OS: 'android',
      select: (options: Record<string, unknown>) => options.android ?? options.default,
    },
    Alert: {
      alert: jest.fn((title: string) => {
        order.push(`alert:${title}`);
      }),
    },
    Dimensions: {
      get: jest.fn(() => ({ width: 390, height: 844 })),
    },
    Linking: {
      openURL: jest.fn(() => Promise.resolve()),
    },
    BackHandler: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    DeviceEventEmitter: {
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      emit: jest.fn((eventName: string) => {
        order.push(`event:${eventName}`);
      }),
    },
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement(React.Fragment, null, children) : null,
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { Alert, DeviceEventEmitter, Platform } from 'react-native';
import SettingsScreen from '../(tabs)/settings';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_MINUTES_KEY = 'timerMinutes';
const TIMER_LOOP_KEY = 'timerLoop';

const originalWindow = global.window;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderScreen = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(SettingsScreen));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const pressableWithText = (tree: any, label: string, occurrence = 0) => {
  const matches = tree.root.findAll((node: any) => {
    if (typeof node.props?.onPress !== 'function') return false;
    return node.findAll((child: any) => child !== node && child.props?.children === label).length > 0;
  });
  return matches[occurrence];
};

const lastPressableWithText = (tree: any, label: string) => {
  const matches = tree.root.findAll((node: any) => {
    if (typeof node.props?.onPress !== 'function') return false;
    return node.findAll((child: any) => child !== node && child.props?.children === label).length > 0;
  });
  return matches[matches.length - 1];
};

const completeLogout = async (tree: any) => {
  await act(async () => {
    const result = pressableWithText(tree, 'Logout', 0).props.onPress();
    if (result && typeof result.then === 'function') {
      await result;
    }
    await Promise.resolve();
  });
  await flush();
  await act(async () => {
    const result = lastPressableWithText(tree, 'Logout').props.onPress();
    if (result && typeof result.then === 'function') {
      await result;
    }
    await Promise.resolve();
  });
  await flush();
};

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
  order.length = 0;
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  process.env.EXPO_PUBLIC_SUPABASE_URL = '';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = '';
  mockSupabaseSignOut.mockResolvedValue({ error: null });
  mockGoogleSignOut.mockResolvedValue(undefined);
  await AsyncStorage.setItem(USER_ID_KEY, 'user-123');
  await AsyncStorage.setItem(USER_NAME_KEY, 'Test User');
  await AsyncStorage.setItem(USER_EMAIL_KEY, 'test@example.com');
  await AsyncStorage.setItem(TIMER_SECONDS_KEY, '45');
  await AsyncStorage.setItem(TIMER_RUNNING_KEY, 'false');
  await AsyncStorage.setItem(TIMER_TARGET_KEY, '60');
  await AsyncStorage.setItem(TIMER_MINUTES_KEY, '1');
  await AsyncStorage.setItem(TIMER_LOOP_KEY, 'false');
});

afterEach(() => {
  jest.restoreAllMocks();
  global.window = originalWindow;
});

describe('Settings logout regression', () => {
  it('successful native logout keeps the expected order and clears local auth state', async () => {
    mockSupabaseSignOut.mockImplementation(async () => {
      order.push('supabase.signOut');
      return { error: null };
    });
    mockGoogleSignOut.mockImplementation(async () => {
      order.push('google.signOut');
    });

    const tree = await renderScreen();
    await completeLogout(tree);

    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_NAME_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(USER_EMAIL_KEY)).toBeNull();
    expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignOut).toHaveBeenCalledTimes(1);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('japam-auth-updated');
    expect(Alert.alert).toHaveBeenCalledWith('Logged out', 'You have been logged out.');
    expect(AsyncStorage.removeItem).toHaveBeenNthCalledWith(1, USER_NAME_KEY);
    expect(AsyncStorage.removeItem).toHaveBeenNthCalledWith(2, USER_EMAIL_KEY);
    expect(AsyncStorage.removeItem).toHaveBeenNthCalledWith(3, USER_ID_KEY);
    expect((AsyncStorage as any).multiRemove).toHaveBeenCalledWith([
      TIMER_SECONDS_KEY,
      TIMER_RUNNING_KEY,
      TIMER_TARGET_KEY,
      TIMER_MINUTES_KEY,
      TIMER_LOOP_KEY,
    ]);

    const removeItemOrders = (AsyncStorage.removeItem as jest.Mock).mock.invocationCallOrder;
    const multiRemoveOrder = (AsyncStorage as any).multiRemove.mock.invocationCallOrder[0];
    const supabaseOrder = mockSupabaseSignOut.mock.invocationCallOrder[0];
    const googleOrder = mockGoogleSignOut.mock.invocationCallOrder[0];
    const eventOrder = (DeviceEventEmitter.emit as jest.Mock).mock.invocationCallOrder[0];
    const alertOrder = (Alert.alert as jest.Mock).mock.invocationCallOrder[0];
    const firstLocalCleanupOrder = Math.min(...removeItemOrders, multiRemoveOrder);

    expect(supabaseOrder).toBeLessThan(firstLocalCleanupOrder);
    expect(removeItemOrders[0]).toBeLessThan(removeItemOrders[1]);
    expect(removeItemOrders[1]).toBeLessThan(removeItemOrders[2]);
    expect(multiRemoveOrder).toBeLessThan(googleOrder);
    expect(googleOrder).toBeLessThan(eventOrder);
    expect(eventOrder).toBeLessThan(alertOrder);
  });

  it('continues logout when Supabase signOut returns an error', async () => {
    const supabaseError = new Error('supabase signout failed');
    mockSupabaseSignOut.mockImplementation(async () => {
      order.push('supabase.signOut');
      return { error: supabaseError };
    });
    mockGoogleSignOut.mockImplementation(async () => {
      order.push('google.signOut');
    });

    const tree = await renderScreen();
    await completeLogout(tree);

    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(mockGoogleSignOut).toHaveBeenCalledTimes(1);
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('japam-auth-updated');
    expect(Alert.alert).toHaveBeenCalledWith('Logged out', 'You have been logged out.');
    expect(console.log).toHaveBeenCalledWith('Supabase signOut error:', supabaseError);
  });

  it('continues logout when native Google signOut throws', async () => {
    const googleError = new Error('google signout failed');
    mockSupabaseSignOut.mockImplementation(async () => {
      order.push('supabase.signOut');
      return { error: null };
    });
    mockGoogleSignOut.mockImplementation(async () => {
      order.push('google.signOut');
      throw googleError;
    });

    const tree = await renderScreen();
    await completeLogout(tree);

    expect(await AsyncStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(DeviceEventEmitter.emit).toHaveBeenCalledWith('japam-auth-updated');
    expect(Alert.alert).toHaveBeenCalledWith('Logged out', 'You have been logged out.');
    expect(console.log).toHaveBeenCalledWith('Google signOut error:', googleError);
  });

  it('skips Google signOut on web while completing logout', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    global.window = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
      confirm: jest.fn(),
    } as any;
    mockSupabaseSignOut.mockImplementation(async () => {
      order.push('supabase.signOut');
      return { error: null };
    });

    const tree = await renderScreen();
    await completeLogout(tree);

    expect(mockGoogleSignOut).not.toHaveBeenCalled();
    expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith('Logged out', 'You have been logged out.');
  });
});

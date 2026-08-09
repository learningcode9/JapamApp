/* eslint-disable import/first, @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
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
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  dismissNotificationAsync: jest.fn(async () => undefined),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../../components/CurrentJapamHeaderButton', () => 'CurrentJapamHeaderButton');
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
jest.mock('../../lib/supabaseRestHelper', () => ({ fetchJapamHistoryRows: jest.fn(async () => null) }));
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
    DeviceEventEmitter: { addListener: jest.fn(() => ({ remove: jest.fn() })), emit: jest.fn() },
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

import {
  isCurrentHomeWorkspaceRefresh,
  resolveHomeWorkspaceTotal,
} from '../(tabs)/index';

describe('Home offline workspace total isolation', () => {
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
});

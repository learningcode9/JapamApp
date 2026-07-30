/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockListeners = new Map<string, Set<(payload?: any) => void>>();

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  AppState: {
    currentState: 'background',
    addEventListener: jest.fn((event: string, cb: (payload?: any) => void) => {
      const set = mockListeners.get(event) ?? new Set();
      set.add(cb);
      mockListeners.set(event, set);
      return { remove: jest.fn(() => set.delete(cb)) };
    }),
  },
  DeviceEventEmitter: {
    addListener: jest.fn((event: string, cb: (payload?: any) => void) => {
      const set = mockListeners.get(event) ?? new Set();
      set.add(cb);
      mockListeners.set(event, set);
      return { remove: jest.fn(() => set.delete(cb)) };
    }),
    emit: jest.fn((event: string, payload?: any) => {
      mockListeners.get(event)?.forEach((cb) => cb(payload));
    }),
  },
  Platform: {
    OS: 'android',
    select: (options: Record<string, unknown>) => options.android ?? options.default,
  },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  Vibration: { vibrate: jest.fn() },
}));

jest.mock('expo-av', () => ({
  Audio: {
    Sound: {
      createAsync: jest.fn(async () => ({
        sound: {
          stopAsync: jest.fn(async () => {}),
          playAsync: jest.fn(async () => {}),
          unloadAsync: jest.fn(async () => {}),
          setOnPlaybackStatusUpdate: jest.fn(),
        },
      })),
    },
    setAudioModeAsync: jest.fn(async () => {}),
  },
}));

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high', LOW: 'low' },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  setNotificationChannelAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  dismissNotificationAsync: jest.fn(async () => {}),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
}));

jest.mock('expo-router', () => ({
  usePathname: jest.fn(() => '/timer'),
  useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
}));

// --- Module-level state for the race condition ---
let sessionReady = false;

const mockGetSession = jest.fn<
  Promise<{ data: { session: { access_token: string; user: { id: string } } | null }; error: null }>,
  []
>(async () => {
  if (sessionReady) {
    return {
      data: { session: { access_token: 'orch-token', user: { id: '123e4567-e89b-12d3-a456-426614174000' } } },
      error: null,
    };
  }
  return { data: { session: null }, error: null };
});

const mockSupabaseFrom = jest.fn(() => ({
  upsert: jest.fn(async () => ({ error: null })),
  select: jest.fn(() => ({
    eq: jest.fn(() => ({
      single: jest.fn(async () => ({ data: null, error: null })),
      maybeSingle: jest.fn(async () => ({ data: null, error: null })),
    })),
  })),
}));

const mockSignInWithIdToken = jest.fn(async () => {
  DeviceEventEmitter.emit('japam-auth-updated');
  sessionReady = true;
  return {
    data: {
      session: {
        access_token: 'orch-token',
        user: { id: '123e4567-e89b-12d3-a456-426614174000' },
      },
    },
    error: null,
  };
});

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      signInWithIdToken: (opts: any) => (mockSignInWithIdToken as any)(opts),
    },
    from: () => mockSupabaseFrom(),
  },
}));

jest.mock('../../lib/timerForegroundService', () => ({
  getNativeTimerState: jest.fn(async () => null),
  pauseForegroundService: jest.fn(async () => {}),
  setNativeAppActive: jest.fn(),
  startForegroundService: jest.fn(async () => {}),
  stopForegroundService: jest.fn(async () => {}),
}));

jest.mock('../../lib/webOmAudio', () => ({
  getWebOmAudioUri: jest.fn(async () => 'om.mp3'),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signInSilently: jest.fn(async () => ({ data: { idToken: 'orch-id-token' } })),
    signOut: jest.fn(async () => {}),
  },
}));

// DO NOT mock sessionRecovery — use the real module

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { DeviceEventEmitter } from 'react-native';
import { TimerProvider } from '../timer-context';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

const UID = '123e4567-e89b-12d3-a456-426614174000';
const JAPAM_A_ID = 'japam-a';
const JAPAM_A_NAME = 'Japam A';
const HISTORY_KEY = 'history';
const SUPABASE_URL = 'https://project.supabase.co';
const SUPABASE_ANON_KEY = 'anon-key';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let historyUploadCount = 0;

const restoreAsyncStorageMockImplementations = () => {
  const storage = () => (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__;
  (AsyncStorage.multiSet as jest.Mock).mockImplementation(
    async (pairs: [string, string][]) => {
      pairs.forEach(([key, value]) => { storage()[key] = value; });
      return null;
    },
  );
  (AsyncStorage.setItem as jest.Mock).mockImplementation(
    async (key: string, value: string) => { storage()[key] = value; return null; },
  );
  (AsyncStorage.multiGet as jest.Mock).mockImplementation(async (keys: string[]) =>
    keys.map((key) => [key, storage()[key] || null]),
  );
  (AsyncStorage.getItem as jest.Mock).mockImplementation(
    async (key: string) => storage()[key] || null,
  );
  (AsyncStorage.multiRemove as jest.Mock).mockImplementation(async (keys: string[]) => {
    keys.forEach((key) => { delete storage()[key]; });
    return null;
  });
  (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
    delete storage()[key];
    return null;
  });
  (AsyncStorage.clear as jest.Mock).mockImplementation(async () => {
    (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__ = {};
    return null;
  });
};

const makePendingRecord = (overrides: Record<string, unknown> = {}) => ({
  date: new Date().toISOString(),
  malas: 1,
  totalCount: 108,
  duration: 60,
  manual: false,
  userId: UID,
  userName: 'Test User',
  completionId: `test:${Date.now()}`,
  japamId: JAPAM_A_ID,
  japamName: JAPAM_A_NAME,
  syncStatus: 'pending' as const,
  ...overrides,
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  restoreAsyncStorageMockImplementations();
  historyUploadCount = 0;
  sessionReady = false;

  global.fetch = jest.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('japam_history') && options?.method === 'POST') {
      historyUploadCount++;
      return { ok: true, json: async () => ({}), status: 201 } as unknown as Response;
    }
    if (url.includes('japams')) {
      return { ok: true, json: async () => [], status: 200 } as unknown as Response;
    }
    if (url.includes('deleted_completions')) {
      return { ok: true, json: async () => [], status: 200 } as unknown as Response;
    }
    if (url.includes('japam_user_totals')) {
      return { ok: true, json: async () => ({}), status: 200 } as unknown as Response;
    }
    return { ok: true, json: async () => ({}), status: 200 } as unknown as Response;
  }) as jest.Mock;

  process.env.EXPO_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

  await AsyncStorage.setItem('userId', UID);
  await AsyncStorage.setItem('userName', 'Test User');
  await AsyncStorage.setItem(`currentJapamId:${UID}`, JAPAM_A_ID);
  await AsyncStorage.setItem(
    `userJapams:${UID}`,
    JSON.stringify([
      {
        id: JAPAM_A_ID,
        userId: UID,
        name: JAPAM_A_NAME,
        displayOrder: null,
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        archivedAt: null,
      },
    ]),
  );
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  delete (global as any).fetch;
});

describe('sync orchestration with real recoverSessionIfNeeded', () => {
  it('pending row + signInWithIdToken emits auth event mid-sync -> exactly one upload', async () => {
    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));

    await act(async () => {
      renderer.create(
        React.createElement(TimerProvider, null, React.createElement(() => null)),
      );
      await Promise.resolve();
    });
    await flush();

    // Mount effect sync exits early (empty userIdRef).
    // Emit japam-auth-updated to trigger refreshAuthState:
    //   1. Sets userIdRef.current from AsyncStorage
    //   2. Calls syncPendingHistory (real sync starts here)
    // Inside the real sync:
    //   - recoverSessionIfNeeded (real module) calls signInSilently → signInWithIdToken
    //   - Mock signInWithIdToken emits a SECOND japam-auth-updated while still in-flight
    //   - Second event triggers syncPendingHistory which sees syncInFlightPromise → no duplicate
    //   - Only ONE upload
    await act(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
      // Wait for full async flow (recovery + sync + upload)
      await sleep(1000);
    });
    await flush();

    const GoogleSigninMock = GoogleSignin as jest.Mocked<typeof GoogleSignin>;
    expect(GoogleSigninMock.signInSilently).toHaveBeenCalledTimes(1);

    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);

    expect(historyUploadCount).toBe(1);

    const history = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    expect(history[0].syncStatus).toBe('synced');
  });
});

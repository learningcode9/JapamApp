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

const mockGetSession = jest.fn<Promise<{ data: { session: { access_token: string; user: { id: string } } | null; user: { id: string } | null }; error: null }>, []>(async () => ({
  data: { session: null, user: null },
  error: null,
}));

const mockSupabaseFrom = jest.fn(() => ({
  upsert: jest.fn(async () => ({ error: null })),
  select: jest.fn(() => ({
    eq: jest.fn(() => ({
      order: jest.fn(async () => ({ data: [], error: null })),
      single: jest.fn(async () => ({ data: null, error: null })),
    })),
  })),
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
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
    signInSilently: jest.fn(async () => { throw new Error('not configured in test'); }),
  },
}));

jest.mock('../../lib/sessionRecovery', () => ({
  recoverSessionIfNeeded: jest.fn(async () => true),
  resetRecoveryState: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { DeviceEventEmitter } from 'react-native';
import { TimerProvider, useTimer } from '../timer-context';
import { recoverSessionIfNeeded } from '../../lib/sessionRecovery';
/* eslint-enable import/first, @typescript-eslint/no-require-imports */

const UID = 'test-user-uuid';
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

let currentTimer: ReturnType<typeof useTimer> | null = null;
const Capture = () => {
  currentTimer = useTimer();
  return null;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
void currentTimer;

const renderTimerProvider = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(
      React.createElement(TimerProvider, null, React.createElement(Capture)),
    );
    await Promise.resolve();
  });
  await flush();
  return tree;
};

const restoreAsyncStorageMockImplementations = () => {
  const storage = () => (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__;
  (AsyncStorage.multiSet as jest.Mock).mockImplementation(async (pairs: [string, string][]) => {
    pairs.forEach(([key, value]) => {
      storage()[key] = value;
    });
    return null;
  });
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    storage()[key] = value;
    return null;
  });
  (AsyncStorage.multiGet as jest.Mock).mockImplementation(async (keys: string[]) =>
    keys.map((key) => [key, storage()[key] || null]),
  );
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage()[key] || null);
  (AsyncStorage.multiRemove as jest.Mock).mockImplementation(async (keys: string[]) => {
    keys.forEach((key) => {
      delete storage()[key];
    });
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

let historyUploadCount = 0;
let fetchUrls: string[] = [];

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  restoreAsyncStorageMockImplementations();
  historyUploadCount = 0;
  fetchUrls = [];

  global.fetch = jest.fn(async (url: string, options?: RequestInit) => {
    fetchUrls.push(url);
    // Count only actual japam_history POSTs (not tombstone fetches or Japam sync)
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

  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'test-token', user: { id: UID } }, user: { id: UID } },
    error: null,
  });

  process.env.EXPO_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

  await AsyncStorage.setItem('userId', UID);
  await AsyncStorage.setItem('userName', 'Test User');
  await AsyncStorage.setItem(`currentJapamId:${UID}`, JAPAM_A_ID);
  await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([
    { id: JAPAM_A_ID, userId: UID, name: JAPAM_A_NAME, displayOrder: null, createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:00.000Z', archivedAt: null },
  ]));
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  delete (global as any).fetch;
});

const triggerAndWaitForSync = async () => {
  // Emit auth-updated event which triggers syncPendingHistory via the auth listener
  DeviceEventEmitter.emit('japam-auth-updated');
  // Wait for async sync + upload to complete
  await sleep(500);
  await flush();
};

describe('syncPendingHistory serialization', () => {
  it('pending row + existing session -> syncPendingHistory uploads exactly once', async () => {
    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));
    await renderTimerProvider();
    await flush();

    await triggerAndWaitForSync();

    expect(historyUploadCount).toBe(1);
    expect(fetchUrls.some((u) => u.includes('japam_history'))).toBe(true);

    const history = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    expect(history[0].syncStatus).toBe('synced');
  });

  it('two concurrent sync triggers -> only one upload', async () => {
    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));
    await renderTimerProvider();
    await flush();

    // Fire TWO auth events synchronously before either resolves
    DeviceEventEmitter.emit('japam-auth-updated');
    DeviceEventEmitter.emit('japam-auth-updated');

    await sleep(500);
    await flush();

    // The shared in-flight promise should have serialized the two calls into one upload
    expect(historyUploadCount).toBe(1);
  });

  it('syncPendingHistory with recovery -> recovery called, upload once', async () => {
    (recoverSessionIfNeeded as jest.Mock).mockClear();

    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));
    await renderTimerProvider();
    await flush();

    await triggerAndWaitForSync();

    expect(historyUploadCount).toBe(1);
    expect(recoverSessionIfNeeded).toHaveBeenCalled();
  });

  it('recovery failure -> no uploads, row stays pending', async () => {
    (recoverSessionIfNeeded as jest.Mock).mockResolvedValue(false);
    mockGetSession.mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    });

    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));
    await renderTimerProvider();
    await flush();

    await triggerAndWaitForSync();

    expect(historyUploadCount).toBe(0);
    const history = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    expect(history[0].syncStatus).toBe('pending');
  });

  it('existing session + no pending -> no uploads, no recovery', async () => {
    (recoverSessionIfNeeded as jest.Mock).mockClear();

    await renderTimerProvider();
    await flush();

    await triggerAndWaitForSync();

    expect(historyUploadCount).toBe(0);
  });

  it('repeated auth events after successful sync -> no duplicate upload', async () => {
    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));
    await renderTimerProvider();
    await flush();

    await triggerAndWaitForSync();
    expect(historyUploadCount).toBe(1);

    // Emit multiple auth events after first sync completed
    DeviceEventEmitter.emit('japam-auth-updated');
    await sleep(100);
    DeviceEventEmitter.emit('japam-auth-updated');
    await sleep(100);
    DeviceEventEmitter.emit('japam-auth-updated');
    await sleep(500);
    await flush();

    // Still only one upload (no new pending records)
    expect(historyUploadCount).toBe(1);
  });
});

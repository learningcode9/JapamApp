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

const mockSupabaseFromUpsert = jest.fn(async (table: string, data: any, options: any) => ({ error: null }));
const mockSupabaseFrom = jest.fn((table: string) => ({
  upsert: (data: any, options: any) => mockSupabaseFromUpsert(table, data, options),
  select: jest.fn(() => ({
    eq: jest.fn(() => ({
      order: jest.fn(async () => ({ data: [], error: null })),
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
    from: (table: string) => mockSupabaseFrom(table),
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
let historyUploadBodies: Record<string, unknown>[] = [];
let storageOps: { type: 'set' | 'remove' | 'multiSet' | 'multiRemove'; key: string; value?: string }[] = [];
let componentRoot: { unmount: () => void } | null = null;

const restoreAsyncStorageMockImplementations = () => {
  const storage = () => (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__;
  (AsyncStorage.multiSet as jest.Mock).mockImplementation(
    async (pairs: [string, string][]) => {
      pairs.forEach(([key, value]) => {
        storageOps.push({ type: 'multiSet', key, value });
        storage()[key] = value;
      });
      return null;
    },
  );
  (AsyncStorage.setItem as jest.Mock).mockImplementation(
    async (key: string, value: string) => {
      storageOps.push({ type: 'set', key, value });
      storage()[key] = value;
      return null;
    },
  );
  (AsyncStorage.multiGet as jest.Mock).mockImplementation(async (keys: string[]) =>
    keys.map((key) => [key, storage()[key] || null]),
  );
  (AsyncStorage.getItem as jest.Mock).mockImplementation(
    async (key: string) => storage()[key] || null,
  );
  (AsyncStorage.getAllKeys as jest.Mock).mockImplementation(async () => Object.keys(storage()));
  (AsyncStorage.multiRemove as jest.Mock).mockImplementation(async (keys: string[]) => {
    keys.forEach((key) => {
      storageOps.push({ type: 'multiRemove', key });
      delete storage()[key];
    });
    return null;
  });
  (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
    storageOps.push({ type: 'remove', key });
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
  historyUploadBodies = [];
  storageOps = [];
  sessionReady = false;

  global.fetch = jest.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('japam_history') && options?.method === 'POST') {
      historyUploadCount++;
      historyUploadBodies.push(JSON.parse(String(options?.body || '{}')));
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
  if (componentRoot) {
    const r = require('react-test-renderer');
    r.act(() => { componentRoot!.unmount(); });
    componentRoot = null;
  }
});

describe('sync orchestration with real recoverSessionIfNeeded', () => {
  it('pending row + signInWithIdToken emits auth event mid-sync -> exactly one upload', async () => {
    const pending = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([pending]));

    await act(async () => {
      componentRoot = renderer.create(
        React.createElement(TimerProvider, null, React.createElement(() => null)),
      );
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
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

  it('legacy numeric userId -> silent recovery upgrades to UUID, migrates scoped values, and uploads history + timer retry exactly once each', async () => {
    const NUMERIC = '108347881408167165195';
    const UUID_ID = '2793fca2-38fa-4c9e-9856-26c2b34d0acb';
    const JAPAM_A = 'japam-a';
    const JAPAM_A_NAME = 'Japam A';
    const HISTORY_COMPLETION_ID = 'history-legacy-1';
    const TIMER_COMPLETION_ID = 'timer-legacy-1';
    const warned: unknown[][] = [];
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });

    jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });

    await AsyncStorage.clear();
    await AsyncStorage.setItem('userId', NUMERIC);
    await AsyncStorage.setItem('userName', 'Test User');
    await AsyncStorage.setItem('timerSessionUserId', NUMERIC);
    await AsyncStorage.setItem(`currentJapamId:${NUMERIC}`, JAPAM_A);
    await AsyncStorage.setItem(
      `userJapams:${NUMERIC}`,
      JSON.stringify([
        {
          id: JAPAM_A,
          name: JAPAM_A_NAME,
          userId: NUMERIC,
          displayOrder: null,
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
          archivedAt: null,
        },
      ])
    );
    await AsyncStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([
        makePendingRecord({
          userId: NUMERIC,
          completionId: HISTORY_COMPLETION_ID,
          japamId: JAPAM_A,
          japamName: JAPAM_A_NAME,
        }),
      ])
    );
    await AsyncStorage.setItem(
      'timerPendingCompletions:v1',
      JSON.stringify([
        {
          version: 1,
          userId: NUMERIC,
          sessionId: 'timer-session-1',
          loopNumber: 1,
          totalLoops: 1,
          japamId: JAPAM_A,
          japamName: JAPAM_A_NAME,
          durationSeconds: 600,
          completedAt: '2026-07-30T00:00:00.000Z',
          completionId: TIMER_COMPLETION_ID,
        },
      ])
    );

    mockGetSession.mockImplementation(async () => {
      if (sessionReady) {
        return {
          data: { session: { access_token: 'orch-token', user: { id: UUID_ID } } },
          error: null,
        };
      }
      return { data: { session: null }, error: null };
    });
    mockSignInWithIdToken.mockImplementation(async () => {
      DeviceEventEmitter.emit('japam-auth-updated');
      sessionReady = true;
      await recoveryGate;
      return {
        data: {
          session: { access_token: 'orch-token', user: { id: UUID_ID } },
        },
        error: null,
      };
    });

    await act(async () => {
      componentRoot = renderer.create(
        React.createElement(TimerProvider, null, React.createElement(() => null)),
      );
      await Promise.resolve();
    });
    await flush();

    const waitForLocalTimerSave = async () => {
      for (let i = 0; i < 60; i += 1) {
        const currentHistory = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
        const timerRow = currentHistory.find((item: { completionId?: string }) => item.completionId === TIMER_COMPLETION_ID);
        const queue = JSON.parse((await AsyncStorage.getItem('timerPendingCompletions:v1')) || '[]');
        if (timerRow && queue.length === 0) return;
        await sleep(50);
      }
      throw new Error('timed out waiting for timer completion to be saved locally');
    };

    const waitForUploadCount = async (expected: number) => {
      for (let i = 0; i < 60; i += 1) {
        if (historyUploadCount === expected) return;
        await sleep(50);
      }
      throw new Error(`timed out waiting for ${expected} history uploads; saw ${historyUploadCount}`);
    };

    await waitForLocalTimerSave();
    releaseRecovery();
    await waitForUploadCount(2);
    await flush();

    const GoogleSigninMock = GoogleSignin as jest.Mocked<typeof GoogleSignin>;
    const history = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    const timerQueue = JSON.parse((await AsyncStorage.getItem('timerPendingCompletions:v1')) || '[]');
    const japams = JSON.parse((await AsyncStorage.getItem(`userJapams:${UUID_ID}`)) || '[]');
    const completionIds = history.map((item: { completionId: string }) => item.completionId);
    const uploadCompletionIds = historyUploadBodies.map((item) => String(item.completion_id));
    const historySaveIndex = storageOps.findIndex(
      (op) =>
        op.type === 'set' &&
        op.key === HISTORY_KEY &&
        JSON.parse(op.value || '[]').some(
          (item: { completionId?: string; syncStatus?: string }) =>
            item.completionId === TIMER_COMPLETION_ID && item.syncStatus === 'pending'
        )
    );
    const queueRemovalIndex = storageOps.findIndex(
      (op) => op.type === 'set' && op.key === 'timerPendingCompletions:v1' && op.value === '[]'
    );

    expect(GoogleSigninMock.signInSilently).toHaveBeenCalledTimes(1);
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);
    expect(historyUploadCount).toBe(2);
    expect(new Set(uploadCompletionIds)).toEqual(new Set([HISTORY_COMPLETION_ID, TIMER_COMPLETION_ID]));
    expect(uploadCompletionIds.filter((id) => id === HISTORY_COMPLETION_ID)).toHaveLength(1);
    expect(uploadCompletionIds.filter((id) => id === TIMER_COMPLETION_ID)).toHaveLength(1);
    expect(mockSupabaseFromUpsert).toHaveBeenCalledTimes(2);
    expect(mockSupabaseFromUpsert.mock.calls.map((call) => call[0])).toEqual(['japams', 'japams']);
    expect(mockSupabaseFromUpsert.mock.calls.map((call) => call[1].user_id)).toEqual([UUID_ID, UUID_ID]);
    expect(history).toHaveLength(2);
    expect(new Set(completionIds).size).toBe(2);
    expect(new Set(history.map((item: { userId?: string }) => item.userId))).toEqual(new Set([UUID_ID]));
    expect(history.every((item: { syncStatus?: string }) => item.syncStatus === 'synced')).toBe(true);
    expect(await AsyncStorage.getItem('userId')).toBe(UUID_ID);
    expect(await AsyncStorage.getItem('timerSessionUserId')).toBe(UUID_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UUID_ID}`)).toBe(JAPAM_A);
    expect(await AsyncStorage.getItem(`currentJapamId:${NUMERIC}`)).toBeNull();
    expect(japams).toHaveLength(1);
    expect(japams[0].userId).toBe(UUID_ID);
    expect(await AsyncStorage.getItem(`userJapams:${NUMERIC}`)).toBeNull();
    expect(timerQueue).toEqual([]);
    expect(await AsyncStorage.getItem('timerPendingCompletions:v1')).toBe(JSON.stringify([]));
    expect(historySaveIndex).toBeGreaterThanOrEqual(0);
    expect(queueRemovalIndex).toBeGreaterThan(historySaveIndex);
    expect(warned.some((args) => args.some((arg) => String(arg).includes('USER_ID_MISMATCH')))).toBe(false);
  });
});

/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock')
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

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
    },
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { AppState, DeviceEventEmitter } from 'react-native';
import { TimerProvider, useTimer } from '../timer-context';
import { getTimerState, updateTimerState } from '../../lib/timerState';
import { makeLoopCompletionId, toLocalDayKey } from '../../lib/historyStore';
import {
  TIMER_PENDING_COMPLETIONS_KEY,
  type PendingTimerCompletion,
} from '../../lib/timerPendingCompletions';
import {
  getNativeTimerState,
  startForegroundService,
} from '../../lib/timerForegroundService';
/* eslint-enable import/first, @typescript-eslint/no-require-imports */

const UID = 'user-123';
const JAPAM_A_ID = 'japam-a';
const JAPAM_A_NAME = 'Japam A';
const JAPAM_B_ID = 'japam-b';
const JAPAM_B_NAME = 'Japam B';
const HISTORY_KEY = 'history';
const SESSION_ID_KEY = 'timerSessionId';
const SESSION_USER_ID_KEY = 'timerSessionUserId';
const SESSION_JAPAM_ID_KEY = 'timerSessionJapamId';
const SESSION_JAPAM_NAME_KEY = 'timerSessionJapamName';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const waitForCondition = async (
  condition: () => Promise<boolean>,
  attempts = 200,
) => {
  let lastResult = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await flush();
    lastResult = await condition();
    if (lastResult) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(lastResult).toBe(true);
};

let currentTimer: ReturnType<typeof useTimer> | null = null;

const Capture = () => {
  currentTimer = useTimer();
  return null;
};

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

const seedAuthAndJapam = async () => {
  await AsyncStorage.setItem('userId', UID);
  await AsyncStorage.setItem('userName', 'Test User');
  await AsyncStorage.setItem(`currentJapamId:${UID}`, JAPAM_A_ID);
  await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([
    {
      id: JAPAM_A_ID,
      userId: UID,
      name: JAPAM_A_NAME,
      displayOrder: null,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      archivedAt: null,
    },
    {
      id: JAPAM_B_ID,
      userId: UID,
      name: JAPAM_B_NAME,
      displayOrder: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      archivedAt: null,
    },
  ]));
};

const readHistory = async () => JSON.parse(await AsyncStorage.getItem(HISTORY_KEY) || '[]');

const readQueue = async (): Promise<PendingTimerCompletion[]> =>
  JSON.parse(await AsyncStorage.getItem(TIMER_PENDING_COMPLETIONS_KEY) || '[]');

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

const seedPersistedSession = async ({
  sessionId,
  japamId = JAPAM_A_ID,
  japamName = JAPAM_A_NAME,
  currentJapamId = japamId,
  durationSeconds = 180,
  seconds,
  paused,
  totalLoops = 3,
  completedLoops = 0,
  running = 'true',
  startedAt = Date.now() - 1000,
}: {
  sessionId: string;
  japamId?: string;
  japamName?: string;
  currentJapamId?: string;
  durationSeconds?: number;
  seconds?: number;
  paused?: string;
  totalLoops?: number;
  completedLoops?: number;
  running?: 'true' | 'false';
  startedAt?: number;
}) => {
  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));
  await AsyncStorage.multiSet([
    [`currentJapamId:${UID}`, currentJapamId],
    [SESSION_ID_KEY, sessionId],
    [`${SESSION_ID_KEY}:${UID}`, sessionId],
    [`${SESSION_ID_KEY}:${UID}:${japamId}`, sessionId],
    [SESSION_USER_ID_KEY, UID],
    [`${SESSION_USER_ID_KEY}:${UID}`, UID],
    [`${SESSION_USER_ID_KEY}:${UID}:${japamId}`, UID],
    [SESSION_JAPAM_ID_KEY, japamId],
    [`${SESSION_JAPAM_ID_KEY}:${UID}`, japamId],
    [`${SESSION_JAPAM_ID_KEY}:${UID}:${japamId}`, japamId],
    [SESSION_JAPAM_NAME_KEY, japamName],
    [`${SESSION_JAPAM_NAME_KEY}:${UID}`, japamName],
    [`${SESSION_JAPAM_NAME_KEY}:${UID}:${japamId}`, japamName],
    ['timerCompletedLoops', String(completedLoops)],
    [`timerCompletedLoops:${UID}`, String(completedLoops)],
    [`timerCompletedLoops:${UID}:${japamId}`, String(completedLoops)],
    ['timerRunning', running],
    [`timerRunning:${UID}`, running],
    [`timerRunning:${UID}:${japamId}`, running],
    ['timerSeconds', String(seconds ?? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))],
    [`timerSeconds:${UID}`, String(seconds ?? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))],
    [`timerSeconds:${UID}:${japamId}`, String(seconds ?? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))],
    ['timerPaused', paused ?? String(running === 'false' && (seconds ?? 0) > 0)],
    [`timerPaused:${UID}`, paused ?? String(running === 'false' && (seconds ?? 0) > 0)],
    [`timerPaused:${UID}:${japamId}`, paused ?? String(running === 'false' && (seconds ?? 0) > 0)],
    ['timerStartedAt', String(startedAt)],
    [`timerStartedAt:${UID}`, String(startedAt)],
    [`timerStartedAt:${UID}:${japamId}`, String(startedAt)],
    ['timerTarget', String(durationSeconds)],
    [`timerTarget:${UID}`, String(durationSeconds)],
    [`timerTarget:${UID}:${japamId}`, String(durationSeconds)],
    ['timerTab_duration', String(durationMinutes)],
    [`timerTab_duration:${UID}`, String(durationMinutes)],
    [`timerTab_duration:${UID}:${japamId}`, String(durationMinutes)],
    ['timerTab_loops', String(totalLoops)],
    [`timerTab_loops:${UID}`, String(totalLoops)],
    [`timerTab_loops:${UID}:${japamId}`, String(totalLoops)],
  ]);
};

describe('TimerProvider restored/native final-loop retry', () => {
  let mountedTree: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockListeners.clear();
    restoreAsyncStorageMockImplementations();
    (AppState.addEventListener as jest.Mock).mockImplementation((event: string, cb: (payload?: any) => void) => {
      const set = mockListeners.get(event) ?? new Set();
      set.add(cb);
      mockListeners.set(event, set);
      return { remove: jest.fn(() => set.delete(cb)) };
    });
    (DeviceEventEmitter.addListener as jest.Mock).mockImplementation((event: string, cb: (payload?: any) => void) => {
      const set = mockListeners.get(event) ?? new Set();
      set.add(cb);
      mockListeners.set(event, set);
      return { remove: jest.fn(() => set.delete(cb)) };
    });
    (DeviceEventEmitter.emit as jest.Mock).mockImplementation((event: string, payload?: any) => {
      mockListeners.get(event)?.forEach((cb) => cb(payload));
    });
    currentTimer = null;
    mountedTree = null;
    updateTimerState({
      sessionId: '',
      startedAt: null,
      durationSeconds: 600,
      completedLoops: 0,
      totalLoops: 1,
      soundEnabled: true,
      vibrationEnabled: true,
      soundObject: null,
      appIsActive: true,
      isCompleting: false,
      userId: '',
      lastSavedCompletedLoops: 0,
    });
    await AsyncStorage.clear();
    await seedAuthAndJapam();
  });

  afterEach(() => {
    if (mountedTree) {
      renderer.act(() => {
        mountedTree.unmount();
      });
    }
    jest.restoreAllMocks();
  });

  it('persists session identity before starting native and blocks native start on persistence failure', async () => {
    let releasePersist!: () => void;
    const multiSetSpy = jest.spyOn(AsyncStorage, 'multiSet').mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releasePersist = () => resolve();
      }),
    );
    mountedTree = await renderTimerProvider();

    let startPromise!: Promise<void>;
    await act(async () => {
      currentTimer!.setActiveJapamSelection(JAPAM_A_ID, JAPAM_A_NAME);
      startPromise = Promise.resolve(currentTimer!.start());
      await Promise.resolve();
    });
    expect(startForegroundService).not.toHaveBeenCalled();

    releasePersist();
    await act(async () => {
      await startPromise;
    });
    expect(startForegroundService).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(`${SESSION_JAPAM_ID_KEY}:${UID}:${JAPAM_A_ID}`)).toBe(JAPAM_A_ID);
    expect(await AsyncStorage.getItem(`${SESSION_JAPAM_NAME_KEY}:${UID}:${JAPAM_A_ID}`)).toBe(JAPAM_A_NAME);
    multiSetSpy.mockRestore();

    await act(async () => {
      currentTimer!.reset();
      await Promise.resolve();
    });
    await flush();
    const failedMultiSetSpy = jest.spyOn(AsyncStorage, 'multiSet').mockRejectedValueOnce(new Error('persist failed'));
    await act(async () => {
      currentTimer!.setActiveJapamSelection(JAPAM_A_ID, JAPAM_A_NAME);
      await currentTimer!.start();
    });
    expect(startForegroundService).toHaveBeenCalledTimes(1);
    expect(failedMultiSetSpy).toHaveBeenCalled();
    expect(getTimerState().sessionId).toBe('');
    failedMultiSetSpy.mockRestore();
  });

  it('queues multiple native loops and later saves each exactly once after restart', async () => {
    const sessionId = 'timer-native-3-loops';
    await seedPersistedSession({ sessionId, totalLoops: 3, durationSeconds: 180 });
    mountedTree = await renderTimerProvider();
    await flush();

    const setItemSpy = jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key: string, value: string) => {
      if (key === HISTORY_KEY) throw new Error('history unavailable');
      (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__[key] = value;
    });

    try {
      await act(async () => {
        currentTimer!.setActiveJapamSelection(null, null);
        [1, 2, 3].forEach((loop) => {
          DeviceEventEmitter.emit('japamTimerLoopComplete', {
            sessionId,
            completedLoops: loop,
            isFinal: loop === 3,
            userId: UID,
            durationMs: 180000,
            completedAt: Date.UTC(2026, 6, 29, 5, loop, 0),
          });
        });
        await Promise.resolve();
      });
      await flush();

      expect(await AsyncStorage.getItem(HISTORY_KEY)).toBeNull();
    } finally {
      setItemSpy.mockRestore();
      restoreAsyncStorageMockImplementations();
    }

    await act(async () => {
      mountedTree.unmount();
    });
    mountedTree = null;
    currentTimer = null;

    mountedTree = await renderTimerProvider();
    await waitForCondition(async () => (await readHistory()).length === 3);

    const history = await readHistory();
    expect(history).toHaveLength(3);
    expect(history.map((item: any) => item.completionId).sort()).toEqual([
      makeLoopCompletionId(UID, sessionId, 1),
      makeLoopCompletionId(UID, sessionId, 2),
      makeLoopCompletionId(UID, sessionId, 3),
    ]);
    expect(await readQueue()).toHaveLength(0);
  });

  it('keeps queued old-session completion through reset and new Timer start', async () => {
    const oldSessionId = 'timer-old-session';
    await AsyncStorage.setItem(TIMER_PENDING_COMPLETIONS_KEY, JSON.stringify([{
      version: 1,
      userId: UID,
      sessionId: oldSessionId,
      loopNumber: 1,
      totalLoops: 1,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      durationSeconds: 180,
      completedAt: '2026-07-29T06:59:00.000Z',
      completionId: makeLoopCompletionId(UID, oldSessionId, 1),
    }]));
    mountedTree = await renderTimerProvider();
    await act(async () => {
      currentTimer!.reset();
      currentTimer!.setActiveJapamSelection(JAPAM_B_ID, JAPAM_B_NAME);
      await currentTimer!.start();
    });
    await waitForCondition(async () => (await readQueue()).length === 0 && (await readHistory()).length === 1);

    const newSessionId = getTimerState().sessionId;
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe(oldSessionId);
    expect(await readQueue()).toHaveLength(0);
    const history = await readHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      completionId: makeLoopCompletionId(UID, oldSessionId, 1),
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      date: '2026-07-29T06:59:00.000Z',
    });
    expect(getTimerState().sessionId).toBe(newSessionId);
  });

  it('preserves original completion day across midnight retry', async () => {
    const sessionId = 'timer-cross-midnight';
    await AsyncStorage.setItem(TIMER_PENDING_COMPLETIONS_KEY, JSON.stringify([{
      version: 1,
      userId: UID,
      sessionId,
      loopNumber: 1,
      totalLoops: 1,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      durationSeconds: 180,
      completedAt: '2026-07-29T06:59:59.000Z',
      completionId: makeLoopCompletionId(UID, sessionId, 1),
    }]));
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-29T07:01:00.000Z'));

    mountedTree = await renderTimerProvider();
    await waitForCondition(async () => (await readHistory()).length === 1 && (await readQueue()).length === 0);

    const history = await readHistory();
    expect(history).toHaveLength(1);
    expect(history[0].date).toBe('2026-07-29T06:59:59.000Z');
    (Date.now as jest.Mock).mockRestore();
  });

  it('removes stale queue item when History already contains its completionId', async () => {
    const sessionId = 'timer-crash-window';
    const completionId = makeLoopCompletionId(UID, sessionId, 1);
    const queued = {
      version: 1,
      userId: UID,
      sessionId,
      loopNumber: 1,
      totalLoops: 1,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      durationSeconds: 180,
      completedAt: '2026-07-29T08:00:00.000Z',
      completionId,
    };
    await AsyncStorage.setItem(TIMER_PENDING_COMPLETIONS_KEY, JSON.stringify([queued]));
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([{
      date: queued.completedAt,
      malas: 1,
      totalCount: 108,
      duration: 180,
      manual: false,
      userId: UID,
      completionId,
      syncStatus: 'pending',
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
    }]));

    mountedTree = await renderTimerProvider();
    await waitForCondition(async () => (await readQueue()).length === 0);

    expect(await readHistory()).toHaveLength(1);
    expect(await readQueue()).toHaveLength(0);
  });

  it('keeps queued completion attributed to Japam A when UI current selection is Japam B', async () => {
    const sessionId = 'timer-switch-queued';
    await AsyncStorage.setItem(`currentJapamId:${UID}`, JAPAM_B_ID);
    await AsyncStorage.setItem(TIMER_PENDING_COMPLETIONS_KEY, JSON.stringify([{
      version: 1,
      userId: UID,
      sessionId,
      loopNumber: 1,
      totalLoops: 1,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      durationSeconds: 180,
      completedAt: '2026-07-29T09:00:00.000Z',
      completionId: makeLoopCompletionId(UID, sessionId, 1),
    }]));

    mountedTree = await renderTimerProvider();
    await waitForCondition(async () => (await readHistory()).length === 1 && (await readQueue()).length === 0);

    const history = await readHistory();
    expect(history).toHaveLength(1);
    expect(history[0].japamId).toBe(JAPAM_A_ID);
    expect(history[0].japamName).toBe(JAPAM_A_NAME);
    expect(history[0].japamId).not.toBe(JAPAM_B_ID);
  });

  it('keeps native queued completion attributed to the persisted session Japam after a switch', async () => {
    const sessionId = 'timer-switch-native-event';
    await seedPersistedSession({
      sessionId,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      currentJapamId: JAPAM_B_ID,
      totalLoops: 1,
      durationSeconds: 180,
    });
    mountedTree = await renderTimerProvider();
    await act(async () => {
      currentTimer!.setActiveJapamSelection(JAPAM_B_ID, JAPAM_B_NAME);
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
        durationMs: 180000,
        completedAt: Date.parse('2026-07-29T09:30:00.000Z'),
      });
      await Promise.resolve();
    });

    await waitForCondition(async () => (await readHistory()).length === 1);

    const history = await readHistory();
    expect(history).toHaveLength(1);
    expect(history[0].japamId).toBe(JAPAM_A_ID);
    expect(history[0].japamName).toBe(JAPAM_A_NAME);
    expect(history[0].japamId).not.toBe(JAPAM_B_ID);
  });

  it('updates Home today counters from an offline Timer completion', async () => {
    const sessionId = 'timer-home-local-refresh';
    await seedPersistedSession({ sessionId, totalLoops: 1, durationSeconds: 180 });
    mountedTree = await renderTimerProvider();

    await act(async () => {
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
        durationMs: 180000,
        completedAt: new Date().toISOString(),
      });
      await Promise.resolve();
    });

    await waitForCondition(async () => (await readHistory()).length === 1);

    expect(await AsyncStorage.getItem(`totalCount:${UID}`)).toBe('108');
    expect(await AsyncStorage.getItem(`malas:${UID}`)).toBe('1');
    expect(await AsyncStorage.getItem(`count:${UID}`)).toBe('0');
    expect(await AsyncStorage.getItem(`totalDate:${UID}`)).toBe(
      toLocalDayKey(new Date().toISOString()),
    );
  });

  it('dedupes native and JS duplicate reports for the same session loop', async () => {
    const sessionId = 'timer-duplicate-event';
    await seedPersistedSession({ sessionId, totalLoops: 1, durationSeconds: 180 });
    mountedTree = await renderTimerProvider();
    await flush();

    await act(async () => {
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
        durationMs: 180000,
        completedAt: Date.parse('2026-07-29T10:00:00.000Z'),
      });
      await Promise.resolve();
    });
    await flush();

    const historyAfterNative = await readHistory();
    expect(historyAfterNative).toHaveLength(1);

    await act(async () => {
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
        durationMs: 180000,
        completedAt: Date.parse('2026-07-29T10:00:00.000Z'),
      });
      await Promise.resolve();
    });
    await flush();

    expect(await readHistory()).toHaveLength(1);
  });

  it('persists a terminal snapshot after a background final completion so reopening does not Resume stale time', async () => {
    const sessionId = 'timer-background-final';
    await seedPersistedSession({ sessionId, totalLoops: 1, durationSeconds: 180 });
    mountedTree = await renderTimerProvider();
    await flush();

    await act(async () => {
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
        durationMs: 180000,
        completedAt: Date.parse('2026-07-29T10:30:00.000Z'),
      });
      await Promise.resolve();
    });

    await waitForCondition(async () => (await readHistory()).length === 1);

    expect(currentTimer!.isPaused).toBe(false);
    expect(currentTimer!.isRunning).toBe(false);
    expect(currentTimer!.seconds).toBe(180);
    expect(await AsyncStorage.getItem('timerRunning')).toBe('false');
    expect(await AsyncStorage.getItem('timerPaused')).toBe('false');
    expect(await AsyncStorage.getItem('timerSeconds')).toBe('180');
    expect(await AsyncStorage.getItem('timerStartedAt')).toBeNull();
    expect(getTimerState().sessionId).toBe('');
  });

  it('opens a force-closed running timer as paused Resume with the saved remaining time', async () => {
    const sessionId = 'timer-force-close-running';
    await seedPersistedSession({
      sessionId,
      totalLoops: 1,
      durationSeconds: 180,
      running: 'true',
      seconds: 45,
      paused: 'false',
      startedAt: Date.now() - 45_000,
    });

    mountedTree = await renderTimerProvider();
    await flush();

    expect(currentTimer!.isPaused).toBe(true);
    expect(currentTimer!.isRunning).toBe(false);
    expect(currentTimer!.seconds).toBe(45);
    expect(getTimerState().sessionId).toBe(sessionId);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(JAPAM_A_ID);
    expect(await AsyncStorage.getItem(`timerSessionJapamId:${UID}`)).toBe(JAPAM_A_ID);
    expect(await AsyncStorage.getItem(`timerSessionJapamName:${UID}`)).toBe(JAPAM_A_NAME);
    expect(await AsyncStorage.getItem(`timerCompletedLoops:${UID}:${JAPAM_A_ID}`)).toBe('0');
    expect(await AsyncStorage.getItem(`timerTab_loops:${UID}:${JAPAM_A_ID}`)).toBe('1');
    expect(await AsyncStorage.getItem(`timerSeconds:${UID}:${JAPAM_A_ID}`)).toBe('45');
    expect(await AsyncStorage.getItem(`timerRunning:${UID}:${JAPAM_A_ID}`)).toBe('false');
    expect(await AsyncStorage.getItem(`timerPaused:${UID}:${JAPAM_A_ID}`)).toBe('true');
  });

  it('restores the same paused snapshot after a second remount', async () => {
    const sessionId = 'timer-force-close-remount';
    await seedPersistedSession({
      sessionId,
      totalLoops: 2,
      durationSeconds: 180,
      running: 'true',
      seconds: 45,
      paused: 'false',
      startedAt: Date.now() - 45_000,
    });

    mountedTree = await renderTimerProvider();
    await flush();

    expect(currentTimer!.isPaused).toBe(true);
    expect(currentTimer!.isRunning).toBe(false);
    expect(currentTimer!.seconds).toBe(45);
    expect(await AsyncStorage.getItem('timerRunning')).toBe('false');
    expect(await AsyncStorage.getItem('timerPaused')).toBe('true');

    await act(async () => {
      mountedTree.unmount();
    });
    mountedTree = null;
    currentTimer = null;

    mountedTree = await renderTimerProvider();
    await flush();

    expect(currentTimer!.isPaused).toBe(true);
    expect(currentTimer!.isRunning).toBe(false);
    expect(currentTimer!.seconds).toBe(45);
    expect(getTimerState().sessionId).toBe(sessionId);
    expect(await AsyncStorage.getItem('timerRunning')).toBe('false');
    expect(await AsyncStorage.getItem('timerPaused')).toBe('true');
    expect(await AsyncStorage.getItem('timerSeconds')).toBe('45');
    expect(await AsyncStorage.getItem(`timerSessionJapamId:${UID}`)).toBe(JAPAM_A_ID);
    expect(await AsyncStorage.getItem(`timerSessionJapamName:${UID}`)).toBe(JAPAM_A_NAME);
  });

  it('uses native reconciliation completion timestamps when queueing missed loops', async () => {
    const sessionId = 'timer-native-reconcile';
    await seedPersistedSession({ sessionId, totalLoops: 2, durationSeconds: 180, completedLoops: 0 });
    (getNativeTimerState as jest.Mock).mockResolvedValueOnce({
      sessionId,
      isRunning: false,
      isPaused: false,
      startedAt: Date.now() - 200000,
      pausedElapsedMs: 0,
      durationMs: 180000,
      completedLoops: 2,
      totalLoops: 2,
      userId: UID,
      completionTimes: {
        '1': Date.parse('2026-07-29T11:00:00.000Z'),
        '2': Date.parse('2026-07-29T11:03:00.000Z'),
      },
    });

    mountedTree = await renderTimerProvider();
    await act(async () => {
      mockListeners.get('change')?.forEach((cb) => cb('active'));
      await Promise.resolve();
    });
    await waitForCondition(async () => (await readHistory()).length === 2);

    const history = await readHistory();
    expect(history.map((item: any) => item.date).sort()).toEqual([
      '2026-07-29T11:00:00.000Z',
      '2026-07-29T11:03:00.000Z',
    ]);
  });
});

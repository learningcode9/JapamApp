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
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { DeviceEventEmitter } from 'react-native';
import { TimerProvider, useTimer } from '../timer-context';
import { getTimerState, updateTimerState } from '../../lib/timerState';
/* eslint-enable import/first, @typescript-eslint/no-require-imports */

const UID = 'user-123';
const JAPAM_A_ID = 'japam-a';
const JAPAM_A_NAME = 'Japam A';
const JAPAM_B_ID = 'japam-b';
const JAPAM_B_NAME = 'Japam B';
const HISTORY_KEY = 'history';
const PENDING_LOOP_KEY = 'timerPendingCompletionLoop';
const SESSION_ID_KEY = 'timerSessionId';
const SESSION_JAPAM_ID_KEY = 'timerSessionJapamId';
const SESSION_JAPAM_NAME_KEY = 'timerSessionJapamName';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

describe('TimerProvider restored/native final-loop retry', () => {
  let mountedTree: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockListeners.clear();
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
  });

  it('persists session Japam identity and recovers a retryable native final loop after remount', async () => {
    mountedTree = await renderTimerProvider();
    expect(currentTimer).not.toBeNull();

    await act(async () => {
      currentTimer!.setActiveJapamSelection(JAPAM_A_ID, JAPAM_A_NAME);
      await currentTimer!.start();
    });
    await flush();

    const sessionId = getTimerState().sessionId;
    expect(sessionId).toBeTruthy();
    expect(await AsyncStorage.getItem(`${SESSION_JAPAM_ID_KEY}:${UID}:${JAPAM_A_ID}`)).toBe(JAPAM_A_ID);
    expect(await AsyncStorage.getItem(`${SESSION_JAPAM_NAME_KEY}:${UID}:${JAPAM_A_ID}`)).toBe(JAPAM_A_NAME);
    await AsyncStorage.multiRemove([
      SESSION_JAPAM_ID_KEY,
      `${SESSION_JAPAM_ID_KEY}:${UID}`,
      `${SESSION_JAPAM_ID_KEY}:${UID}:${JAPAM_A_ID}`,
      SESSION_JAPAM_NAME_KEY,
      `${SESSION_JAPAM_NAME_KEY}:${UID}`,
      `${SESSION_JAPAM_NAME_KEY}:${UID}:${JAPAM_A_ID}`,
    ]);

    await act(async () => {
      currentTimer!.setActiveJapamSelection(null, null);
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
      });
      await Promise.resolve();
    });
    await flush();

    expect(await AsyncStorage.getItem(HISTORY_KEY)).toBeNull();
    expect(getTimerState().lastSavedCompletedLoops).toBe(0);
    expect(await AsyncStorage.getItem(`${SESSION_ID_KEY}:${UID}:${JAPAM_A_ID}`)).toBe(sessionId);
    expect(await AsyncStorage.getItem(`${PENDING_LOOP_KEY}:${UID}:${JAPAM_A_ID}`)).toBe('1');

    await act(async () => {
      mountedTree.unmount();
    });
    mountedTree = null;
    currentTimer = null;

    await AsyncStorage.multiSet([
      [SESSION_JAPAM_ID_KEY, JAPAM_A_ID],
      [`${SESSION_JAPAM_ID_KEY}:${UID}`, JAPAM_A_ID],
      [`${SESSION_JAPAM_ID_KEY}:${UID}:${JAPAM_A_ID}`, JAPAM_A_ID],
      [SESSION_JAPAM_NAME_KEY, JAPAM_A_NAME],
      [`${SESSION_JAPAM_NAME_KEY}:${UID}`, JAPAM_A_NAME],
      [`${SESSION_JAPAM_NAME_KEY}:${UID}:${JAPAM_A_ID}`, JAPAM_A_NAME],
    ]);
    mountedTree = await renderTimerProvider();
    await flush();
    await flush();

    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const history = JSON.parse(rawHistory || '[]');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      userId: UID,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      totalCount: 108,
      completionId: `${UID}:${sessionId}:loop-1`,
    });
    expect(await AsyncStorage.getItem(`${PENDING_LOOP_KEY}:${UID}:${JAPAM_A_ID}`)).toBeNull();
    expect(getTimerState().sessionId).toBe('');

    await act(async () => {
      DeviceEventEmitter.emit('japamTimerLoopComplete', {
        sessionId,
        completedLoops: 1,
        isFinal: true,
        userId: UID,
      });
      await Promise.resolve();
    });
    await flush();

    const afterRepeat = JSON.parse(await AsyncStorage.getItem(HISTORY_KEY) || '[]');
    expect(afterRepeat).toHaveLength(1);
    expect(await AsyncStorage.getItem(PENDING_LOOP_KEY)).toBeNull();
  });

  it('restores a completed session under its captured Japam even when current selection changed', async () => {
    const sessionId = `${UID}:stored-session`;
    await AsyncStorage.multiSet([
      [`currentJapamId:${UID}`, JAPAM_B_ID],
      [SESSION_ID_KEY, sessionId],
      [`${SESSION_ID_KEY}:${UID}`, sessionId],
      [`${SESSION_ID_KEY}:${UID}:${JAPAM_A_ID}`, sessionId],
      [SESSION_JAPAM_ID_KEY, JAPAM_A_ID],
      [`${SESSION_JAPAM_ID_KEY}:${UID}`, JAPAM_A_ID],
      [`${SESSION_JAPAM_ID_KEY}:${UID}:${JAPAM_A_ID}`, JAPAM_A_ID],
      [SESSION_JAPAM_NAME_KEY, JAPAM_A_NAME],
      [`${SESSION_JAPAM_NAME_KEY}:${UID}`, JAPAM_A_NAME],
      [`${SESSION_JAPAM_NAME_KEY}:${UID}:${JAPAM_A_ID}`, JAPAM_A_NAME],
      [PENDING_LOOP_KEY, '1'],
      [`${PENDING_LOOP_KEY}:${UID}`, '1'],
      [`${PENDING_LOOP_KEY}:${UID}:${JAPAM_A_ID}`, '1'],
      ['timerCompletedLoops', '1'],
      [`timerCompletedLoops:${UID}`, '1'],
      [`timerCompletedLoops:${UID}:${JAPAM_A_ID}`, '1'],
      ['timerRunning', 'false'],
      [`timerRunning:${UID}`, 'false'],
      [`timerRunning:${UID}:${JAPAM_A_ID}`, 'false'],
      ['timerTarget', '180'],
      [`timerTarget:${UID}`, '180'],
      [`timerTarget:${UID}:${JAPAM_A_ID}`, '180'],
      ['timerTab_duration', '3'],
      [`timerTab_duration:${UID}`, '3'],
      [`timerTab_duration:${UID}:${JAPAM_A_ID}`, '3'],
      ['timerTab_loops', '1'],
      [`timerTab_loops:${UID}`, '1'],
      [`timerTab_loops:${UID}:${JAPAM_A_ID}`, '1'],
    ]);

    mountedTree = await renderTimerProvider();
    await flush();
    await flush();

    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const history = JSON.parse(rawHistory || '[]');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      userId: UID,
      japamId: JAPAM_A_ID,
      japamName: JAPAM_A_NAME,
      completionId: `${UID}:${sessionId}:loop-1`,
    });
    expect(history[0].japamId).not.toBe(JAPAM_B_ID);
    expect(await AsyncStorage.getItem(`${PENDING_LOOP_KEY}:${UID}:${JAPAM_A_ID}`)).toBeNull();
  });
});

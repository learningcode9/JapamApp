jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildSelectionPairs,
  saveJapamTimerState,
  readJapamTimerState,
  getJapamKey,
  getUserKey,
  type TimerStateSnapshot,
  type RawJapamTimerState,
} from '../perJapamTimerState';

const UID = 'test-user-123';
const JAPAM_A = 'japam-a-1111';
const JAPAM_B = 'japam-b-2222';

const T_DURATION_KEY = 'timerTab_duration';
const T_LOOPS_KEY = 'timerTab_loops';

function snapshot(overrides: Partial<TimerStateSnapshot> = {}): TimerStateSnapshot {
  return {
    seconds: 0, running: false, target: 300, paused: false,
    completedLoops: 0, startedAt: '', sessionId: '',
    duration: 5, loops: 1,
    ...overrides,
  };
}

describe('buildSelectionPairs (Issue 2 key-write helper)', () => {
  it('writes bare key only for guest (no uid)', () => {
    const pairs = buildSelectionPairs(T_DURATION_KEY, '10', null, null);
    expect(pairs).toEqual([[T_DURATION_KEY, '10']]);
  });

  it('writes bare + uid when user signed in without Japam', () => {
    const pairs = buildSelectionPairs(T_LOOPS_KEY, '3', UID, null);
    expect(pairs).toEqual([
      [T_LOOPS_KEY, '3'],
      [getUserKey(T_LOOPS_KEY, UID), '3'],
    ]);
  });

  it('writes bare + uid + per-Japam when user signed in with Japam', () => {
    const pairs = buildSelectionPairs(T_DURATION_KEY, '15', UID, JAPAM_A);
    expect(pairs).toEqual([
      [T_DURATION_KEY, '15'],
      [getUserKey(T_DURATION_KEY, UID), '15'],
      [getJapamKey(T_DURATION_KEY, UID, JAPAM_A), '15'],
    ]);
  });

  it('skips per-Japam key when japamId is null', () => {
    const pairs = buildSelectionPairs(T_LOOPS_KEY, '5', UID, null);
    expect(pairs).toHaveLength(2);
    expect(pairs[0][0]).toBe(T_LOOPS_KEY);
    expect(pairs[1][0]).toBe(getUserKey(T_LOOPS_KEY, UID));
  });
});

describe('per-Japam duration and loop isolation', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('duration stored per-Japam: A and B have independent durations', async () => {
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ duration: 5 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ duration: 10 }));

    const a = await readJapamTimerState(UID, JAPAM_A);
    const b = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(a.duration)).toBe(5);
    expect(Number(b.duration)).toBe(10);
  });

  it('loops stored per-Japam: A and B have independent loops', async () => {
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ loops: 1 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ loops: 5 }));

    const a = await readJapamTimerState(UID, JAPAM_A);
    const b = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(a.loops)).toBe(1);
    expect(Number(b.loops)).toBe(5);
  });

  it('Japam B duration unchanged when Japam A updates', async () => {
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ duration: 5 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ duration: 10 }));
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ duration: 15 }));

    const b = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(b.duration)).toBe(10);
  });

  it('Japam B loops unchanged when Japam A updates', async () => {
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ loops: 1 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ loops: 3 }));
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ loops: 5 }));

    const b = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(b.loops)).toBe(3);
  });

  it('rapid A→B→A preserves duration, loops, seconds, and paused independently', async () => {
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ seconds: 120, paused: true, duration: 5, loops: 1 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ seconds: 45, paused: true, duration: 10, loops: 3 }));
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ seconds: 90, paused: true, duration: 5, loops: 2 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ seconds: 30, paused: true, duration: 10, loops: 3 }));
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ seconds: 60, paused: true, duration: 5, loops: 2 }));

    const a = await readJapamTimerState(UID, JAPAM_A);
    const b = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(a.seconds)).toBe(60);
    expect(Number(a.duration)).toBe(5);
    expect(Number(a.loops)).toBe(2);
    expect(Number(b.seconds)).toBe(30);
    expect(Number(b.duration)).toBe(10);
    expect(Number(b.loops)).toBe(3);
    expect(Number(a.seconds)).not.toBe(Number(b.seconds));
    expect(Number(a.duration)).not.toBe(Number(b.duration));
    expect(Number(a.loops)).not.toBe(Number(b.loops));
  });

  it('rapid A→B→A running/paused state is not leaked between Japams', async () => {
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ seconds: 100, running: true, paused: false }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ seconds: 50, running: false, paused: true }));
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ seconds: 110, running: false, paused: true }));

    const a = await readJapamTimerState(UID, JAPAM_A);
    const b = await readJapamTimerState(UID, JAPAM_B);
    expect(a.running).toBe('false');
    expect(a.paused).toBe('true');
    expect(Number(a.seconds)).toBe(110);
    expect(b.running).toBe('false');
    expect(b.paused).toBe('true');
    expect(Number(b.seconds)).toBe(50);
  });
});

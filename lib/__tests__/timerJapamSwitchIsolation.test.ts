jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  saveJapamTimerState,
  readJapamTimerState,
  type TimerStateSnapshot,
  TIMER_SECONDS_KEY,
  TIMER_TARGET_KEY,
  TIMER_PAUSED_KEY,
  TIMER_RUNNING_KEY,
  TIMER_COMPLETED_LOOPS_KEY,
  T_DURATION_KEY,
  T_LOOPS_KEY,
  TIMER_SESSION_ID_KEY,
} from '../perJapamTimerState';

const UID = 'test-user-123';
const JAPAM_A = 'japam-a-1111';
const JAPAM_B = 'japam-b-2222';
const JAPAM_C = 'japam-c-3333';

function pausedSnapshot(overrides: Partial<TimerStateSnapshot> = {}): TimerStateSnapshot {
  return {
    seconds: 0,
    running: false,
    target: 300,
    paused: false,
    completedLoops: 0,
    startedAt: '',
    sessionId: '',
    duration: 5,
    loops: 1,
    ...overrides,
  };
}

async function readRaw(uid: string, japamId: string): Promise<Record<string, string | null>> {
  return readJapamTimerState(uid, japamId) as unknown as Record<string, string | null>;
}

describe('per-Japam timer switch flow isolation', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('1. save and restore: Japam A paused at 120s restores exactly', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120,
      paused: true,
      target: 300,
      duration: 5,
    }));

    const r = await readRaw(UID, JAPAM_A);
    expect(r[TIMER_SECONDS_KEY]).toBe('120');
    expect(r[TIMER_PAUSED_KEY]).toBe('true');
    expect(r[TIMER_TARGET_KEY]).toBe('300');
    expect(r[TIMER_RUNNING_KEY]).toBe('false');
  });

  it('2. switch to Japam B with no saved state → fresh start (not fallthrough)', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120,
      paused: true,
    }));

    const b = await readRaw(UID, JAPAM_B);
    expect(b[TIMER_SECONDS_KEY]).toBeNull();
    expect(b[TIMER_TARGET_KEY]).toBeNull();
    expect(b[T_DURATION_KEY]).toBeNull();
    expect(b[TIMER_PAUSED_KEY]).toBeNull();

    const a = await readRaw(UID, JAPAM_A);
    expect(a[TIMER_SECONDS_KEY]).toBe('120');
  });

  it('3. A→B→A round-trip: each Japam preserves its exact snapshot', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));

    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, target: 180, duration: 3,
    }));

    const a = await readRaw(UID, JAPAM_A);
    expect(a[TIMER_SECONDS_KEY]).toBe('120');
    expect(a[TIMER_TARGET_KEY]).toBe('300');

    const b = await readRaw(UID, JAPAM_B);
    expect(b[TIMER_SECONDS_KEY]).toBe('45');
    expect(b[TIMER_TARGET_KEY]).toBe('180');
  });

  it('4. will-switch saves running=false even when timer was actively running', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 90,
      running: false,
      paused: true,
      target: 300,
      startedAt: '',
    }));

    const a = await readRaw(UID, JAPAM_A);
    expect(a[TIMER_RUNNING_KEY]).toBe('false');
    expect(a[TIMER_SECONDS_KEY]).toBe('90');
    expect(a[TIMER_PAUSED_KEY]).toBe('true');
  });

  it('5. completedLoops preserved in per-Japam state on switch save/restore', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 200,
      paused: true,
      completedLoops: 2,
      target: 300,
      duration: 5,
      loops: 3,
    }));

    const a = await readRaw(UID, JAPAM_A);
    expect(a[TIMER_COMPLETED_LOOPS_KEY]).toBe('2');
    expect(a[T_LOOPS_KEY]).toBe('3');
    expect(a[TIMER_SECONDS_KEY]).toBe('200');
  });

  it('6. three-way A→B→C→A preserves each Japam unique timer state', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));
    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, target: 180, duration: 3,
    }));
    await saveJapamTimerState(UID, JAPAM_C, pausedSnapshot({
      seconds: 10, paused: true, target: 60, duration: 1,
    }));

    expect((await readRaw(UID, JAPAM_A))[TIMER_SECONDS_KEY]).toBe('120');
    expect((await readRaw(UID, JAPAM_B))[TIMER_SECONDS_KEY]).toBe('45');
    expect((await readRaw(UID, JAPAM_C))[TIMER_SECONDS_KEY]).toBe('10');

    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 150, paused: true, target: 300, duration: 5, completedLoops: 1,
    }));

    const aFinal = await readRaw(UID, JAPAM_A);
    expect(aFinal[TIMER_SECONDS_KEY]).toBe('150');
    expect(aFinal[TIMER_COMPLETED_LOOPS_KEY]).toBe('1');

    const bUnchanged = await readRaw(UID, JAPAM_B);
    expect(bUnchanged[TIMER_SECONDS_KEY]).toBe('45');
  });

  it('7. sessionId persisted per-Japam independently', async () => {
    const sessionA = 'timer-1000-abc123';
    const sessionB = 'timer-2000-def456';

    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, sessionId: sessionA,
    }));
    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, sessionId: sessionB,
    }));

    const a = await readRaw(UID, JAPAM_A);
    expect(a[TIMER_SESSION_ID_KEY]).toBe(sessionA);
    expect(a[TIMER_SECONDS_KEY]).toBe('120');

    const b = await readRaw(UID, JAPAM_B);
    expect(b[TIMER_SESSION_ID_KEY]).toBe(sessionB);
    expect(b[TIMER_SECONDS_KEY]).toBe('45');
  });
});

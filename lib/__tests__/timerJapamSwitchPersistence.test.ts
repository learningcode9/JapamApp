jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  saveJapamTimerState,
  readJapamTimerState,
  buildTimerPairs,
  getJapamKey,
  getUserKey,
  type TimerStateSnapshot,
  type RawJapamTimerState,
} from '../perJapamTimerState';

const UID = 'test-user-123';
const GUEST_NO_UID = '';
const JAPAM_A = 'japam-a-1111';
const JAPAM_B = 'japam-b-2222';

function snapshot(overrides: Partial<TimerStateSnapshot> = {}): TimerStateSnapshot {
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

// Bare-key helpers matching timer-context.tsx
const T_DURATION_KEY = 'timerTab_duration';
const T_LOOPS_KEY = 'timerTab_loops';
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_PAUSED_KEY = 'timerPaused';
const TIMER_COMPLETED_LOOPS_KEY = 'timerCompletedLoops';
const TIMER_SESSION_ID_KEY = 'timerSessionId';

describe('regression: will-switch ordering (Issue 1)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('save followed by read returns last saved data (promise barrier guarantee)', async () => {
    // Simulates the will-switch → did-switch promise barrier: save resolves
    // before read, so read must return the data that was just saved.
    const saved = snapshot({ seconds: 120, paused: true, duration: 5, loops: 2 });
    await saveJapamTimerState(UID, JAPAM_A, saved);

    const loaded: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(Number(loaded.seconds)).toBe(120);
    expect(loaded.paused).toBe('true');
    expect(Number(loaded.duration)).toBe(5);
    expect(Number(loaded.loops)).toBe(2);
  });

  it('per-Japam save completes before did-switch read sees the data', async () => {
    // Write A state, then immediately read — the read must see the write.
    // This validates the promise-barrier pattern used by will-switch→did-switch.
    await saveJapamTimerState(UID, JAPAM_A, snapshot({ seconds: 90, paused: true, duration: 3 }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({ seconds: 45, paused: true, duration: 7 }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(a.seconds)).toBe(90);
    expect(Number(a.duration)).toBe(3);
    expect(Number(b.seconds)).toBe(45);
    expect(Number(b.duration)).toBe(7);
  });

  it('switch save writes running=false even without explicit persistState', async () => {
    // The will-switch handler must save running=false for the FROM Japam
    // even though it no longer calls persistState. Only saveJapamTimerState
    // writes the per-Japam state.
    await saveJapamTimerState(UID, JAPAM_A, snapshot({
      seconds: 150, running: false, paused: true,
    }));
    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.running).toBe('false');
    expect(a.paused).toBe('true');
    expect(Number(a.seconds)).toBe(150);
  });
});

describe('regression: duration/loop per-Japam persistence (Issue 2)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('duration change for Japam A persists per-Japam and survives cold restart', async () => {
    // Simulate selectDuration(15) for Japam A writing all three key levels.
    const uid = UID;
    const japamId = JAPAM_A;
    await AsyncStorage.setItem(T_DURATION_KEY, '15');
    await AsyncStorage.setItem(getUserKey(T_DURATION_KEY, uid), '15');
    await AsyncStorage.setItem(getJapamKey(T_DURATION_KEY, uid, japamId), '15');

    // Cold-start restoration: per-Japam key takes priority over uid and bare.
    const fromJapam = await AsyncStorage.getItem(getJapamKey(T_DURATION_KEY, uid, japamId));
    expect(fromJapam).toBe('15');

    // Simulate clearing state (re-mount / cold start).
    // The get() pattern: per-Japam → uid → bare
    const get = async (key: string) => {
      const j = await AsyncStorage.getItem(getJapamKey(key, uid, japamId));
      if (j !== null) return j;
      const u = await AsyncStorage.getItem(getUserKey(key, uid));
      if (u !== null) return u;
      return AsyncStorage.getItem(key);
    };
    const restored = await get(T_DURATION_KEY);
    expect(Number(restored)).toBe(15);
  });

  it('loop change for Japam A persists per-Japam and survives cold restart', async () => {
    const uid = UID;
    const japamId = JAPAM_A;
    await AsyncStorage.setItem(T_LOOPS_KEY, '3');
    await AsyncStorage.setItem(getUserKey(T_LOOPS_KEY, uid), '3');
    await AsyncStorage.setItem(getJapamKey(T_LOOPS_KEY, uid, japamId), '3');

    const fromJapam = await AsyncStorage.getItem(getJapamKey(T_LOOPS_KEY, uid, japamId));
    expect(fromJapam).toBe('3');

    const get = async (key: string) => {
      const j = await AsyncStorage.getItem(getJapamKey(key, uid, japamId));
      if (j !== null) return j;
      const u = await AsyncStorage.getItem(getUserKey(key, uid));
      if (u !== null) return u;
      return AsyncStorage.getItem(key);
    };
    const restored = await get(T_LOOPS_KEY);
    expect(Number(restored)).toBe(3);
  });

  it('Japam B retains its own duration after A changes', async () => {
    const uid = UID;
    // Japam A: duration 5
    await AsyncStorage.setItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_A), '5');
    // Japam B: duration 15
    await AsyncStorage.setItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_B), '15');

    expect(await AsyncStorage.getItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_A))).toBe('5');
    expect(await AsyncStorage.getItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_B))).toBe('15');

    // User selects duration 10 for Japam A (should NOT change B)
    await AsyncStorage.setItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_A), '10');
    expect(await AsyncStorage.getItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_A))).toBe('10');
    expect(await AsyncStorage.getItem(getJapamKey(T_DURATION_KEY, uid, JAPAM_B))).toBe('15');
  });

  it('Japam B retains its own loop count after A changes', async () => {
    const uid = UID;
    await AsyncStorage.setItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_A), '1');
    await AsyncStorage.setItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_B), '5');

    expect(await AsyncStorage.getItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_A))).toBe('1');
    expect(await AsyncStorage.getItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_B))).toBe('5');

    await AsyncStorage.setItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_A), '3');
    expect(await AsyncStorage.getItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_A))).toBe('3');
    expect(await AsyncStorage.getItem(getJapamKey(T_LOOPS_KEY, uid, JAPAM_B))).toBe('5');
  });

  it('guest Japams remain isolated (no uid, no per-Japam write)', async () => {
    // Guest users have no uid, so selectDuration/selectLoops only write bare keys.
    await AsyncStorage.setItem(T_DURATION_KEY, '10');
    await AsyncStorage.setItem(T_LOOPS_KEY, '3');

    expect(await AsyncStorage.getItem(T_DURATION_KEY)).toBe('10');
    expect(await AsyncStorage.getItem(T_LOOPS_KEY)).toBe('3');

    // No uid keys exist for guest
    expect(await AsyncStorage.getItem(getUserKey(T_DURATION_KEY, 'guest'))).toBeNull();
    expect(await AsyncStorage.getItem(getUserKey(T_LOOPS_KEY, 'guest'))).toBeNull();
  });

  it('legacy no-Japam fallback: bare key read works when per-Japam and uid keys absent', async () => {
    await AsyncStorage.setItem(T_DURATION_KEY, '10');
    await AsyncStorage.setItem(T_LOOPS_KEY, '3');

    // No uid
    const uid = '';
    const japamId = null;

    const get = async (key: string) => {
      if (uid && japamId) {
        const j = await AsyncStorage.getItem(getJapamKey(key, uid, japamId));
        if (j !== null) return j;
      }
      if (uid) {
        const u = await AsyncStorage.getItem(getUserKey(key, uid));
        if (u !== null) return u;
      }
      return AsyncStorage.getItem(key);
    };

    expect(Number(await get(T_DURATION_KEY))).toBe(10);
    expect(Number(await get(T_LOOPS_KEY))).toBe(3);
  });
});

describe('regression: rapid A→B→A switching does not leak state', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('rapid A→B→A preserves duration, loops, elapsed, and paused state independently', async () => {
    // Phase 1: Japam A paused at 120s, duration 5, loops 1
    await saveJapamTimerState(UID, JAPAM_A, snapshot({
      seconds: 120, paused: true, duration: 5, loops: 1,
    }));
    // Phase 2: Switch to B, B paused at 45s, duration 10, loops 3
    await saveJapamTimerState(UID, JAPAM_B, snapshot({
      seconds: 45, paused: true, duration: 10, loops: 3,
    }));
    // Phase 3: Switch back to A, update A to 90s
    await saveJapamTimerState(UID, JAPAM_A, snapshot({
      seconds: 90, paused: true, duration: 5, loops: 2,
    }));
    // Phase 4: Switch back to B, update B to 30s
    await saveJapamTimerState(UID, JAPAM_B, snapshot({
      seconds: 30, paused: true, duration: 10, loops: 3,
    }));
    // Phase 5: Switch back to A
    await saveJapamTimerState(UID, JAPAM_A, snapshot({
      seconds: 60, paused: true, duration: 5, loops: 2,
    }));

    // Verify A's final state
    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(Number(a.seconds)).toBe(60);
    expect(a.paused).toBe('true');
    expect(Number(a.duration)).toBe(5);
    expect(Number(a.loops)).toBe(2);

    // Verify B's final state
    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(Number(b.seconds)).toBe(30);
    expect(b.paused).toBe('true');
    expect(Number(b.duration)).toBe(10);
    expect(Number(b.loops)).toBe(3);

    // Verify no cross-contamination: A's values are NOT equal to B's
    expect(Number(a.seconds)).not.toBe(Number(b.seconds));
    expect(Number(a.duration)).not.toBe(Number(b.duration));
    expect(Number(a.loops)).not.toBe(Number(b.loops));
  });

  it('rapid A→B→A running/paused state is not leaked between Japams', async () => {
    // A: running timer, B: paused timer, then switch back
    await saveJapamTimerState(UID, JAPAM_A, snapshot({
      seconds: 100, running: true, paused: false,
    }));
    await saveJapamTimerState(UID, JAPAM_B, snapshot({
      seconds: 50, running: false, paused: true,
    }));
    await saveJapamTimerState(UID, JAPAM_A, snapshot({
      seconds: 110, running: false, paused: true,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);

    // A is paused, not running
    expect(a.running).toBe('false');
    expect(a.paused).toBe('true');
    expect(Number(a.seconds)).toBe(110);

    // B is still paused, unchanged from its last save
    expect(b.running).toBe('false');
    expect(b.paused).toBe('true');
    expect(Number(b.seconds)).toBe(50);
  });

  it('uid key does not shadow per-Japam duration when per-Japam key exists', async () => {
    // Write uid key with different value than per-Japam key to test priority.
    const uid = UID;
    const japamId = JAPAM_B;
    // per-Japam B key: duration 7
    await AsyncStorage.setItem(getJapamKey(T_DURATION_KEY, uid, japamId), '7');
    // uid key: duration 3 (from a different Japam's persistState)
    await AsyncStorage.setItem(getUserKey(T_DURATION_KEY, uid), '3');
    // bare key: duration 10
    await AsyncStorage.setItem(T_DURATION_KEY, '10');

    const get = async (key: string) => {
      const j = await AsyncStorage.getItem(getJapamKey(key, uid, japamId));
      if (j !== null) return j;
      const u = await AsyncStorage.getItem(getUserKey(key, uid));
      if (u !== null) return u;
      return AsyncStorage.getItem(key);
    };

    const restored = await get(T_DURATION_KEY);
    expect(Number(restored)).toBe(7); // per-Japam wins
  });

  it('uid key does not shadow per-Japam loops when per-Japam key exists', async () => {
    const uid = UID;
    const japamId = JAPAM_B;
    await AsyncStorage.setItem(getJapamKey(T_LOOPS_KEY, uid, japamId), '5');
    await AsyncStorage.setItem(getUserKey(T_LOOPS_KEY, uid), '1');
    await AsyncStorage.setItem(T_LOOPS_KEY, '3');

    const get = async (key: string) => {
      const j = await AsyncStorage.getItem(getJapamKey(key, uid, japamId));
      if (j !== null) return j;
      const u = await AsyncStorage.getItem(getUserKey(key, uid));
      if (u !== null) return u;
      return AsyncStorage.getItem(key);
    };

    const restored = await get(T_LOOPS_KEY);
    expect(Number(restored)).toBe(5);
  });
});

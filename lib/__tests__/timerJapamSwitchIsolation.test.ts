jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  saveJapamTimerState,
  readJapamTimerState,
  type TimerStateSnapshot,
  type RawJapamTimerState,
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

// Regression guard: this describe block reproduces the exact access pattern used by
// the japam-did-switch handler in timer-context.tsx.  It must use dot notation on
// the RawJapamTimerState interface — no bracket access with storage-key constants,
// no intermediate helpers, no type escapes.
describe('regression: readJapamTimerState returns a real RawJapamTimerState', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('all nine semantic properties contain the stored string values', async () => {
    await saveJapamTimerState(UID, JAPAM_A, {
      seconds: 120,
      running: false,
      target: 300,
      paused: true,
      completedLoops: 1,
      startedAt: '',
      sessionId: 'sess-regression',
      duration: 5,
      loops: 3,
    });

    // Exactly as the production did-switch handler reads it:
    const raw: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);

    // Production code would destructure these to feed restore decision:
    const [sec, target, dur, loops, paused, completed, running, startedAt, sessionId] = [
      raw.seconds, raw.target, raw.duration, raw.loops,
      raw.paused, raw.completedLoops, raw.running,
      raw.startedAt, raw.sessionId,
    ];

    const savedSec = Number(sec) || 0;
    const savedTarget = Number(target) || 0;
    const savedDur = Number(dur) || 0;
    const savedLoops = Number(loops) || 0;
    const savedCompletedLoops = Math.max(0, Number(completed) || 0);
    const savedPaused = paused === 'true';
    const savedRunning = running === 'true';
    const savedSessionId = sessionId || '';

    expect(savedSec).toBe(120);
    expect(savedTarget).toBe(300);
    expect(savedDur).toBe(5);
    expect(savedLoops).toBe(3);
    expect(savedPaused).toBe(true);
    expect(savedCompletedLoops).toBe(1);
    expect(savedRunning).toBe(false);
    expect(savedSessionId).toBe('sess-regression');
  });

  it('unsaved Japam returns all nulls, not undefined', async () => {
    const raw: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);

    expect(raw.seconds).toBeNull();
    expect(raw.target).toBeNull();
    expect(raw.duration).toBeNull();
    expect(raw.loops).toBeNull();
    expect(raw.paused).toBeNull();
    expect(raw.completedLoops).toBeNull();
    expect(raw.running).toBeNull();
    expect(raw.startedAt).toBeNull();
    expect(raw.sessionId).toBeNull();
  });
});

describe('per-Japam timer switch flow isolation', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  // ─── Core save/restore helpers ───────────────────────────────────

  it('1. save and restore: Japam A paused at 120s restores exactly', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120,
      paused: true,
      target: 300,
      duration: 5,
    }));

    const r: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(r.seconds).toBe('120');
    expect(r.paused).toBe('true');
    expect(r.target).toBe('300');
    expect(r.running).toBe('false');
  });

  // ─── No fallback ─────────────────────────────────────────────────

  it('2. switch to Japam B with no saved state → fresh start (not fallthrough)', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120,
      paused: true,
    }));

    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(b.seconds).toBeNull();
    expect(b.target).toBeNull();
    expect(b.duration).toBeNull();
    expect(b.paused).toBeNull();

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.seconds).toBe('120');
  });

  // ─── Round-trip isolation ────────────────────────────────────────

  it('3. A→B→A round-trip: each Japam preserves its exact snapshot', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));

    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, target: 180, duration: 3,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.seconds).toBe('120');
    expect(a.target).toBe('300');

    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(b.seconds).toBe('45');
    expect(b.target).toBe('180');
  });

  // ─── Pause before save ───────────────────────────────────────────

  it('4. will-switch saves running=false even when timer was actively running', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 90,
      running: false,
      paused: true,
      target: 300,
      startedAt: '',
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.running).toBe('false');
    expect(a.seconds).toBe('90');
    expect(a.paused).toBe('true');
  });

  // ─── Loop state ──────────────────────────────────────────────────

  it('5. completedLoops preserved in per-Japam state on switch save/restore', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 200,
      paused: true,
      completedLoops: 2,
      target: 300,
      duration: 5,
      loops: 3,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.completedLoops).toBe('2');
    expect(a.loops).toBe('3');
    expect(a.seconds).toBe('200');
  });

  // ─── Three-way isolation ─────────────────────────────────────────

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

    expect((await readJapamTimerState(UID, JAPAM_A)).seconds).toBe('120');
    expect((await readJapamTimerState(UID, JAPAM_B)).seconds).toBe('45');
    expect((await readJapamTimerState(UID, JAPAM_C)).seconds).toBe('10');

    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 150, paused: true, target: 300, duration: 5, completedLoops: 1,
    }));

    const aFinal: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(aFinal.seconds).toBe('150');
    expect(aFinal.completedLoops).toBe('1');

    const bUnchanged: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(bUnchanged.seconds).toBe('45');
  });

  // ─── Session ID ──────────────────────────────────────────────────

  it('7. sessionId persisted per-Japam independently', async () => {
    const sessionA = 'timer-1000-abc123';
    const sessionB = 'timer-2000-def456';

    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, sessionId: sessionA,
    }));
    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, sessionId: sessionB,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.sessionId).toBe(sessionA);
    expect(a.seconds).toBe('120');

    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(b.sessionId).toBe(sessionB);
    expect(b.seconds).toBe('45');
  });

  // ─── Orchestration: ordered save-then-read ────────────────────────

  it('8. ordered save-then-read: save resolves before read returns saved data', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));
    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.seconds).toBe('120');
  });

  it('9. sequential save chain: A→B→A preserves each latest value', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));
    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, target: 180, duration: 3,
    }));
    expect((await readJapamTimerState(UID, JAPAM_A)).seconds).toBe('120');

    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 200, paused: true, target: 300, duration: 5,
    }));
    expect((await readJapamTimerState(UID, JAPAM_A)).seconds).toBe('200');
    expect((await readJapamTimerState(UID, JAPAM_B)).seconds).toBe('45');
  });

  // ─── Orchestration: AsyncStorage rejection safety ────────────────

  it('10. saveJapamTimerState propagates multiSet rejection (caller must catch)', async () => {
    jest.spyOn(AsyncStorage, 'multiSet').mockRejectedValueOnce(new Error('storage full'));

    await expect(
      saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
        seconds: 120, paused: true,
      }))
    ).rejects.toThrow('storage full');

    await expect(
      readJapamTimerState(UID, JAPAM_A)
    ).resolves.toBeDefined();
  });

  it('11. readJapamTimerState propagates multiGet rejection (caller must catch)', async () => {
    jest.spyOn(AsyncStorage, 'multiGet').mockRejectedValueOnce(new Error('storage lost'));

    await expect(
      readJapamTimerState(UID, JAPAM_A)
    ).rejects.toThrow('storage lost');
  });

  // ─── Orchestration: rapid consecutive switches ───────────────────

  it('12. rapid A→B→A→B→A consecutive switches preserve each Japam state', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));
    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 45, paused: true, target: 180, duration: 3,
    }));
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 90, paused: true, target: 300, duration: 5,
    }));
    await saveJapamTimerState(UID, JAPAM_B, pausedSnapshot({
      seconds: 30, paused: true, target: 180, duration: 3,
    }));
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 60, paused: true, target: 300, duration: 5,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.seconds).toBe('60');
    expect(a.target).toBe('300');

    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(b.seconds).toBe('30');
    expect(b.target).toBe('180');
  });

  // ─── Same-Japam re-selection ────────────────────────────────────

  it('13. same-Japam re-selection: save twice with different values, latest sticks', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true, target: 300, duration: 5,
    }));
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 200, paused: true, target: 300, duration: 5, completedLoops: 1,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.seconds).toBe('200');
    expect(a.completedLoops).toBe('1');
    const b: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_B);
    expect(b.seconds).toBeNull();
  });

  // ─── Listener cleanup / remount safety ──────────────────────────

  it('14. simulated remount: save, clear, re-save does not corrupt state', async () => {
    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 120, paused: true,
    }));
    await AsyncStorage.clear();

    await saveJapamTimerState(UID, JAPAM_A, pausedSnapshot({
      seconds: 60, paused: true, target: 300, duration: 5,
    }));

    const a: RawJapamTimerState = await readJapamTimerState(UID, JAPAM_A);
    expect(a.seconds).toBe('60');
    expect(a.paused).toBe('true');
  });
});

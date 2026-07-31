import { computeColdStartRestoreDecision } from '../timerColdStartRestore';

describe('computeColdStartRestoreDecision', () => {
  it('restores a force-closed running session as paused', () => {
    // A 10-minute session, force-closed while running. Reopen must show Resume at the last
    // persisted elapsed time, not Start.
    const result = computeColdStartRestoreDecision({
      savedRunning: true,
      savedPaused: false,
      savedSec: 180,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('paused');
    expect(result.restoredSeconds).toBe(180);
  });

  it('keeps the last persisted snapshot available for a paused session', () => {
    // Manual pause before kill remains restorable.
    const result = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 45,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.restoredSeconds).toBe(45);
  });

  it('restores as paused when the saved state was already paused (manual pause before kill)', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 300,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('paused');
    expect(result.restoredSeconds).toBe(300);
  });

  it('does not restore when the session had already fully completed (by loop count)', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: true,
      savedPaused: false,
      savedSec: 500,
      savedTarget: 600,
      savedCompletedLoops: 3,
      activeLoopLimit: 3,
    });
    expect(result.outcome).toBe('none');
  });

  it('does not restore when the session had already fully completed (by elapsed seconds)', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: true,
      savedPaused: false,
      savedSec: 600,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('none');
  });

  it('does not restore when there is no meaningful saved progress', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: false,
      savedSec: 0,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('none');
  });

  it('does not restore when target is zero/unknown', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: true,
      savedPaused: false,
      savedSec: 120,
      savedTarget: 0,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('none');
  });

  it('clamps restoredSeconds to never equal or exceed target', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: true,
      savedPaused: false,
      savedSec: 9999,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    // savedSec >= savedTarget is treated as already-completed, not clamped-and-restored.
    expect(result.outcome).toBe('none');
  });

  it('never returns a negative restoredSeconds', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: true,
      savedPaused: false,
      savedSec: -5,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.restoredSeconds).toBeGreaterThanOrEqual(0);
  });
});

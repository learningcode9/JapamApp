// Pure decision logic for the timer's cold-start (genuine process restart) restore path.
// Extracted specifically so this one, safety-critical computation is unit-testable in
// isolation — a wrong answer here directly reintroduces the "timer kept counting through
// an interruption" bug this logic exists to prevent.
//
// This effect only ever runs once per genuine process start (TimerProvider mounts exactly
// once, at the root layout) — never on a same-process background/foreground cycle, which is
// handled separately by the AppState listener in contexts/timer-context.tsx. So a persisted
// "running" flag here means the app was killed (force-close, OS reclaiming memory, crash)
// while a session was running, not that it's still genuinely running now. Restoring by
// recomputing elapsed from wall-clock time would silently credit (or debit) the user for
// however long the app was actually dead. Instead, this always freezes at the last
// periodically-persisted snapshot and requires an explicit Resume — never auto-resumes,
// never auto-completes.

export interface ColdStartRestoreInput {
  savedRunning: boolean;
  savedPaused: boolean;
  /** Last periodically-persisted elapsed seconds (TIMER_SECONDS_KEY) — NOT recomputed from wall-clock time. */
  savedSec: number;
  /** Target duration in seconds for the saved session. */
  savedTarget: number;
  savedCompletedLoops: number;
  activeLoopLimit: number;
}

export interface ColdStartRestoreDecision {
  outcome: 'paused' | 'none';
  /** Clamped, valid restored elapsed seconds. Only meaningful when outcome === 'paused'. */
  restoredSeconds: number;
}

export function computeColdStartRestoreDecision(
  input: ColdStartRestoreInput
): ColdStartRestoreDecision {
  const { savedRunning, savedPaused, savedSec, savedTarget, savedCompletedLoops, activeLoopLimit } = input;

  const restoredSeconds = Math.min(Math.max(0, savedSec), Math.max(0, savedTarget - 1));
  const savedTimerCompleted =
    savedTarget > 0 && (savedCompletedLoops >= activeLoopLimit || savedSec >= savedTarget);
  const hasRestorableProgress =
    (savedPaused || savedRunning) && restoredSeconds > 0 && savedTarget > 0 && !savedTimerCompleted;

  return {
    outcome: hasRestorableProgress ? 'paused' : 'none',
    restoredSeconds,
  };
}

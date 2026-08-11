/**
 * Mala-completion crossing detector + side-effect runner — pure, dependency-free.
 *
 * Bug this guards against: detecting completion by exact equality (`nextTotal % 108 === 0`)
 * only fires if the running total lands EXACTLY on a multiple of 108 at the moment some tap
 * is processed. It has no margin for any path that advances the total past a boundary without
 * landing on it (a duplicate/ghost tap event, a missed update under rapid tapping, a background
 * total correction). When that happens the whole completion block is skipped silently — no
 * history write, no Om sound — and the mala only completes on the NEXT boundary, which matches
 * "it worked when I tried again later". A crossing check (floor-division comparison of the
 * total before/after) catches the boundary regardless of how big the jump was.
 */

export const MALA_SIZE = 108;

export interface MalaCrossing {
  crossed: boolean;
  /** How many mala boundaries were passed in this single update (normally 1). */
  malasCompleted: number;
  /** floor(nextTotal / malaSize) — identifies which boundary was just crossed. */
  nextMala: number;
}

/** Pure crossing check. Uses the totals before/after, never a stale React count. */
export function detectMalaCrossing(
  previousTotal: number,
  nextTotal: number,
  malaSize: number = MALA_SIZE
): MalaCrossing {
  const prevMala = Math.floor(Math.max(0, previousTotal) / malaSize);
  const nextMala = Math.floor(Math.max(0, nextTotal) / malaSize);
  return {
    crossed: nextMala > prevMala,
    malasCompleted: Math.max(0, nextMala - prevMala),
    nextMala,
  };
}

export interface MalaCompletionGuard {
  alreadyCompleted(boundaryKey: number, scopeKey?: string | null): boolean;
  markCompleted(boundaryKey: number, scopeKey?: string | null): void;
}

/** One guard per screen/session. Tracks the highest mala boundary per workspace/session scope. */
export function createMalaCompletionGuard(): MalaCompletionGuard {
  const lastCompletedBoundaryByScope = new Map<string, number>();
  const normalizeScopeKey = (scopeKey?: string | null) => scopeKey ?? '__default__';

  return {
    alreadyCompleted: (boundaryKey: number, scopeKey?: string | null) => {
      return boundaryKey <= (lastCompletedBoundaryByScope.get(normalizeScopeKey(scopeKey)) ?? -1);
    },
    markCompleted: (boundaryKey: number, scopeKey?: string | null) => {
      const key = normalizeScopeKey(scopeKey);
      const lastCompletedBoundary = lastCompletedBoundaryByScope.get(key) ?? -1;
      if (boundaryKey > lastCompletedBoundary) lastCompletedBoundaryByScope.set(key, boundaryKey);
    },
  };
}

export interface RunMalaCompletionOptions {
  /** Identifies the boundary just crossed — use MalaCrossing.nextMala. */
  boundaryKey: number;
  /** Separates workspace/session-local boundary numbers (for example, A:1 and B:1). */
  scopeKey?: string | null;
  guard: MalaCompletionGuard;
  /** Persist the mala/history record. Must resolve to whether it was saved. */
  save: () => Promise<boolean>;
  /** Play Om sound + haptics/notification. Its outcome never affects `save`. */
  playFeedback: () => Promise<void>;
  onError?: (stage: 'save' | 'feedback', error: unknown) => void;
}

/**
 * Runs save + feedback for a single completion, guaranteeing:
 *  - both are attempted once a crossing is detected (feedback is not gated on save succeeding),
 *  - a failure in one never prevents or blocks the other,
 *  - the same boundary is never completed twice (guard checked + marked synchronously up front,
 *    before either async call starts, so a duplicate/concurrent call for the same boundary
 *    is rejected immediately instead of racing).
 */
export async function runMalaCompletion(
  options: RunMalaCompletionOptions
): Promise<{ saved: boolean; duplicate: boolean }> {
  const { boundaryKey, scopeKey, guard, save, playFeedback, onError } = options;

  if (guard.alreadyCompleted(boundaryKey, scopeKey)) {
    return { saved: false, duplicate: true };
  }
  guard.markCompleted(boundaryKey, scopeKey);

  const [saveResult, feedbackResult] = await Promise.allSettled([save(), playFeedback()]);

  let saved = false;
  if (saveResult.status === 'fulfilled') {
    saved = saveResult.value;
  } else {
    onError?.('save', saveResult.reason);
  }
  if (feedbackResult.status === 'rejected') {
    onError?.('feedback', feedbackResult.reason);
  }

  return { saved, duplicate: false };
}

export type TimerSaveSessionResult = 'saved' | 'retryable-skip' | 'duplicate-skip';

export const timerCompletionSaveReadiness = (
  userId: string | null | undefined,
  japamId: string | null | undefined,
  japamName: string | null | undefined,
): TimerSaveSessionResult | null =>
  userId && (!japamId || !japamName) ? 'retryable-skip' : null;

export const shouldReleaseTimerCompletionClaim = (result: TimerSaveSessionResult): boolean =>
  result === 'retryable-skip';

import {
  shouldReleaseTimerCompletionClaim,
  timerCompletionSaveReadiness,
  type TimerSaveSessionResult,
} from '../../lib/timerCompletionSaveReadiness';
import { appendCompletion, makeLoopCompletionId } from '../../lib/historyStore';

describe('Timer completion save readiness', () => {
  const userId = 'user-123';
  const japamId = 'japam-123';
  const japamName = 'My Japam';

  it('leaves saved markers untouched and the same loop retryable while current Japam is unresolved', () => {
    const savedMarkers = {
      lastSavedSessionKey: '',
      lastSavedCompletedLoops: 0,
    };
    const processedLoops = new Set<number>([1]);

    const result = timerCompletionSaveReadiness(userId, null, null);
    if (result === null) {
      savedMarkers.lastSavedSessionKey = 'user-123:60:1:1:2026-07-29';
      savedMarkers.lastSavedCompletedLoops = 1;
    }
    if (result && shouldReleaseTimerCompletionClaim(result)) {
      processedLoops.delete(1);
    }

    expect(result).toBe('retryable-skip');
    expect(savedMarkers).toEqual({ lastSavedSessionKey: '', lastSavedCompletedLoops: 0 });
    expect(processedLoops.has(1)).toBe(false);
  });

  it('saves the hydrated retry exactly once and does not release duplicate-saved claims', () => {
    let result: TimerSaveSessionResult = timerCompletionSaveReadiness(userId, japamId, japamName) ?? 'saved';
    const processedLoops = new Set<number>([1]);
    const completionId = makeLoopCompletionId(userId, 'session-1', 1);
    let history = appendCompletion([], {
      date: '2026-07-29T12:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 60,
      userId,
      completionId,
      japamId,
      japamName,
    });

    expect(result).toBe('saved');
    expect(history).toHaveLength(1);
    expect(shouldReleaseTimerCompletionClaim(result)).toBe(false);
    expect(processedLoops.has(1)).toBe(true);

    result = 'duplicate-skip';
    history = appendCompletion(history, {
      date: '2026-07-29T12:01:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 60,
      userId,
      completionId,
      japamId,
      japamName,
    });

    expect(history).toHaveLength(1);
    expect(shouldReleaseTimerCompletionClaim(result)).toBe(false);
    expect(processedLoops.has(1)).toBe(true);
  });
});

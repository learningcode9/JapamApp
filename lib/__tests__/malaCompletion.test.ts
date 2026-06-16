import {
  detectMalaCrossing,
  createMalaCompletionGuard,
  runMalaCompletion,
  MALA_SIZE,
} from '../malaCompletion';

describe('detectMalaCrossing', () => {
  it('107 -> 108 completes mala exactly once', () => {
    const result = detectMalaCrossing(107, 108);
    expect(result.crossed).toBe(true);
    expect(result.malasCompleted).toBe(1);
    expect(result.nextMala).toBe(1);
  });

  it('106 -> 108 (a jump of 2 in one update) still completes the mala', () => {
    const result = detectMalaCrossing(106, 108);
    expect(result.crossed).toBe(true);
    expect(result.malasCompleted).toBe(1);
  });

  it('106 -> 110 (overshoot past the boundary) still completes the mala', () => {
    const result = detectMalaCrossing(106, 110);
    expect(result.crossed).toBe(true);
    expect(result.malasCompleted).toBe(1);
    expect(result.nextMala).toBe(1);
  });

  it('does not fire mid-mala (e.g. 50 -> 51)', () => {
    const result = detectMalaCrossing(50, 51);
    expect(result.crossed).toBe(false);
    expect(result.malasCompleted).toBe(0);
  });

  it('does not re-fire for the step right after completion (108 -> 109)', () => {
    const result = detectMalaCrossing(108, 109);
    expect(result.crossed).toBe(false);
  });

  it('detects multiple boundaries crossed in a single jump (e.g. 107 -> 220)', () => {
    const result = detectMalaCrossing(107, 220);
    expect(result.crossed).toBe(true);
    expect(result.malasCompleted).toBe(2);
    expect(result.nextMala).toBe(2);
  });

  it('uses MALA_SIZE=108 by default', () => {
    expect(MALA_SIZE).toBe(108);
    expect(detectMalaCrossing(215, 216).nextMala).toBe(2);
  });
});

describe('rapid taps cannot skip completion', () => {
  it('simulating a fast tap sequence from 105 to 110 one tap at a time crosses exactly once', () => {
    let crossedCount = 0;
    let previousTotal = 105;
    for (const nextTotal of [106, 107, 108, 109, 110]) {
      if (detectMalaCrossing(previousTotal, nextTotal).crossed) crossedCount++;
      previousTotal = nextTotal;
    }
    expect(crossedCount).toBe(1);
  });

  it('a single update that jumps clean over 108 (e.g. 106 -> 109) still crosses exactly once', () => {
    const result = detectMalaCrossing(106, 109);
    expect(result.crossed).toBe(true);
    expect(result.malasCompleted).toBe(1);
  });
});

describe('runMalaCompletion', () => {
  const okGuard = () => createMalaCompletionGuard();

  it('Om sound (feedback) failure does not block mala/history save', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const playFeedback = jest.fn().mockRejectedValue(new Error('audio device busy'));
    const onError = jest.fn();

    const result = await runMalaCompletion({
      boundaryKey: 1,
      guard: okGuard(),
      save,
      playFeedback,
      onError,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(playFeedback).toHaveBeenCalledTimes(1);
    expect(result.saved).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(onError).toHaveBeenCalledWith('feedback', expect.any(Error));
  });

  it('a save failure does not block feedback (Om sound) from being attempted', async () => {
    const save = jest.fn().mockRejectedValue(new Error('storage write failed'));
    const playFeedback = jest.fn().mockResolvedValue(undefined);
    const onError = jest.fn();

    const result = await runMalaCompletion({
      boundaryKey: 1,
      guard: okGuard(),
      save,
      playFeedback,
      onError,
    });

    expect(playFeedback).toHaveBeenCalledTimes(1);
    expect(result.saved).toBe(false);
    expect(onError).toHaveBeenCalledWith('save', expect.any(Error));
  });

  it('prevents duplicate completion for the same boundary', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const playFeedback = jest.fn().mockResolvedValue(undefined);
    const guard = okGuard();

    const first = await runMalaCompletion({ boundaryKey: 3, guard, save, playFeedback });
    const second = await runMalaCompletion({ boundaryKey: 3, guard, save, playFeedback });

    expect(first.duplicate).toBe(false);
    expect(first.saved).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(playFeedback).toHaveBeenCalledTimes(1);
  });

  it('allows a later boundary to complete normally after an earlier one', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const playFeedback = jest.fn().mockResolvedValue(undefined);
    const guard = okGuard();

    await runMalaCompletion({ boundaryKey: 1, guard, save, playFeedback });
    const second = await runMalaCompletion({ boundaryKey: 2, guard, save, playFeedback });

    expect(second.duplicate).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(playFeedback).toHaveBeenCalledTimes(2);
  });
});

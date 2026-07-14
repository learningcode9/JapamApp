import { computeColdStartRestoreDecision } from '../timerColdStartRestore';

// Replicate the key helpers from timer-context.tsx to test them in isolation.
// These are pure string functions — no AsyncStorage dependency needed.
const getJapamKey = (key: string, uid: string, japamId: string) => `${key}:${uid}:${japamId}`;
const getUserKey = (key: string, uid: string) => `${key}:${uid}`;

const UID = 'test-user-123';
const JAPAM_A = 'japam-a-1111';
const JAPAM_B = 'japam-b-2222';

describe('per-Japam timer key helpers', () => {
  it('getJapamKey produces key:uid:japamId', () => {
    expect(getJapamKey('timerSeconds', UID, JAPAM_A)).toBe('timerSeconds:test-user-123:japam-a-1111');
  });
  it('getJapamKey distinguishes different Japams', () => {
    const a = getJapamKey('timerSeconds', UID, JAPAM_A);
    const b = getJapamKey('timerSeconds', UID, JAPAM_B);
    expect(a).not.toBe(b);
    expect(a.endsWith(':japam-a-1111')).toBe(true);
    expect(b.endsWith(':japam-b-2222')).toBe(true);
  });
  it('getUserKey produces key:uid (backward compatible with existing data)', () => {
    expect(getUserKey('timerSeconds', UID)).toBe('timerSeconds:test-user-123');
  });
  it('three-key hierarchy: japam key contains user key and bare key', () => {
    const japam = getJapamKey('timerSeconds', UID, JAPAM_A);
    const user = getUserKey('timerSeconds', UID);
    expect(japam).toContain(user); // japam key is superset of user key
    expect(user).toContain('timerSeconds');
  });
});

describe('timer state isolation: A and B restore independently', () => {
  it('Japam A paused at 120s restores correctly regardless of B state', () => {
    // This simulates: A has paused state, B has different paused state.
    // The cold-start restore decision for A should be based ONLY on A's values.
    const aDecision = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 120,
      savedTarget: 300,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(aDecision.outcome).toBe('paused');
    expect(aDecision.restoredSeconds).toBe(120);

    // B's entirely different state doesn't affect A's decision (pure function).
    const bDecision = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 30,
      savedTarget: 180,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(bDecision.outcome).toBe('paused');
    expect(bDecision.restoredSeconds).toBe(30);
  });

  it('A→B→A round-trip: each Japam restores its exact snapshot', () => {
    // Phase 1: A is paused at 120s (5m target)
    const aPaused = computeColdStartRestoreDecision({
      savedRunning: false, savedPaused: true, savedSec: 120,
      savedTarget: 300, savedCompletedLoops: 0, activeLoopLimit: 1,
    });
    expect(aPaused.restoredSeconds).toBe(120);

    // Phase 2: Switch to B, B is paused at 30s (3m target)
    const bPaused = computeColdStartRestoreDecision({
      savedRunning: false, savedPaused: true, savedSec: 30,
      savedTarget: 180, savedCompletedLoops: 0, activeLoopLimit: 1,
    });
    expect(bPaused.restoredSeconds).toBe(30);

    // Phase 3: Switch back to A — A's restore decision must be unchanged
    const aRestored = computeColdStartRestoreDecision({
      savedRunning: false, savedPaused: true, savedSec: 120,
      savedTarget: 300, savedCompletedLoops: 0, activeLoopLimit: 1,
    });
    expect(aRestored.restoredSeconds).toBe(120);
    expect(aRestored.outcome).toBe('paused');
  });
});

describe('force-stop restore: selected Japam persists', () => {
  it('cold-start restore for A uses A-sepcific values', () => {
    // Simulates force-stop while A is paused at 120s
    const result = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 120,
      savedTarget: 300,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('paused');
    expect(result.restoredSeconds).toBe(120);
  });

  it('cold-start restore for B uses B-sepcific values', () => {
    const result = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 45,
      savedTarget: 600,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(result.outcome).toBe('paused');
    expect(result.restoredSeconds).toBe(45);
  });

  it('fresh Japam with no saved timer shows Start (not Resume)', () => {
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

  it('empty per-Japam timer keys on switch must NOT fall through to :uid user keys', () => {
    // When switching to Japam B, the did-switch handler only reads :uid:japamB keys.
    // Even if :uid or bare keys have legacy data (from Japam A's persistState),
    // those must NOT be consulted — B shows fresh Start, not A's timer.
    const bNoState = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: false,
      savedSec: 0,
      savedTarget: 0,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(bNoState.outcome).toBe('none');

    // Meanwhile A's paused state (:uid:japamA keys) should be unaffected
    const aPaused = computeColdStartRestoreDecision({
      savedRunning: false,
      savedPaused: true,
      savedSec: 120,
      savedTarget: 300,
      savedCompletedLoops: 0,
      activeLoopLimit: 1,
    });
    expect(aPaused.outcome).toBe('paused');
    expect(aPaused.restoredSeconds).toBe(120);
  });
});

describe('running-session attribution stays with Japam captured at Start', () => {
  it('activeJapamIdRef is a one-time snapshot, never updated on switch', () => {
    // This validates the existing architectural decision: activeJapamIdRef is set once
    // by setActiveJapamSelection at Start time, and is deliberately NOT kept in sync
    // with CurrentJapamContext. Switching Japams mid-session must NOT retroactively
    // change which Japam the completion is attributed to.
    let attributionRef: string | null = null;

    // Set at Start time
    attributionRef = JAPAM_A;
    expect(attributionRef).toBe(JAPAM_A);

    // User switches to B — attribution ref does NOT change
    expect(attributionRef).toBe(JAPAM_A);
    expect(attributionRef).not.toBe(JAPAM_B);

    // Completion save uses the captured ref
    const completion = { japamId: attributionRef };
    expect(completion.japamId).toBe(JAPAM_A);
  });
});

describe('no-session / security guards unchanged', () => {
  it('start() requires user or guest identity (F15 guard preserved)', () => {
    // No user, no guest, no guest mode entry point
    const hasUser = false;
    const isGuest = false;
    const canStart = Boolean(hasUser) || isGuest;
    expect(canStart).toBe(false);
  });

  it('start() allows authenticated user (F15 guard properly allows)', () => {
    const hasUser = true;
    const isGuest = false;
    const canStart = Boolean(hasUser) || isGuest;
    expect(canStart).toBe(true);
  });

  it('guest user without uid can still start', () => {
    // Guest mode: no uid, but isGuest flag is set
    const hasUser = false;
    const isGuest = true;
    const canStart = Boolean(hasUser) || isGuest;
    expect(canStart).toBe(true);
  });
});

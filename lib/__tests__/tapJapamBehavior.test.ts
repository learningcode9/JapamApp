import {
  computeTapTransition,
  createTapIdentitySnapshot,
} from '../tapJapamBehavior';
import {
  canRestoreTapWorkspace,
  createTapWorkspaceRestoreCoordinator,
} from '../tapJapamWorkspace';

describe('Tap Japam behavior', () => {
  it('counts rapid taps without suppression', () => {
    let total = 104;
    const totals: number[] = [];

    for (let i = 0; i < 5; i += 1) {
      const transition = computeTapTransition(total);
      total = transition.nextTotal;
      totals.push(total);
    }

    expect(totals).toEqual([105, 106, 107, 108, 109]);
  });

  it('one press increments by exactly one', () => {
    expect(computeTapTransition(41).nextTotal).toBe(42);
  });

  it('the 108th tap crosses exactly one mala boundary', () => {
    const transition = computeTapTransition(107);

    expect(transition.nextTotal).toBe(108);
    expect(transition.crossing.crossed).toBe(true);
    expect(transition.crossing.malasCompleted).toBe(1);
    expect(transition.crossing.nextMala).toBe(1);
  });

  it('identity snapshot stays immutable after active Japam values change', () => {
    let userId: string | null = 'user-1';
    let japamId: string | null = 'japam-a';
    let japamName: string | null = 'Japam A';

    const snapshot = createTapIdentitySnapshot(userId, japamId, japamName);

    userId = 'user-2';
    japamId = 'japam-b';
    japamName = 'Japam B';

    expect(snapshot).toEqual({ userId: 'user-1', japamId: 'japam-a', japamName: 'Japam A' });
  });

  it('invalidates stale A restore work across A→B→A', () => {
    const coordinator = createTapWorkspaceRestoreCoordinator();
    const applied: string[] = [];

    const restoreA = coordinator.begin('japam-a');
    const restoreB = coordinator.begin('japam-b');
    if (coordinator.isCurrent(restoreA)) applied.push(restoreA.japamId);
    if (coordinator.isCurrent(restoreB)) applied.push(restoreB.japamId);

    const restoreAAgain = coordinator.begin('japam-a');
    if (coordinator.isCurrent(restoreB)) applied.push(restoreB.japamId);
    if (coordinator.isCurrent(restoreAAgain)) applied.push(restoreAAgain.japamId);

    expect(applied).toEqual(['japam-b', 'japam-a']);
    expect(coordinator.isCurrent(restoreA)).toBe(false);
    expect(coordinator.isCurrent(restoreB)).toBe(false);
  });

  it('does not allow a signed-in restore without a concrete Japam scope', () => {
    expect(canRestoreTapWorkspace('user-1', null)).toBe(false);
    expect(canRestoreTapWorkspace('user-1', 'japam-a')).toBe(true);
    expect(canRestoreTapWorkspace(null, 'japam-a')).toBe(true);
  });
});

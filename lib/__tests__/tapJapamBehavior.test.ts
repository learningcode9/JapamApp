import {
  computeTapTransition,
  createTapIdentitySnapshot,
} from '../tapJapamBehavior';

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
});

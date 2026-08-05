import {
  canPersistJapamCompletion,
  getJapamActionReadiness,
} from '../japamActionReadiness';

describe('Japam action readiness', () => {
  it('blocks timer actions while Japam state is loading for authenticated users', () => {
    expect(getJapamActionReadiness({
      userId: 'user-1',
      isAnonymous: false,
      currentJapamId: null,
      isJapamLoading: true,
    })).toMatchObject({
      requiresResolvedJapam: true,
      isBlockedByLoading: true,
      canAct: false,
    });
  });

  it('blocks timer and tap actions without a resolved Japam for authenticated users', () => {
    expect(getJapamActionReadiness({
      userId: 'user-1',
      isAnonymous: false,
      currentJapamId: null,
      isJapamLoading: false,
    })).toMatchObject({
      requiresResolvedJapam: true,
      isBlockedByMissingJapam: true,
      canAct: false,
      canSnapshot: false,
    });
  });

  it('allows timer and tap actions with a resolved Japam for authenticated users', () => {
    expect(getJapamActionReadiness({
      userId: 'user-1',
      isAnonymous: false,
      currentJapamId: 'japam-a',
      isJapamLoading: false,
    })).toMatchObject({
      requiresResolvedJapam: true,
      canAct: true,
      canSnapshot: true,
    });
  });

  it('preserves guest behavior without requiring a resolved Japam', () => {
    expect(getJapamActionReadiness({
      userId: null,
      isAnonymous: false,
      currentJapamId: null,
      isJapamLoading: true,
    })).toMatchObject({
      requiresResolvedJapam: false,
      canAct: true,
      canSnapshot: true,
    });
  });

  it('treats anonymous users like guests for Japam readiness', () => {
    expect(getJapamActionReadiness({
      userId: 'anon-user',
      isAnonymous: true,
      currentJapamId: null,
      isJapamLoading: true,
    })).toMatchObject({
      requiresResolvedJapam: false,
      canAct: true,
      canSnapshot: true,
    });
  });

  it('blocks authenticated null-scoped completion writes and allows resolved ones', () => {
    expect(canPersistJapamCompletion({
      userId: 'user-1',
      isAnonymous: false,
      japamId: null,
    })).toBe(false);

    expect(canPersistJapamCompletion({
      userId: 'user-1',
      isAnonymous: false,
      japamId: 'japam-a',
    })).toBe(true);
  });
});

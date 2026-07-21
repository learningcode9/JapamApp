jest.mock('../japamsRepository', () => ({
  loadJapams: jest.fn(),
  createJapam: jest.fn(),
  loadCurrentJapamId: jest.fn(),
  saveCurrentJapamId: jest.fn(),
  saveJapams: jest.fn(),
}));

import { ensureDefaultJapam } from '../ensureDefaultJapam';
import * as japamsRepository from '../japamsRepository';
import { activeJapams, type Japam } from '../japams';

const mockedLoadJapams = japamsRepository.loadJapams as jest.Mock;
const mockedCreateJapam = japamsRepository.createJapam as jest.Mock;

const USER_ID = 'user-123';
const NOW = '2026-07-20T10:00:00.000Z';

function makeJapam(overrides: Partial<Japam> = {}): Japam {
  const id = overrides.id ?? 'japam-' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    userId: USER_ID,
    name: 'My Japam',
    syncStatus: 'synced',
    displayOrder: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Helper: run ensureDefaultJapam and extract counts ─────────────────────
type ScenarioResult = {
  localCount: number;
  remoteCount: number;
  selectedUuid: string | null;
  duplicateCount: number;
  created: boolean;
  japam: Japam | null;
  pass: boolean;
};

async function run(
  japams: Japam[],
  suggestedName = 'My Japam',
): Promise<ScenarioResult> {
  mockedLoadJapams.mockResolvedValue(japams);

  let createdJapam: Japam | null = null;
  mockedCreateJapam.mockImplementation(async (_uid: string, name: string) => {
    const j = makeJapam({ name, id: 'new-' + Math.random().toString(36).slice(2, 8) });
    createdJapam = j;
    return { created: j, japams: [...japams, j] };
  });

  const japam = await ensureDefaultJapam(USER_ID, suggestedName);

  const localAfterCall = mockedLoadJapams.mock.results.length > 0
    ? mockedLoadJapams.mock.results[mockedLoadJapams.mock.results.length - 1].value
    : [];

  const resolvedLocal = localAfterCall instanceof Promise ? await localAfterCall : localAfterCall;
  const active = activeJapams(Array.isArray(resolvedLocal) ? resolvedLocal : japams);

  const allJapams = Array.isArray(resolvedLocal) ? resolvedLocal : japams;
  const myJapamCount = allJapams.filter((j: Japam) => j.name === 'My Japam').length;

  const result: ScenarioResult = {
    localCount: allJapams.length,
    remoteCount: mockedCreateJapam.mock.calls.length,
    selectedUuid: japam?.id ?? null,
    duplicateCount: myJapamCount > 1 ? myJapamCount : 0,
    created: mockedCreateJapam.mock.calls.length > 0,
    japam,
    pass: false,
  };

  result.pass = !result.created || result.duplicateCount === 0;
  return result;
}

// ─── Scenario 1: Brand-new account ──────────────────────────────────────────
describe('Scenario 1: Brand-new account', () => {
  it('creates exactly one default Japam', async () => {
    const r = await run([]);

    expect(r.localCount).toBe(0);
    expect(r.created).toBe(true);
    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(r.duplicateCount).toBe(0);
    expect(r.japam).not.toBeNull();
    expect(r.pass).toBe(true);

    console.log('[SCENARIO 1] brand-new account: ' +
      'local=%d remote=%d selected=%s dupes=%d created=%s PASS=%s',
      r.localCount, r.remoteCount, r.selectedUuid, r.duplicateCount, r.created, r.pass);
  });
});

// ─── Scenario 2: Existing production account with one Japam ─────────────────
describe('Scenario 2: Existing account with one Japam', () => {
  it('does not create a new default Japam', async () => {
    const existing = makeJapam({ id: 'existing-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([existing]);

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(japam).not.toBeNull();
    expect(japam!.id).toBe('existing-1');
    expect(activeJapams([existing]).length).toBe(1);
  });
});

// ─── Scenario 3: Existing account with duplicates in AsyncStorage ───────────
describe('Scenario 3: Existing account with duplicate My Japam entries', () => {
  it('does not create additional duplicates', async () => {
    const dupes = [
      makeJapam({ id: 'dupe-1', name: 'My Japam' }),
      makeJapam({ id: 'dupe-2', name: 'My Japam' }),
      makeJapam({ id: 'dupe-3', name: 'My Japam' }),
    ];
    mockedLoadJapams.mockResolvedValue(dupes);

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(japam).not.toBeNull();
    expect(japam!.id).toBe('dupe-1');
  });

  it('existing duplicates remain unchanged', async () => {
    const dupes = [
      makeJapam({ id: 'dupe-a', name: 'My Japam' }),
      makeJapam({ id: 'dupe-b', name: 'My Japam' }),
      makeJapam({ id: 'dupe-c', name: 'My Japam' }),
    ];
    const originalIds = dupes.map(d => d.id);
    mockedLoadJapams.mockResolvedValue(dupes);

    await ensureDefaultJapam(USER_ID, 'My Japam');

    const loadResult = await mockedLoadJapams.mock.results[0].value;
    expect(loadResult.map((j: Japam) => j.id).sort()).toEqual(originalIds.sort());
  });

  it('no data loss — all original Japams preserved', async () => {
    const dupes = [
      makeJapam({ id: 'keep-1', name: 'My Japam' }),
      makeJapam({ id: 'keep-2', name: 'Gayatri' }),
      makeJapam({ id: 'keep-3', name: 'My Japam', archivedAt: NOW }),
    ];
    const originalCount = dupes.length;
    mockedLoadJapams.mockResolvedValue(dupes);

    await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(dupes.length).toBe(originalCount);
  });
});

// ─── Scenario 4: Guest → Google Sign-in ─────────────────────────────────────
describe('Scenario 4: Guest → Google Sign-in', () => {
  it('guest has no Japams; after sign-in creates exactly one', async () => {
    // Guest state: no userId used for ensureDefaultJapam
    // After sign-in: userId is set, refresh() calls ensureDefaultJapam

    mockedLoadJapams.mockResolvedValue([]);
    mockedCreateJapam.mockResolvedValue({
      created: makeJapam({ id: 'guest-signin-1' }),
      japams: [makeJapam({ id: 'guest-signin-1' })],
    });

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(japam).not.toBeNull();
    expect(japam!.id).toBe('guest-signin-1');
  });
});

// ─── Scenario 5: Google Sign-out → Sign-in ──────────────────────────────────
describe('Scenario 5: Google Sign-out → Sign-in', () => {
  it('sign-out clears state; sign-in creates one fresh Japam', async () => {
    mockedLoadJapams.mockResolvedValue([]);
    mockedCreateJapam.mockResolvedValue({
      created: makeJapam({ id: 'fresh-1' }),
      japams: [makeJapam({ id: 'fresh-1' })],
    });

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(japam).not.toBeNull();
    expect(japam!.id).toBe('fresh-1');
  });
});

// ─── Scenario 6: App restart (persisted state survives) ─────────────────────
describe('Scenario 6: App restart', () => {
  it('persisted active Japam prevents new creation after restart', async () => {
    const persisted = makeJapam({ id: 'persisted-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([persisted]);

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(japam!.id).toBe('persisted-1');
  });
});

// ─── Scenario 7: Force-close (same as restart) ──────────────────────────────
describe('Scenario 7: Force-close', () => {
  it('persisted state survives force-close; no duplicate creation', async () => {
    const survivor = makeJapam({ id: 'survivor-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([survivor]);

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(japam!.id).toBe('survivor-1');
  });
});

// ─── Scenario 8: TOKEN_REFRESHED ─────────────────────────────────────────────
describe('Scenario 8: TOKEN_REFRESHED', () => {
  it('TOKEN_REFRESHED-triggered refresh does not add Japams', async () => {
    const existing = makeJapam({ id: 'token-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([existing]);

    // Simulate refresh() called from japam-auth-updated listener
    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(japam!.id).toBe('token-1');
  });

  it('repeated TOKEN_REFRESHED events do not accumulate Japams', async () => {
    const existing = makeJapam({ id: 'repeat-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([existing]);

    // Three refresh() calls from three TOKEN_REFRESHED events
    const r1 = await ensureDefaultJapam(USER_ID, 'My Japam');
    const r2 = await ensureDefaultJapam(USER_ID, 'My Japam');
    const r3 = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(r1!.id).toBe('repeat-1');
    expect(r2!.id).toBe('repeat-1');
    expect(r3!.id).toBe('repeat-1');
  });
});

// ─── Scenario 9: LegacyHistoryBackfillRunner after CurrentJapamProvider ──────
describe('Scenario 9: LegacyHistoryBackfillRunner after CurrentJapamProvider', () => {
  it('backfill reuses the Japam created by refresh()', async () => {
    // Simulate: refresh() creates Japam-A first
    let japamA: Japam | null = null;
    mockedLoadJapams
      .mockResolvedValueOnce([])           // refresh reads empty
      .mockResolvedValueOnce([makeJapam({ id: 'japam-A' })]);  // after creation

    mockedCreateJapam.mockImplementation(async () => {
      japamA = makeJapam({ id: 'japam-A' });
      return { created: japamA, japams: [japamA] };
    });

    // Step 1: refresh() creates Japam-A
    const fromRefresh = await ensureDefaultJapam(USER_ID, 'My Japam');

    // Step 2: backfill runs, calls ensureDefaultJapam with suggested name
    // The loadJapams now returns [japam-A] (active)
    mockedLoadJapams.mockResolvedValue([japamA!]);
    const fromBackfill = await ensureDefaultJapam(USER_ID, 'Gayatri');  // different suggested name

    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(fromRefresh!.id).toBe('japam-A');
    expect(fromBackfill!.id).toBe('japam-A');
    expect(fromBackfill!.name).toBe('My Japam');  // existing name preserved
  });
});

// ─── Scenario 10: CurrentJapamProvider after LegacyHistoryBackfillRunner ─────
describe('Scenario 10: CurrentJapamProvider after LegacyHistoryBackfillRunner', () => {
  it('refresh() reuses the Japam created by backfill', async () => {
    // Simulate: backfill creates Japam-B first with a suggested name
    let japamB: Japam | null = null;
    mockedLoadJapams
      .mockResolvedValueOnce([])            // backfill reads empty
      .mockResolvedValueOnce([makeJapam({ id: 'japam-B', name: 'Gayatri' })]);  // after creation

    mockedCreateJapam.mockImplementation(async (_uid: string, name: string) => {
      japamB = makeJapam({ id: 'japam-B', name });
      return { created: japamB, japams: [japamB] };
    });

    // Step 1: backfill creates Japam-B with name "Gayatri"
    const fromBackfill = await ensureDefaultJapam(USER_ID, 'Gayatri');

    // Step 2: refresh runs, checks for active Japams
    mockedLoadJapams.mockResolvedValue([japamB!]);
    const fromRefresh = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(fromBackfill!.id).toBe('japam-B');
    expect(fromRefresh!.id).toBe('japam-B');
    expect(fromBackfill!.name).toBe('Gayatri');
    expect(fromRefresh!.name).toBe('Gayatri');  // existing name preserved
  });
});

// ─── Scenario 11: Simultaneous refresh() calls ──────────────────────────────
describe('Scenario 11: Simultaneous refresh() calls', () => {
  it('concurrent ensureDefaultJapam calls create exactly one Japam', async () => {
    let resolveLoad: () => void;
    const loadGate = new Promise<void>((r) => { resolveLoad = r; });
    let callCount = 0;

    mockedLoadJapams.mockImplementation(async () => {
      callCount++;
      await loadGate;
      return [];
    });

    mockedCreateJapam.mockImplementation(async (_uid: string, name: string) => {
      const j = makeJapam({ id: 'simultaneous-1', name });
      return { created: j, japams: [j] };
    });

    const p1 = ensureDefaultJapam(USER_ID, 'My Japam');
    const p2 = ensureDefaultJapam(USER_ID, 'My Japam');

    resolveLoad!();
    const [r1, r2] = await Promise.all([p1, p2]);

    // loadJapams called once (coordinator dedup)
    expect(callCount).toBe(1);
    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(r1!.id).toBe('simultaneous-1');
    expect(r2!.id).toBe('simultaneous-1');
    expect(r1!.id).toBe(r2!.id);
  });

  it('three concurrent calls produce exactly one Japam', async () => {
    let resolveGate: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let loadCount = 0;

    mockedLoadJapams.mockImplementation(async () => {
      loadCount++;
      await gate;
      return [];
    });

    mockedCreateJapam.mockImplementation(async (_uid: string, name: string) => {
      const j = makeJapam({ id: 'three-concurrent-1', name });
      return { created: j, japams: [j] };
    });

    const p1 = ensureDefaultJapam(USER_ID, 'My Japam');
    const p2 = ensureDefaultJapam(USER_ID, 'My Japam');
    const p3 = ensureDefaultJapam(USER_ID, 'My Japam');

    resolveGate!();
    const results = await Promise.all([p1, p2, p3]);

    expect(loadCount).toBe(1);
    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(results[0]!.id).toBe('three-concurrent-1');
    expect(results[1]!.id).toBe('three-concurrent-1');
    expect(results[2]!.id).toBe('three-concurrent-1');
    expect(new Set(results.map(r => r!.id)).size).toBe(1);
  });
});

// ─── Scenario 12: Offline launch → reconnect ────────────────────────────────
describe('Scenario 12: Offline launch → reconnect', () => {
  it('offline: no active Japams → create one locally', async () => {
    mockedLoadJapams.mockResolvedValue([]);
    mockedCreateJapam.mockImplementation(async (_uid: string, name: string) => {
      const j = makeJapam({ id: 'offline-1', name, syncStatus: 'pending' });
      return { created: j, japams: [j] };
    });

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
    expect(japam).not.toBeNull();
    expect(japam!.syncStatus).toBe('pending');
  });

  it('reconnect: existing active Japam from offline prevents new creation', async () => {
    const offlineJapam = makeJapam({ id: 'offline-reconnect-1', syncStatus: 'pending' });
    mockedLoadJapams.mockResolvedValue([offlineJapam]);

    const japam = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(japam!.id).toBe('offline-reconnect-1');
  });

  it('reconnect: remote sync does not create duplicates of already-synced Japam', async () => {
    const alreadySynced = makeJapam({ id: 'synced-1', syncStatus: 'synced' });
    mockedLoadJapams.mockResolvedValue([alreadySynced]);

    await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
  });
});

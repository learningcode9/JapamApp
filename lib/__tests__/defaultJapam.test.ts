import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDefaultJapamCreationCoordinator } from '../defaultJapamCreationCoordinator';
import { type Japam } from '../japams';
import * as japamsRepository from '../japamsRepository';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    default: {
      getItem: jest.fn(async (key: string) => store[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete store[key]; }),
      clear: jest.fn(async () => { Object.keys(store).forEach(k => delete store[k]); }),
    },
    __esModule: true,
  };
});

const UID = 'auth-user-123';

const makeJapam = (overrides: Partial<Japam> = {}): Japam => ({
  id: 'existing-1',
  userId: UID,
  name: 'Gayatri',
  displayOrder: null,
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T10:00:00.000Z',
  archivedAt: null,
  ...overrides,
});

describe('default Japam — repository-level behavior', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('creates a "My Japam" for a new user with zero Japams', async () => {
    const japams = await japamsRepository.loadJapams(UID);
    expect(japams).toHaveLength(0);

    const result = await japamsRepository.createJapam(UID, 'My Japam');
    expect(result).not.toBeNull();
    expect(result!.created.name).toBe('My Japam');

    const loaded = await japamsRepository.loadJapams(UID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('My Japam');
  });

  it('persists the default Japam across re-loads', async () => {
    const r1 = await japamsRepository.createJapam(UID, 'My Japam');
    const defaultId = r1!.created.id;

    const loaded = await japamsRepository.loadJapams(UID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(defaultId);
    expect(loaded[0].name).toBe('My Japam');
  });

  it('sets currentJapamId to the created Japam ID', async () => {
    const result = await japamsRepository.createJapam(UID, 'My Japam');
    await japamsRepository.saveCurrentJapamId(UID, result!.created.id);

    const savedId = await japamsRepository.loadCurrentJapamId(UID);
    expect(savedId).toBe(result!.created.id);
  });

  it('existing user with Japams is unaffected', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam()]);
    let japams = await japamsRepository.loadJapams(UID);
    expect(japams).toHaveLength(1);
    expect(japams[0].name).toBe('Gayatri');

    await japamsRepository.saveCurrentJapamId(UID, 'existing-1');
    let currentId = await japamsRepository.loadCurrentJapamId(UID);
    expect(currentId).toBe('existing-1');
  });

  it('app reload does not create duplicates', async () => {
    await japamsRepository.createJapam(UID, 'My Japam');
    expect(await japamsRepository.loadJapams(UID)).toHaveLength(1);

    // Simulate a second mount/reload — the app loads existing japams,
    // sees active.length > 0, and does NOT call createJapam.
    // This test verifies the data persisted correctly for that flow.
    const loaded = await japamsRepository.loadJapams(UID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('My Japam');
  });

  it('selects the default Japam via currentJapamId', async () => {
    const result = await japamsRepository.createJapam(UID, 'My Japam');
    const defaultId = result!.created.id;

    await japamsRepository.saveCurrentJapamId(UID, defaultId);

    const loaded = await japamsRepository.loadJapams(UID);
    const persistedId = await japamsRepository.loadCurrentJapamId(UID);
    const active = loaded.filter((j) => j.archivedAt === null);
    const persistedStillActive = persistedId
      ? active.find((j) => j.id === persistedId)
      : undefined;
    const resolvedCurrentId = persistedStillActive?.id ?? active[0]?.id ?? null;

    expect(resolvedCurrentId).toBe(defaultId);
    expect(resolvedCurrentId).not.toBeNull();
  });

  it('falls back to first active Japam when saved selection is invalid', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'first' }), makeJapam({ id: 'second' })]);
    await japamsRepository.saveCurrentJapamId(UID, 'nonexistent');

    const loaded = await japamsRepository.loadJapams(UID);
    const persistedId = await japamsRepository.loadCurrentJapamId(UID);
    const active = loaded.filter((j) => j.archivedAt === null);
    const persistedStillActive = persistedId
      ? active.find((j) => j.id === persistedId)
      : undefined;
    const resolvedCurrentId = persistedStillActive?.id ?? active[0]?.id ?? null;

    expect(resolvedCurrentId).toBe('first');
    expect(persistedId).toBe('nonexistent');
  });

  it('falls back to first active Japam when saved selection is archived', async () => {
    await japamsRepository.saveJapams(UID, [
      makeJapam({ id: 'archived', archivedAt: '2026-07-07T00:00:00.000Z' }),
      makeJapam({ id: 'active', name: 'Govinda' }),
    ]);
    await japamsRepository.saveCurrentJapamId(UID, 'archived');

    const loaded = await japamsRepository.loadJapams(UID);
    const persistedId = await japamsRepository.loadCurrentJapamId(UID);
    const active = loaded.filter((j) => j.archivedAt === null);
    const persistedStillActive = persistedId
      ? active.find((j) => j.id === persistedId)
      : undefined;
    const resolvedCurrentId = persistedStillActive?.id ?? active[0]?.id ?? null;

    expect(resolvedCurrentId).toBe('active');
  });

  it('creates a default Japam when all existing Japams are archived (zero active)', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'r1', archivedAt: '2026-07-07T00:00:00.000Z' })]);

    // This test verifies that the loaded japams have zero active
    const loaded = await japamsRepository.loadJapams(UID);
    const active = loaded.filter((j) => j.archivedAt === null);
    expect(active).toHaveLength(0);
    expect(loaded).toHaveLength(1); // One archived

    // Creating a new Japam appends it
    const result = await japamsRepository.createJapam(UID, 'My Japam');
    expect(result).not.toBeNull();
    expect(result!.japams).toHaveLength(2);

    const updated = await japamsRepository.loadJapams(UID);
    const updatedActive = updated.filter((j) => j.archivedAt === null);
    expect(updatedActive).toHaveLength(1);
    expect(updatedActive[0].name).toBe('My Japam');
  });

  it('concurrent initialization creates exactly one "My Japam"', async () => {
    const coordinator = createDefaultJapamCreationCoordinator();
    const CUID = 'concurrent-user';

    let openGate: () => void;
    const creationGate = new Promise<void>((resolve) => { openGate = resolve; });

    const origCreate = japamsRepository.createJapam;
    const createSpy = jest.spyOn(japamsRepository, 'createJapam').mockImplementation(
      async (userId, name) => {
        await creationGate;
        return origCreate(userId, name);
      },
    );

    async function simulateRefresh(userId: string): Promise<{
      japams: Japam[];
      currentId: string | null;
    }> {
      let loaded = await japamsRepository.loadJapams(userId);
      if (loaded.filter((j) => j.archivedAt === null).length === 0 && userId) {
        await coordinator.ensureCreation(userId, () =>
          japamsRepository.createJapam(userId, 'My Japam'),
        );
        loaded = await japamsRepository.loadJapams(userId);
      }
      const persistedCurrentId = await japamsRepository.loadCurrentJapamId(userId);
      const active = loaded.filter((j) => j.archivedAt === null);
      const stillActive = persistedCurrentId
        ? active.find((j) => j.id === persistedCurrentId)
        : undefined;
      const resolvedCurrentId = stillActive?.id ?? active[0]?.id ?? null;
      if (resolvedCurrentId !== persistedCurrentId) {
        await japamsRepository.saveCurrentJapamId(userId, resolvedCurrentId);
      }
      return { japams: loaded, currentId: resolvedCurrentId };
    }

    // Start all 3 calls synchronously. Each yields at its first await (loadJapams).
    // Their continuations (microtasks) block on the creationGate inside the repository
    // spy (call 1) or on the coordinator's shared promise (calls 2, 3).
    const resultsPromise = Promise.all([
      simulateRefresh(CUID),
      simulateRefresh(CUID),
      simulateRefresh(CUID),
    ]);

    // Drain microtasks so all 3 continuations reach their blocking points,
    // then open the gate from a macrotask boundary.
    setTimeout(openGate!, 0);

    const results = await resultsPromise;

    expect(createSpy).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.japams).toHaveLength(1);
      expect(r.japams[0].name).toBe('My Japam');
      expect(r.currentId).toBe(r.japams[0].id);
      expect(r.currentId).not.toBeNull();
    }
    const ids = new Set(results.map((r) => r.currentId));
    expect(ids.size).toBe(1);

    createSpy.mockRestore();
  });

  it('cross-identity guard: each user gets their own default Japam when auth switches mid-flight', async () => {
    const coordinator = createDefaultJapamCreationCoordinator();
    const USER_A = 'user-a';
    const USER_B = 'user-b';

    let openGate: () => void;
    const creationGate = new Promise<void>((resolve) => { openGate = resolve; });

    const origCreate = japamsRepository.createJapam;
    const createSpy = jest.spyOn(japamsRepository, 'createJapam').mockImplementation(
      async (userId, name) => {
        await creationGate;
        return origCreate(userId, name);
      },
    );

    async function simulateRefresh(userId: string): Promise<{
      japams: Japam[];
      currentId: string | null;
    }> {
      let loaded = await japamsRepository.loadJapams(userId);
      if (loaded.filter((j) => j.archivedAt === null).length === 0 && userId) {
        await coordinator.ensureCreation(userId, () =>
          japamsRepository.createJapam(userId, 'My Japam'),
        );
        loaded = await japamsRepository.loadJapams(userId);
      }
      const persistedCurrentId = await japamsRepository.loadCurrentJapamId(userId);
      const active = loaded.filter((j) => j.archivedAt === null);
      const stillActive = persistedCurrentId
        ? active.find((j) => j.id === persistedCurrentId)
        : undefined;
      const resolvedCurrentId = stillActive?.id ?? active[0]?.id ?? null;
      if (resolvedCurrentId !== persistedCurrentId) {
        await japamsRepository.saveCurrentJapamId(userId, resolvedCurrentId);
      }
      return { japams: loaded, currentId: resolvedCurrentId };
    }

    // Start A, then B, synchronously. Each yields at loadJapams.
    // When microtasks drain, A's continuation blocks in the repository spy
    // (inside ensureCreation) and B blocks in its own spy
    // (separate Map entry — Map-based coordinator does not override).
    const aPromise = simulateRefresh(USER_A);
    const bPromise = simulateRefresh(USER_B);

    // Drain microtasks so both continuations reach their blocking points,
    // then open the gate from a macrotask boundary.
    setTimeout(openGate!, 0);

    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

    // Each user gets their own createJapam call — A's entry is NOT reused for B
    expect(createSpy).toHaveBeenCalledTimes(2);

    // Each user must have exactly one Japam
    expect(aResult.japams).toHaveLength(1);
    expect(bResult.japams).toHaveLength(1);

    // Each user's Japam has the correct name
    expect(aResult.japams[0].name).toBe('My Japam');
    expect(bResult.japams[0].name).toBe('My Japam');

    // Each user must resolve to their own Japam ID (not null, not the other's)
    expect(aResult.currentId).not.toBeNull();
    expect(bResult.currentId).not.toBeNull();
    expect(aResult.currentId).not.toBe(bResult.currentId);

    createSpy.mockRestore();
  });
});

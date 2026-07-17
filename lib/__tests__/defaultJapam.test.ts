import AsyncStorage from '@react-native-async-storage/async-storage';
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
    const CUID = 'concurrent-user';
    let createCallCount = 0;

    const origCreate = japamsRepository.createJapam;
    const createSpy = jest.spyOn(japamsRepository, 'createJapam').mockImplementation(
      async (userId, name) => {
        createCallCount++;
        // Simulate a slow creation so concurrent callers overlap
        await new Promise((resolve) => setTimeout(resolve, 50));
        return origCreate(userId, name);
      },
    );

    const promiseRef: { current: Promise<void> | null } = { current: null };
    const waitersRef = { current: 0 };

    async function simulateRefresh(): Promise<{
      japams: Japam[];
      currentId: string | null;
    }> {
      let loaded = await japamsRepository.loadJapams(CUID);
      if (loaded.filter((j) => j.archivedAt === null).length === 0 && CUID) {
        if (!promiseRef.current) {
          promiseRef.current = japamsRepository
            .createJapam(CUID, 'My Japam')
            .then(() => {})
            .catch(() => {});
        }
        waitersRef.current++;
        try {
          await promiseRef.current;
          loaded = await japamsRepository.loadJapams(CUID);
        } finally {
          waitersRef.current--;
          if (waitersRef.current <= 0) promiseRef.current = null;
        }
      }
      const persistedCurrentId = await japamsRepository.loadCurrentJapamId(CUID);
      const active = loaded.filter((j) => j.archivedAt === null);
      const stillActive = persistedCurrentId
        ? active.find((j) => j.id === persistedCurrentId)
        : undefined;
      const resolvedCurrentId = stillActive?.id ?? active[0]?.id ?? null;
      if (resolvedCurrentId !== persistedCurrentId) {
        await japamsRepository.saveCurrentJapamId(CUID, resolvedCurrentId);
      }
      return { japams: loaded, currentId: resolvedCurrentId };
    }

    const results = await Promise.all([
      simulateRefresh(),
      simulateRefresh(),
      simulateRefresh(),
    ]);

    expect(createCallCount).toBe(1);
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
    const USER_A = 'user-a';
    const USER_B = 'user-b';
    let createCallCount = 0;
    // Track which userId each createJapam call was made for
    const createdFor: string[] = [];

    const origCreate = japamsRepository.createJapam;
    const createSpy = jest.spyOn(japamsRepository, 'createJapam').mockImplementation(
      async (userId, name) => {
        createCallCount++;
        if (userId) createdFor.push(userId);
        // Slow enough that a concurrent caller can enter the creation block
        // before the first creation finishes
        await new Promise((resolve) => setTimeout(resolve, 50));
        return origCreate(userId, name);
      },
    );

    // Replicate the FIXED component logic: per-user in-flight creation tracker
    const inflightRef: {
      current: { userId: string; promise: Promise<void>; waiters: number } | null;
    } = { current: null };

    async function simulateRefresh(userId: string): Promise<{
      japams: Japam[];
      currentId: string | null;
    }> {
      let loaded = await japamsRepository.loadJapams(userId);
      if (loaded.filter((j) => j.archivedAt === null).length === 0 && userId) {
        if (inflightRef.current?.userId === userId) {
          inflightRef.current.waiters++;
        } else {
          inflightRef.current = {
            userId,
            waiters: 1,
            promise: japamsRepository
              .createJapam(userId, 'My Japam')
              .then(() => {})
              .catch(() => {}),
          };
        }
        try {
          await inflightRef.current.promise;
          loaded = await japamsRepository.loadJapams(userId);
        } finally {
          if (inflightRef.current?.userId === userId) {
            inflightRef.current.waiters--;
            if (inflightRef.current.waiters <= 0) inflightRef.current = null;
          }
        }
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

    // Start A's refresh but do NOT await it yet — let it get to the in-flight state
    const aPromise = simulateRefresh(USER_A);
    // Give A's async enough time to enter the creation block and set promiseRef
    // but NOT enough for the 50ms createJapam delay to complete
    await new Promise((resolve) => setImmediate(resolve));

    // Now start B's refresh while A's createJapam is still in flight
    const bPromise = simulateRefresh(USER_B);

    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

    // The bug: only ONE createJapam was called (for USER_A)
    // USER_B never got their own creation because B reused A's promise
    expect(createCallCount).toBe(2);  // ← THIS WILL FAIL with buggy logic

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

    // Exactly one creation per user
    expect(createdFor.filter((id) => id === USER_A)).toHaveLength(1);
    expect(createdFor.filter((id) => id === USER_B)).toHaveLength(1);

    createSpy.mockRestore();
  });
});

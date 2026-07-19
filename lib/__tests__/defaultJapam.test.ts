import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDefaultJapamCreationCoordinator } from '../defaultJapamCreationCoordinator';
import { type Japam } from '../japams';
import * as japamsRepository from '../japamsRepository';

const mockGetSession = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

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
const fetchMock = jest.fn();

(global as any).fetch = fetchMock;

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errorJson = (status: number, body: unknown) => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const makeJapam = (overrides: Partial<Japam> = {}): Japam => ({
  id: 'existing-1',
  userId: UID,
  name: 'Gayatri',
  syncStatus: 'synced',
  displayOrder: null,
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T10:00:00.000Z',
  archivedAt: null,
  ...overrides,
});

describe('default Japam — repository-level behavior', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    fetchMock.mockReset();
    mockGetSession.mockReset();
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
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

  it('creates a Japam online and syncs the same UUID remotely', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return okJson([{ id: body.id }]);
    });

    const result = await japamsRepository.createJapam(UID, 'My Japam');

    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rest/v1/japams?on_conflict=id');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-token' });
    const body = JSON.parse(String(init.body));
    expect(body.id).toBe(result!.created.id);
    expect(body.user_id).toBe(UID);
    expect(result!.created.syncStatus).toBe('synced');
  });

  it('creates a Japam offline and leaves it pending locally', async () => {
    const result = await japamsRepository.createJapam(UID, 'My Japam');
    expect(result).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result!.created.syncStatus).toBe('pending');
  });

  it('reconnect retries pending Japams and marks them synced', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'pending-1', name: 'Gayatri', syncStatus: 'pending' })]);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null });
    fetchMock
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson([{ id: 'pending-1' }]));

    const loaded = await japamsRepository.loadJapams(UID);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].syncStatus).toBe('synced');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rename syncs remotely without changing UUID', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'rename-1', syncStatus: 'synced' })]);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null });
    fetchMock.mockResolvedValue(okJson([{ id: 'rename-1' }]));

    const updated = await japamsRepository.renameJapam(UID, 'rename-1', 'Sri Gayatri');

    expect(updated.find((j) => j.id === 'rename-1')?.name).toBe('Sri Gayatri');
    expect(updated.find((j) => j.id === 'rename-1')?.syncStatus).toBe('synced');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.id).toBe('rename-1');
    expect(body.name).toBe('Sri Gayatri');
  });

  it('archive syncs archived_at remotely', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'archive-1', syncStatus: 'synced' })]);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null });
    fetchMock.mockResolvedValue(okJson([{ id: 'archive-1' }]));

    const updated = await japamsRepository.archiveJapam(UID, 'archive-1');

    expect(updated.find((j) => j.id === 'archive-1')?.archivedAt).toBeTruthy();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.id).toBe('archive-1');
    expect(body.archived_at).toBeTruthy();
  });

  it('restore clears archived_at remotely', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'restore-1', archivedAt: '2026-07-07T00:00:00.000Z', syncStatus: 'synced' })]);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null });
    fetchMock.mockResolvedValue(okJson([{ id: 'restore-1' }]));

    const updated = await japamsRepository.restoreJapam(UID, 'restore-1');

    expect(updated.find((j) => j.id === 'restore-1')?.archivedAt).toBeNull();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.id).toBe('restore-1');
    expect(body.archived_at).toBeNull();
  });

  it('remote failure leaves the local Japam intact and marks it failed', async () => {
    await japamsRepository.saveJapams(UID, [makeJapam({ id: 'failed-1', syncStatus: 'synced' })]);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null });
    fetchMock.mockResolvedValue(errorJson(500, { message: 'boom' }));

    const updated = await japamsRepository.renameJapam(UID, 'failed-1', 'Still Local');

    const local = updated.find((j) => j.id === 'failed-1');
    expect(local?.name).toBe('Still Local');
    expect(local?.syncStatus).toBe('failed');
    const raw = await AsyncStorage.getItem('userJapams:auth-user-123');
    const stored = JSON.parse(raw || '[]');
    expect(stored.find((j: Japam) => j.id === 'failed-1')?.name).toBe('Still Local');
  });
});

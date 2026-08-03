const mockSupabase = {
  from: jest.fn(),
  rpc: jest.fn(),
};

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

jest.mock('../supabase', () => ({
  supabase: mockSupabase,
}));

/* eslint-disable import/first -- jest.mock() must precede imports; Jest hoists mock calls above import lines */
import {
  syncJapam,
  createJapam,
  ensureDefaultJapam,
  renameJapam,
  archiveJapam,
  restoreJapam,
  deleteJapam,
  loadJapams,
  reconcileAllJapams,
  ensureJapamSyncedForHistory,
} from '../japamsRepository';
import { type Japam } from '../japams';
import { uuidV5 } from '../deterministicUuid';
import AsyncStorage from '@react-native-async-storage/async-storage';
/* eslint-enable import/first */

const UID = 'user-123';
const UID_OTHER = 'user-999';
const NOW = '2026-07-22T10:00:00.000Z';
const DEFAULT_JAPAM_UUID_NAMESPACE = '62f5824e-58fd-5d39-9f87-1f761082d8e3';

const JAPAM_ID_A = '550e8400-e29b-41d4-a716-446655440000';

const makeJapam = (overrides: Partial<Japam> = {}): Japam => ({
  id: JAPAM_ID_A,
  userId: UID,
  name: 'Gayatri',
  displayOrder: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...overrides,
});

const mockUpsert = jest.fn();
const mockSelect = jest.fn();
const mockTombstoneSelect = jest.fn();
const mockEq = jest.fn();
const mockOrder = jest.fn();
const mockTombstoneEq = jest.fn();
const mockTombstoneOrder = jest.fn();
const mockFrom = mockSupabase.from as jest.Mock;
const mockRpc = mockSupabase.rpc as jest.Mock;
let deleteRpcResponse: { data: DeleteRpcRow[]; error: unknown } = {
  data: [],
  error: null,
};
let restoreRpcResponse: { data: RestoreRpcRow[]; error: unknown } = {
  data: [],
  error: null,
};
let usageRpcResponses: Record<string, { data: JapamUsageRpcRow[]; error: unknown }> = {};
// Pending adoption marker queue, modeling the two-phase peek + ack RPCs:
//   - get_pending_japam_adoption(p_user_id) returns the caller's OLDEST marker for
//     EXACTLY p_user_id WITHOUT deleting it
//   - acknowledge_pending_japam_adoption(p_user_id, p_marker_id) validates the
//     caller, then deletes the marker with that exact id (and belonging to that
//     exact user_id). An empty queue, a peek for a user with no marker, or an ack
//     against a marker that has already been ack'd returns zero rows
//     (data: null), matching the deployed PL/pgSQL.
let pendingAdoptionQueue: { marker_id: string; japam_id: string; user_id: string }[] = [];
let adoptionPeekError: { code: string; message: string } | null = null;
let adoptionAckError: { code: string; message: string } | null = null;

const zeroUsageResponse = (japamId: string): { data: JapamUsageRpcRow[]; error: unknown } => ({
  data: [{
    japam_id: japamId,
    name: 'My Japam',
    archived_at: null,
    history_count: 0,
    group_ref_count: 0,
  }],
  error: null,
});

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

let markerIdCounter = 0;
const nextMarkerId = () => {
  markerIdCounter += 1;
  return `marker-${markerIdCounter}`;
};
const mockPendingAdoption = (japamId: string, userId = UID) => {
  pendingAdoptionQueue = [...pendingAdoptionQueue, { marker_id: nextMarkerId(), japam_id: japamId, user_id: userId }];
};
const mockAdoptionPeekError = (code: string, message: string) => {
  adoptionPeekError = { code, message };
};
const mockAdoptionAckError = (code: string, message: string) => {
  adoptionAckError = { code, message };
};
const peekAdoptionRpc = (userId: unknown) => {
  if (adoptionPeekError) {
    const err = adoptionPeekError;
    adoptionPeekError = null;
    return Promise.resolve({ data: null, error: err });
  }
  const owned = pendingAdoptionQueue.filter((m) => m.user_id === userId);
  if (owned.length === 0) {
    return Promise.resolve({ data: null, error: null });
  }
  // Oldest first, WITHOUT deleting. The client must call ack to remove it.
  const head = owned[0];
  return Promise.resolve({ data: [{ marker_id: head.marker_id, japam_id: head.japam_id }], error: null });
};
const acknowledgeAdoptionRpc = (userId: unknown, markerId: unknown) => {
  if (adoptionAckError) {
    const err = adoptionAckError;
    adoptionAckError = null;
    return Promise.resolve({ data: null, error: err });
  }
  if (typeof userId !== 'string' || typeof markerId !== 'string') {
    return Promise.resolve({ data: 0, error: null });
  }
  // Acknowledge removes exactly the (user, marker) pair — matching the deployed SQL
  // `delete ... where id = p_marker_id and user_id = p_user_id`.
  const before = pendingAdoptionQueue.length;
  pendingAdoptionQueue = pendingAdoptionQueue.filter(
    (m) => !(m.user_id === userId && m.marker_id === markerId),
  );
  const deleted = before - pendingAdoptionQueue.length;
  return Promise.resolve({ data: deleted, error: null });
};

const makeRemoteJapam = (overrides: Partial<{
  id: string;
  user_id: string;
  name: string;
  display_order: number | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}> = {}) => ({
  id: JAPAM_ID_A,
  user_id: UID,
  name: 'Gayatri',
  display_order: null,
  created_at: NOW,
  updated_at: NOW,
  archived_at: null,
  ...overrides,
});

const mockRemoteJapams = (rows: ReturnType<typeof makeRemoteJapam>[], error: unknown = null) => {
  mockOrder.mockResolvedValue({ data: rows, error });
};

const mockRemoteDeletedJapams = (rows: { japam_id: string }[] = [], error: unknown = null) => {
  mockTombstoneOrder.mockResolvedValue({ data: rows, error });
};

type DeleteRpcRow = {
  deleted_japam_id: string;
  scoped_history_deleted?: number;
  legacy_history_deleted?: number;
  tombstones_written?: number;
  ambiguous_legacy_count?: number;
};

type RestoreRpcRow = {
  restored_japam_id: string;
  tombstones_deleted?: number;
};

type JapamUsageRpcRow = {
  japam_id: string;
  name: string;
  archived_at: string | null;
  history_count: number;
  group_ref_count: number;
};

const mockRemoteDelete = (
  rows: DeleteRpcRow[] = [{ deleted_japam_id: JAPAM_ID_A }],
  error: unknown = null,
) => {
  deleteRpcResponse = { data: rows, error };
};

const mockRemoteRestore = (
  rows: RestoreRpcRow[] = [{ restored_japam_id: JAPAM_ID_A }],
  error: unknown = null,
) => {
  restoreRpcResponse = { data: rows, error };
};

const mockRemoteJapamUsage = (
  japamId: string,
  row: Partial<JapamUsageRpcRow> = {},
  error: unknown = null,
) => {
  usageRpcResponses[japamId] = {
    data: [{
      japam_id: japamId,
      name: row.name ?? 'My Japam',
      archived_at: row.archived_at ?? null,
      history_count: row.history_count ?? 0,
      group_ref_count: row.group_ref_count ?? 0,
    }],
    error,
  };
};

beforeEach(async () => {
  await AsyncStorage.clear();
  mockUpsert.mockReset();
  mockRpc.mockReset();
  mockSelect.mockReset();
  mockTombstoneSelect.mockReset();
  mockEq.mockReset();
  mockTombstoneEq.mockReset();
  mockOrder.mockReset();
  mockTombstoneOrder.mockReset();
  mockSelect.mockReturnValue({ eq: mockEq });
  mockEq.mockReturnValue({ order: mockOrder });
  mockTombstoneSelect.mockReturnValue({ eq: mockTombstoneEq });
  mockTombstoneEq.mockReturnValue({ order: mockTombstoneOrder });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'japams') {
      return { upsert: mockUpsert, select: mockSelect };
    }
    if (table === 'deleted_japams') {
      return { select: mockTombstoneSelect };
    }
    return { select: mockSelect };
  });
  mockRpc.mockImplementation((rpcName: string, params?: { p_japam_id?: string; p_user_id?: string; p_marker_id?: string }) => {
    if (rpcName === 'delete_owned_japam') return Promise.resolve(deleteRpcResponse);
    if (rpcName === 'restore_owned_japam') return Promise.resolve(restoreRpcResponse);
    if (rpcName === 'get_pending_japam_adoption') {
      const userId = (params as { p_user_id?: unknown } | undefined)?.p_user_id;
      return peekAdoptionRpc(userId);
    }
    if (rpcName === 'acknowledge_pending_japam_adoption') {
      const ackParams = params as { p_user_id?: unknown; p_marker_id?: unknown } | undefined;
      return acknowledgeAdoptionRpc(ackParams?.p_user_id, ackParams?.p_marker_id);
    }
    if (rpcName === 'get_owned_japam_usage') {
      const japamId = params?.p_japam_id ?? JAPAM_ID_A;
      return Promise.resolve(usageRpcResponses[japamId] ?? zeroUsageResponse(japamId));
    }
    return Promise.resolve({ data: null, error: null });
  });
  mockRemoteJapams([]);
  mockRemoteDeletedJapams([]);
  mockRemoteDelete();
  mockRemoteRestore();
  usageRpcResponses = {};
pendingAdoptionQueue = [];
adoptionPeekError = null;
adoptionAckError = null;
markerIdCounter = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('syncJapam (unit)', () => {
  it('returns false when userId is empty', async () => {
    const result = await syncJapam('', makeJapam());
    expect(result).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns false when japam.userId mismatches', async () => {
    const result = await syncJapam(UID, makeJapam({ userId: UID_OTHER }));
    expect(result).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('succeeds when japam.userId is null with valid explicit userId', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const result = await syncJapam(UID, makeJapam({ userId: null }));
    expect(result).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith(
      { id: JAPAM_ID_A, user_id: UID, name: 'Gayatri', archived_at: null },
      { onConflict: 'id' },
    );
  });

  it('sends explicit userId as user_id', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await syncJapam(UID, makeJapam());
    expect(mockUpsert.mock.calls[0][0].user_id).toBe(UID);
  });

  it('calls supabase.from("japams")', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await syncJapam(UID, makeJapam());
    expect(mockFrom).toHaveBeenCalledWith('japams');
  });

  it('passes onConflict "id"', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await syncJapam(UID, makeJapam());
    expect(mockUpsert.mock.calls[0][1]).toEqual({ onConflict: 'id' });
  });

  it('preserves UUID', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await syncJapam(UID, makeJapam());
    expect(mockUpsert.mock.calls[0][0].id).toBe(JAPAM_ID_A);
  });

  it('returns true on success', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const result = await syncJapam(UID, makeJapam());
    expect(result).toBe(true);
  });

  it('returns false and logs on RLS error', async () => {
    mockUpsert.mockResolvedValue({ error: { code: '42501', message: 'RLS violation' } });
    const result = await syncJapam(UID, makeJapam());
    expect(result).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns false on network exception', async () => {
    mockUpsert.mockRejectedValue(new Error('fetch failed'));
    const result = await syncJapam(UID, makeJapam());
    expect(result).toBe(false);
  });

  it('blocks tombstoned Japams before upsert', async () => {
    const tombstoned = makeJapam({ id: 'tombstoned-japam' });
    await AsyncStorage.setItem(`deletedJapams:${UID}`, JSON.stringify([tombstoned.id]));

    const result = await syncJapam(UID, tombstoned);

    expect(result).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockUpsert.mockRejectedValue('unknown error');
    await expect(syncJapam(UID, makeJapam())).resolves.toBe(false);
  });
});

describe('ensureJapamSyncedForHistory', () => {
  it('confirms the selected local Japam is upserted before history upload proceeds', async () => {
    const japam = makeJapam({ id: 'history-japam-1', name: 'Fresh Japam' });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([japam]));
    mockUpsert.mockResolvedValue({ error: null });

    const result = await ensureJapamSyncedForHistory(UID, japam.id);

    expect(result).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith(
      { id: japam.id, user_id: UID, name: 'Fresh Japam', archived_at: null },
      { onConflict: 'id' },
    );
  });

  it('blocks history upload when the selected Japam is not available locally', async () => {
    mockUpsert.mockResolvedValue({ error: null });

    const result = await ensureJapamSyncedForHistory(UID, 'missing-japam');

    expect(result).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('blocks history upload when only a remote tombstone exists', async () => {
    const japam = makeJapam({ id: 'remote-only-tombstone', name: 'Remote Tombstone' });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([japam]));
    mockRemoteDeletedJapams([{ japam_id: japam.id }]);

    const result = await ensureJapamSyncedForHistory(UID, japam.id);

    expect(result).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('fails closed when remote tombstone fetch is unavailable', async () => {
    const japam = makeJapam({ id: 'tombstone-fetch-failure', name: 'Tombstone Failure' });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([japam]));
    mockRemoteDeletedJapams([], { code: '500', message: 'outage' });

    await expect(syncJapam(UID, japam)).resolves.toBe(false);
    await expect(ensureJapamSyncedForHistory(UID, japam.id)).resolves.toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('keeps history pending on an initial Japam sync failure and allows a later retry', async () => {
    const japam = makeJapam({ id: 'retry-japam', name: 'Retry Japam' });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([japam]));
    mockUpsert
      .mockResolvedValueOnce({ error: { code: 'NETWORK', message: 'temporarily unavailable' } })
      .mockResolvedValueOnce({ error: null });

    await expect(ensureJapamSyncedForHistory(UID, japam.id)).resolves.toBe(false);
    await expect(ensureJapamSyncedForHistory(UID, japam.id)).resolves.toBe(true);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  it('rejects tombstoned Japams before history sync upsert', async () => {
    const japam = makeJapam({ id: 'history-tombstone-japam', name: 'History Tombstone' });
    await AsyncStorage.setItem(`deletedJapams:${UID}`, JSON.stringify([japam.id]));

    const result = await ensureJapamSyncedForHistory(UID, japam.id);

    expect(result).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('createJapam lifecycle sync', () => {
  it('triggers exactly one sync after create', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const result = await createJapam(UID, 'NewJapam');
    await flushMicrotasks();
    expect(result).not.toBeNull();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].name).toBe('NewJapam');
  });

  it('does not sync when userId is null (guest/anonymous)', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await createJapam(null, 'GuestJapam');
    await flushMicrotasks();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('UUID remains unchanged after create', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const result = await createJapam(UID, 'KeepId');
    await flushMicrotasks();
    expect(mockUpsert.mock.calls[0][0].id).toBe(result!.created.id);
  });
});

describe('ensureDefaultJapam', () => {
  it('empty local storage + existing remote canonical adopts remote Japam and creates nothing', async () => {
    const remote = makeRemoteJapam({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'My Japam',
      created_at: '2026-07-20T00:00:00.000Z',
    });
    mockRemoteJapams([remote]);

    const result = await ensureDefaultJapam(UID);
    await flushMicrotasks();

    expect(result.japams).toHaveLength(1);
    expect(result.japams[0].id).toBe(remote.id);
    expect(result.currentJapamId).toBe(remote.id);
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect((await loadJapams(UID))[0].id).toBe(remote.id);
  });

  it('does not create a default when remote state is unknown', async () => {
    mockRemoteJapams([], { code: '401', message: 'Unauthorized' });

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toEqual([]);
    expect(result.currentJapamId).toBeNull();
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(await loadJapams(UID)).toEqual([]);
  });

  it('Sarada regression: restores the archived canonical My Japam and retires only the empty active conflict', async () => {
    const canonical = makeJapam({
      id: 'sarada-canonical',
      name: 'My Japam',
      archivedAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const conflict = makeJapam({
      id: 'sarada-conflict',
      name: 'My Japam',
      createdAt: '2026-07-29T02:22:09.527Z',
      updatedAt: '2026-07-29T02:22:09.527Z',
    });
    const historyRaw = JSON.stringify([
      {
        completionId: 'sarada-history-1',
        userId: UID,
        date: '2026-07-22T12:00:00.000Z',
        malas: 1,
        totalCount: 108,
        japamId: canonical.id,
        japamName: canonical.name,
      },
    ]);

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([canonical, conflict]));
    await AsyncStorage.setItem(`deletedJapams:${UID}`, JSON.stringify([canonical.id]));
    await AsyncStorage.setItem('history', historyRaw);
    mockRemoteJapams([]);
    mockRemoteDeletedJapams([{ japam_id: canonical.id }]);
    mockRemoteJapamUsage(canonical.id, { history_count: 506, group_ref_count: 1 });
    mockRemoteJapamUsage(conflict.id, { history_count: 0, group_ref_count: 0 });
    mockRemoteRestore([{ restored_japam_id: canonical.id }]);

    const result = await ensureDefaultJapam(UID);

    expect(result.created).toBeNull();
    expect(result.currentJapamId).toBe(canonical.id);
    expect(result.japams.map((j) => ({ id: j.id, archivedAt: j.archivedAt }))).toEqual([
      { id: canonical.id, archivedAt: null },
    ]);
    const storedJapams = JSON.parse((await AsyncStorage.getItem(`userJapams:${UID}`)) ?? '[]') as Array<{ id: string; archivedAt: string | null }>;
    expect(storedJapams).toHaveLength(1);
    expect(storedJapams[0]).toMatchObject({ id: canonical.id, archivedAt: null });
    expect(await AsyncStorage.getItem('history')).toBe(historyRaw);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(canonical.id);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('restore_owned_japam', { p_japam_id: canonical.id });
  });

  it('does not create a default while deleted_japams fetch is unavailable, then still refuses a tombstoned default on retry', async () => {
    const tombstonedDefaultId = uuidV5(`${UID}:default-japam`, DEFAULT_JAPAM_UUID_NAMESPACE);

    mockRemoteJapams([]);
    mockRemoteDeletedJapams([], { code: '500', message: 'Temporary outage' });
    const first = await ensureDefaultJapam(UID);

    expect(first.japams).toEqual([]);
    expect(first.currentJapamId).toBeNull();
    expect(first.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();

    mockRemoteJapams([]);
    mockRemoteDeletedJapams([{ japam_id: tombstonedDefaultId }]);
    const second = await ensureDefaultJapam(UID);

    expect(second.japams).toEqual([]);
    expect(second.currentJapamId).toBeNull();
    expect(second.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('repairs a persisted tombstoned current Japam to the sole active remote Japam', async () => {
    const archivedCurrent = makeRemoteJapam({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'My Japam',
      created_at: '2026-07-19T00:00:00.000Z',
      archived_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    });
    const active = makeRemoteJapam({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Govinda',
      created_at: '2026-07-20T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`currentJapamId:${UID}`, archivedCurrent.id);
    mockRemoteJapams([archivedCurrent, active]);
    mockRemoteDeletedJapams([{ japam_id: archivedCurrent.id }]);

    const result = await ensureDefaultJapam(UID);

    expect(result.currentJapamId).toBe(active.id);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(active.id);
    expect(result.japams.map((j) => j.id)).toEqual([active.id]);
  });

  it('stale web cache cannot recreate a deleted My Japam once the remote tombstone is known', async () => {
    const tombstonedDefaultId = uuidV5(`${UID}:default-japam`, DEFAULT_JAPAM_UUID_NAMESPACE);
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([
      makeJapam({ id: tombstonedDefaultId, name: 'My Japam', archivedAt: '2026-07-22T00:00:00.000Z' }),
    ]));
    mockRemoteJapams([]);
    mockRemoteDeletedJapams([{ japam_id: tombstonedDefaultId }]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toEqual([]);
    expect(result.currentJapamId).toBeNull();
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(await loadJapams(UID)).toEqual([]);
  });

  it('genuine new user still gets exactly one default when tombstones are known', async () => {
    mockRemoteJapams([]);
    mockRemoteDeletedJapams([]);

    const result = await ensureDefaultJapam(UID);
    await flushMicrotasks();

    expect(result.created).not.toBeNull();
    expect(result.japams).toHaveLength(1);
    expect(result.currentJapamId).toBe(result.created!.id);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('a later refresh retries successfully after a remote failure', async () => {
    const remote = makeRemoteJapam({
      id: '12121212-1212-4121-8121-121212121212',
      name: 'My Japam',
      created_at: '2026-07-20T00:00:00.000Z',
    });

    mockRemoteJapams([], { code: '500', message: 'Temporary outage' });
    const first = await ensureDefaultJapam(UID);
    expect(first.currentJapamId).toBeNull();
    expect(first.created).toBeNull();
    expect(await loadJapams(UID)).toEqual([]);

    mockRemoteJapams([remote]);
    const second = await ensureDefaultJapam(UID);

    expect(second.currentJapamId).toBe(remote.id);
    expect(second.created).toBeNull();
    expect(second.japams).toHaveLength(1);
    expect(second.japams[0].id).toBe(remote.id);
  });

  it('two concurrent clients for the same new user converge on the same deterministic default id and one remote row', async () => {
    mockRemoteJapams([]);
    mockUpsert.mockResolvedValue({ error: null });

    const [first, second] = await Promise.all([
      ensureDefaultJapam(UID),
      ensureDefaultJapam(UID),
    ]);
    await flushMicrotasks();

    expect(first.currentJapamId).toBe(second.currentJapamId);
    expect(first.currentJapamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const stored = await loadJapams(UID);
    expect(stored.map((j) => j.id)).toEqual([first.currentJapamId]);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].id).toBe(first.currentJapamId);
  });

  it('different users receive different deterministic default ids', async () => {
    mockRemoteJapams([]);
    mockUpsert.mockResolvedValue({ error: null });

    const first = await ensureDefaultJapam(UID);
    const second = await ensureDefaultJapam(UID_OTHER);
    await flushMicrotasks();

    expect(first.currentJapamId).not.toBeNull();
    expect(second.currentJapamId).not.toBeNull();
    expect(first.currentJapamId).not.toBe(second.currentJapamId);
  });

  it('adopts an existing remote My Japam instead of creating another', async () => {
    const remote = makeRemoteJapam({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'My Japam',
      created_at: '2026-07-20T00:00:00.000Z',
    });
    mockRemoteJapams([remote]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toHaveLength(1);
    expect(result.japams[0].id).toBe(remote.id);
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('existing manual active Japam is adopted; no default is added, renamed, or removed', async () => {
    const manual = makeJapam({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Govinda',
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([manual]));
    mockRemoteJapams([]);

    const result = await ensureDefaultJapam(UID);
    await flushMicrotasks();

    expect(result.japams).toEqual([manual]);
    expect(result.currentJapamId).toBe(manual.id);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('preserves differently named offline Japams', async () => {
    const manual = makeJapam({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Govinda',
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([manual]));
    mockRemoteJapams([]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toEqual([manual]);
    expect(result.currentJapamId).toBe(manual.id);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('valid persisted current selection remains selected', async () => {
    const older = makeRemoteJapam({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Older',
      created_at: '2026-07-18T00:00:00.000Z',
    });
    const selected = makeRemoteJapam({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Selected',
      created_at: '2026-07-19T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`currentJapamId:${UID}`, selected.id);
    mockRemoteJapams([older, selected]);

    const result = await ensureDefaultJapam(UID);

    expect(result.currentJapamId).toBe(selected.id);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(selected.id);
  });

  it('invalid persisted current selection repairs to the oldest active merged Japam deterministically', async () => {
    const later = makeRemoteJapam({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Later',
      created_at: '2026-07-21T00:00:00.000Z',
    });
    const oldestById = makeRemoteJapam({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Oldest B',
      created_at: '2026-07-20T00:00:00.000Z',
    });
    const sameTimeButHigherId = makeRemoteJapam({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Oldest C',
      created_at: '2026-07-20T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`currentJapamId:${UID}`, 'missing-id');
    mockRemoteJapams([later, sameTimeButHigherId, oldestById]);

    const result = await ensureDefaultJapam(UID);

    expect(result.currentJapamId).toBe(oldestById.id);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(oldestById.id);
  });

  it('multiple existing duplicate active "My Japam" rows create no new row and return oldest selection', async () => {
    const newest = makeRemoteJapam({
      id: '99999999-9999-4999-8999-999999999999',
      name: 'My Japam',
      created_at: '2026-07-29T00:15:58.414Z',
    });
    const oldest = makeRemoteJapam({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'My Japam',
      created_at: '2026-07-21T00:04:34.432Z',
    });
    const middle = makeRemoteJapam({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'My Japam',
      created_at: '2026-07-25T06:22:37.193Z',
    });
    mockRemoteJapams([newest, middle, oldest]);

    const result = await ensureDefaultJapam(UID);
    await flushMicrotasks();

    expect(result.japams.map((j) => j.id)).toEqual([oldest.id, middle.id, newest.id]);
    expect(result.currentJapamId).toBe(oldest.id);
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('remote/local merge preserves local-only and remote-only Japams without duplicate IDs', async () => {
    const sharedLocal = makeJapam({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Local Name',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    const localOnly = makeJapam({
      id: '66666666-6666-4666-8666-666666666666',
      name: 'Local Only',
      createdAt: '2026-07-21T00:00:00.000Z',
    });
    const remoteOnly = makeRemoteJapam({
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Remote Only',
      created_at: '2026-07-22T00:00:00.000Z',
    });
    const sharedRemote = makeRemoteJapam({
      id: sharedLocal.id,
      name: 'Remote Name',
      created_at: sharedLocal.createdAt,
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([sharedLocal, localOnly]));
    mockRemoteJapams([remoteOnly, sharedRemote]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams.map((j) => j.id).sort()).toEqual([
      localOnly.id,
      remoteOnly.id,
      sharedLocal.id,
    ].sort());
    expect(result.japams.find((j) => j.id === sharedLocal.id)?.name).toBe('Remote Name');
    expect(result.japams.find((j) => j.id === remoteOnly.id)?.name).toBe('Remote Only');
  });

  it('remote archived row wins over stale local active data for the same id', async () => {
    const sharedId = '88888888-8888-4888-8888-888888888888';
    const localActive = makeJapam({
      id: sharedId,
      name: 'Stale Local',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      archivedAt: null,
    });
    const remoteArchived = makeRemoteJapam({
      id: sharedId,
      name: 'Remote Archived',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-21T00:00:00.000Z',
      archived_at: '2026-07-21T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([localActive]));
    mockRemoteJapams([remoteArchived]);

    const result = await ensureDefaultJapam(UID);
    await flushMicrotasks();

    expect(result.japams.find((j) => j.id === sharedId)?.archivedAt).toBe(remoteArchived.archived_at);
    expect(result.japams.find((j) => j.id === sharedId)?.name).toBe('Remote Archived');
    expect(result.created).not.toBeNull();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].id).toBe(result.created!.id);
    expect(mockUpsert.mock.calls[0][0].id).not.toBe(sharedId);
  });

  it('prefers a newer remote row over an older local row for the same id', async () => {
    const sharedId = '99999999-9999-4999-8999-999999999998';
    const localOlder = makeJapam({
      id: sharedId,
      name: 'Old Local',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const remoteNewer = makeRemoteJapam({
      id: sharedId,
      name: 'New Remote',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([localOlder]));
    mockRemoteJapams([remoteNewer]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toHaveLength(1);
    expect(result.japams[0].id).toBe(sharedId);
    expect(result.japams[0].name).toBe('New Remote');
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('allows a newer valid local row to win only when the remote row is not archived', async () => {
    const sharedId = 'aaaa1111-aaaa-4111-8aaa-aaaaaaaaaaaa';
    const localNewer = makeJapam({
      id: sharedId,
      name: 'New Local',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    const remoteOlder = makeRemoteJapam({
      id: sharedId,
      name: 'Old Remote',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([localNewer]));
    mockRemoteJapams([remoteOlder]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toHaveLength(1);
    expect(result.japams[0].id).toBe(sharedId);
    expect(result.japams[0].name).toBe('New Local');
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('falls back to the remote row when updatedAt is missing or invalid', async () => {
    const sharedId = 'bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbbb';
    const staleLocal = makeJapam({
      id: sharedId,
      name: 'Local Draft',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    const remoteNoValidUpdatedAt = makeRemoteJapam({
      id: sharedId,
      name: 'Remote Canonical',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: 'not-a-date',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([staleLocal]));
    mockRemoteJapams([remoteNoValidUpdatedAt]);

    const result = await ensureDefaultJapam(UID);

    expect(result.japams).toHaveLength(1);
    expect(result.japams[0].id).toBe(sharedId);
    expect(result.japams[0].name).toBe('Remote Canonical');
    expect(result.created).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('is deterministic regardless of local and remote input ordering', async () => {
    const localA = makeJapam({
      id: 'cccc1111-cccc-4111-8ccc-cccccccccccc',
      name: 'Local A',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    const localB = makeJapam({
      id: 'dddd1111-dddd-4111-8ddd-dddddddddddd',
      name: 'Local B',
      createdAt: '2026-07-21T00:00:00.000Z',
    });
    const remoteA = makeRemoteJapam({
      id: 'eeee1111-eeee-4111-8eee-eeeeeeeeeeee',
      name: 'Remote A',
      created_at: '2026-07-18T00:00:00.000Z',
    });
    const remoteB = makeRemoteJapam({
      id: 'ffff1111-ffff-4111-8fff-ffffffffffff',
      name: 'Remote B',
      created_at: '2026-07-22T00:00:00.000Z',
    });

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([localA, localB]));
    mockRemoteJapams([remoteB, remoteA]);
    const first = await ensureDefaultJapam(UID);

    await AsyncStorage.clear();
    await AsyncStorage.setItem(`userJapams:${UID_OTHER}`, JSON.stringify([localB, localA]));
    mockRemoteJapams([remoteA, remoteB]);
    const second = await ensureDefaultJapam(UID_OTHER);

    expect(first.japams.map((j) => j.id)).toEqual(second.japams.map((j) => j.id));
  });

  it('legacy null History remains byte-for-byte untouched', async () => {
    const legacyHistory = JSON.stringify([
      {
        id: 'row-1',
        userId: UID,
        japamId: null,
        japamName: null,
        totalCount: 108,
      },
    ]);
    await AsyncStorage.setItem('history', legacyHistory);
    mockRemoteJapams([]);
    mockUpsert.mockResolvedValue({ error: null });

    await ensureDefaultJapam(UID);

    expect(await AsyncStorage.getItem('history')).toBe(legacyHistory);
  });
});

describe('pending selection adoption — staging restore flow (peek + acknowledge)', () => {
  // Reproduces the exact staging scenario end-to-end at the repository contract level.
  //   - PR55 is persisted as currentJapamId (left from before My Japam was archived)
  //   - PR55 has 63 malas of history (real usage — must never be silently demoted by counts)
  //   - My Japam was archived server-side and restored OUTSIDE the client restore flow
  //     (migration / admin / pre-feature backfill), so it is now active on the server with
  //     7 malas + 1 group ref
  //   - A pending_japam_adoption marker for (user, My Japam) exists server-side — either
  //     written by `restore_owned_japam` in the same transaction as the restore, or inserted
  //     by the staging-only backfill for a Japam restored BEFORE the marker mechanism shipped
  //   - On the next refresh, get_pending_japam_adoption PEEKS the marker (no delete),
  //     the repository verifies My Japam is active, persists My Japam as currentJapamId,
  //     and only THEN calls acknowledge_pending_japam_adoption to delete the marker
  //   - If ANY step fails, the marker stays server-side; the next refresh retries the exact
  //     same sequence
  //   - Once ack'd, the marker is gone for good — a later manual user selection (back to
  //     PR55) writes PR55 to the persisted pointer and subsequent refreshes find no marker,
  //     so the manual choice is preserved
  //   - The adoption ID is taken PURELY from the marker — never inferred from History counts,
  //     group counts, names, or display order
  //   - PR55 and My Japam data are never mutated by adoption

  const MY_JAPAM_ID = 'restored-my-japam';
  const PR55_ID = 'pr55-workspace';

  const setupStagingState = async () => {
    // Server-side state: My Japam (active, restored) + PR55 (active).
    mockRemoteJapams([
      makeRemoteJapam({
        id: MY_JAPAM_ID,
        name: 'My Japam',
        created_at: '2026-07-21T00:00:00.000Z',
        updated_at: '2026-08-02T12:00:00.000Z',
        archived_at: null,
      }),
      makeRemoteJapam({
        id: PR55_ID,
        name: 'PR55',
        created_at: '2026-07-22T00:00:00.000Z',
      }),
    ]);
    mockRemoteDeletedJapams([]);
    mockRemoteJapamUsage(MY_JAPAM_ID, { name: 'My Japam', history_count: 7, group_ref_count: 1 });
    mockRemoteJapamUsage(PR55_ID, { name: 'PR55', history_count: 63, group_ref_count: 0 });

    // Client AsyncStorage carryover from before the server-side restore:
    //   - persisted current selection is PR55
    //   - cached japam list still records My Japam as archived (it hasn't synced the restore
    //     yet) — the merged-active list comes from the remote rows above
    await AsyncStorage.setItem(`currentJapamId:${UID}`, PR55_ID);
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([
      makeJapam({
        id: MY_JAPAM_ID,
        name: 'My Japam',
        createdAt: '2026-07-21T00:00:00.000Z',
        archivedAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      }),
      makeJapam({ id: PR55_ID, name: 'PR55', createdAt: '2026-07-22T00:00:00.000Z' }),
    ]));
  };

  it('restored before this feature shipped + backfill marker adopts My Japam on the next client refresh', async () => {
    await setupStagingState();
    // The staging-only backfill inserts one marker for (user, My Japam). Modeled here as
    // a single mock-pending-adoption marker.
    mockPendingAdoption(MY_JAPAM_ID);

    const result = await ensureDefaultJapam(UID);

    // Peek was called.
    expect(mockRpc).toHaveBeenCalledWith('get_pending_japam_adoption', { p_user_id: UID });
    // The persisted pointer is now on My Japam — adoption was durable BEFORE ack.
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
    // The adopted ID surfaces as the current selection.
    expect(result.currentJapamId).toBe(MY_JAPAM_ID);
    // Acknowledge was issued with the marker's id (an opaque string from the client's POV).
    expect(mockRpc).toHaveBeenCalledWith(
      'acknowledge_pending_japam_adoption',
      expect.objectContaining({ p_user_id: UID, p_marker_id: expect.any(String) }),
    );
    // Marker queue is empty after the ack.
    expect(pendingAdoptionQueue).toHaveLength(0);
  });

  it('identity consistency regression: marker stored under the stored/legacy userId is peeked and acked with the SAME userId even when auth.uid differs', async () => {
    // Scenario: the restored Japam's user_id is the client's STORED/legacy userId (UID) —
    // the value the client keeps in AsyncStorage (`currentJapamId:<uid>`). For legacy
    // Google sign-in the authenticated session's auth.uid() is a DIFFERENT UUID, so the
    // repository must not assume identity equals auth.uid(). It passes its stored userId
    // (UID) to BOTH the peek RPC and the ack RPC so the marker — keyed by the Japam's
    // actual user_id (UID) server-side — is found and removed. Markers for a different
    // user must stay invisible to the peek and untouched by the ack.
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID, UID);
    // A marker belonging to ANOTHER user sits in the same queue — it must never be peeked
    // by this caller and must not be removed by this caller's ack.
    mockPendingAdoption('other-users-marker', UID_OTHER);

    const result = await ensureDefaultJapam(UID);

    // Peek passed the STORED userId (UID) — not an auth.uid() guess.
    expect(mockRpc).toHaveBeenCalledWith('get_pending_japam_adoption', { p_user_id: UID });
    // Acknowledge passed the SAME stored userId (UID) plus the marker id.
    expect(mockRpc).toHaveBeenCalledWith(
      'acknowledge_pending_japam_adoption',
      expect.objectContaining({ p_user_id: UID, p_marker_id: expect.any(String) }),
    );
    // The caller's marker was acked; the other user's marker is untouched.
    expect(pendingAdoptionQueue).toHaveLength(1);
    expect(pendingAdoptionQueue[0]).toMatchObject({ user_id: UID_OTHER, japam_id: 'other-users-marker' });
    // Adoption surfaced My Japam for the stored user.
    expect(result.currentJapamId).toBe(MY_JAPAM_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
  });

  it('failure before persistence leaves the marker server-side and falls through to the persisted pointer; retry then succeeds', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);

    // Persist of `currentJapamId:${UID}` fails on the first ensureDefaultJapam call ONLY.
    // `saveCurrentJapamIdToStorage` swallows AsyncStorage errors silently (it never throws),
    // so we model persist failure by making setItem reject for this key once. The repository
    // re-reads the persisted key after the write to detect that the persist didn't take.
    const setItemMock = AsyncStorage.setItem as unknown as jest.Mock;
    const originalSetItem = setItemMock.getMockImplementation();
    let firstPersistFailed = false;
    setItemMock.mockImplementation(async (key: string, value: string) => {
      if (key === `currentJapamId:${UID}` && !firstPersistFailed) {
        firstPersistFailed = true;
        throw new Error('persist failed');
      }
      if (originalSetItem) await originalSetItem(key, value);
    });

    try {
      const first = await ensureDefaultJapam(UID);

      // Persist pointer NOT updated — still PR55.
      expect(first.currentJapamId).toBe(PR55_ID);
      expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(PR55_ID);
      // Peek was called but ack was NOT — persist threw before the ack step.
      expect(mockRpc).toHaveBeenCalledWith('get_pending_japam_adoption', { p_user_id: UID });
      expect(mockRpc).not.toHaveBeenCalledWith(
        'acknowledge_pending_japam_adoption',
        expect.anything(),
      );
      // Marker remains server-side for retry.
      expect(pendingAdoptionQueue).toHaveLength(1);
      // Persist failure was logged.
      expect(console.warn).toHaveBeenCalledWith(
        '[JAPAM_ADOPTION_PERSIST_FAILED]',
        expect.objectContaining({ adoptionId: MY_JAPAM_ID }),
      );

      // Retry: persist no longer fails.
      (mockRpc as jest.Mock).mockClear();
      const second = await ensureDefaultJapam(UID);

      expect(second.currentJapamId).toBe(MY_JAPAM_ID);
      expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
      expect(pendingAdoptionQueue).toHaveLength(0);
      expect(mockRpc).toHaveBeenCalledWith(
        'acknowledge_pending_japam_adoption',
        expect.objectContaining({ p_user_id: UID, p_marker_id: expect.any(String) }),
      );
    } finally {
      // Restore the original setItem impl for subsequent tests.
      setItemMock.mockImplementation(originalSetItem);
    }
  });

  it('failure after persistence but before acknowledgement safely retries: persisted pointer committed, marker remains, second refresh acks', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);
    // Persist succeeds; ONLY the ack RPC fails this first refresh.
    mockAdoptionAckError('500', 'ack outage');

    const first = await ensureDefaultJapam(UID);

    // Persisted pointer IS durably on My Japam — the persist step succeeded.
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
    // Fall-through to the persisted-pointer branch returned My Japam (because the cached
    // `persistedCurrentId` was updated to target.id before the ack attempt).
    expect(first.currentJapamId).toBe(MY_JAPAM_ID);
    // Ack failed: marker is still server-side for retry.
    expect(pendingAdoptionQueue).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[JAPAM_ADOPTION_ACK_FAILED]',
      expect.objectContaining({ markerId: expect.any(String) }),
    );

    // Retry: ack now succeeds (mockAdoptionAckError short-circuits after one error).
    (mockRpc as jest.Mock).mockClear();
    const second = await ensureDefaultJapam(UID);

    expect(second.currentJapamId).toBe(MY_JAPAM_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
    expect(pendingAdoptionQueue).toHaveLength(0);
    expect(mockRpc).toHaveBeenCalledWith(
      'acknowledge_pending_japam_adoption',
      expect.objectContaining({ p_user_id: UID, p_marker_id: expect.any(String) }),
    );
  });

  it('acknowledgement removes the marker once — after ack, the queue is empty and a redundant ack removes zero rows', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);

    const result = await ensureDefaultJapam(UID);
    expect(result.currentJapamId).toBe(MY_JAPAM_ID);
    // Queue is now empty — exactly one marker was removed by the ack.
    expect(pendingAdoptionQueue).toHaveLength(0);

    // A redundant explicit ack (e.g. a buggy retry) returns 0 rows deleted — there is
    // nothing left to remove. This matches the deployed PL/pgSQL function's `with deleted
    // as (delete ... returning 1) select count(*)` semantics.
    const redundant = await acknowledgeAdoptionRpc(UID, 'marker-no-longer-in-queue');
    expect(redundant.data).toBe(0);
    expect(redundant.error).toBeNull();
  });

  it('second refresh stays on My Japam after the marker is acked — peek returns no rows, persisted pointer wins, no re-adoption', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);

    const first = await ensureDefaultJapam(UID);
    expect(first.currentJapamId).toBe(MY_JAPAM_ID);
    expect(pendingAdoptionQueue).toHaveLength(0);

    (mockRpc as jest.Mock).mockClear();
    const second = await ensureDefaultJapam(UID);

    expect(second.currentJapamId).toBe(MY_JAPAM_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
    // Every refresh probes the queue; on this refresh it returned no rows.
    expect(mockRpc).toHaveBeenCalledWith('get_pending_japam_adoption', { p_user_id: UID });
    // Ack was NOT called — peek returned nothing.
    expect(mockRpc).not.toHaveBeenCalledWith(
      'acknowledge_pending_japam_adoption',
      expect.anything(),
    );
    // Selection is driven purely by the persisted pointer — not by a re-adoption.
    expect(second.japams.map((j) => j.id).sort()).toEqual([MY_JAPAM_ID, PR55_ID].sort());
  });

  it('preserves a later manual user selection of PR55 — once the marker is acked, no marker means the persisted pointer wins', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);

    // First refresh: adoption moves selection to My Japam and acks the marker.
    const first = await ensureDefaultJapam(UID);
    expect(first.currentJapamId).toBe(MY_JAPAM_ID);
    expect(pendingAdoptionQueue).toHaveLength(0);

    // User manually selects PR55 (taps PR55 in My Japams screen). The Context calls
    // saveCurrentJapamId directly — modeled here as a persisted-pointer write.
    await AsyncStorage.setItem(`currentJapamId:${UID}`, PR55_ID);

    // Second refresh: no marker — persisted pointer (PR55) wins.
    (mockRpc as jest.Mock).mockClear();
    const second = await ensureDefaultJapam(UID);

    expect(second.currentJapamId).toBe(PR55_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(PR55_ID);
    // Both Japams are still present and active — the manual choice doesn't damage data.
    expect(second.japams.map((j) => j.id).sort()).toEqual([MY_JAPAM_ID, PR55_ID].sort());
    expect(second.japams.find((j) => j.id === MY_JAPAM_ID)?.archivedAt).toBeNull();
    expect(second.japams.find((j) => j.id === PR55_ID)?.archivedAt).toBeNull();
  });

  it('Groups receives My Japam ID after adoption: result.currentJapamId (the input to getMyGroups) is My Japam', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);

    const result = await ensureDefaultJapam(UID);

    // The Groups screen calls getMyGroups(savedUserId, currentJapamId) using the Context's
    // currentJapamId, which is set from the same ensureDefaultJapam return value. After the
    // staging restore adoption, that ID is My Japam — so the Group members query
    // (`group_members.japam_id = <current>`) scoping shifts back to My Japam and Sarada
    // Test Group (scoped to My Japam) re-appears in-app.
    expect(result.currentJapamId).toBe(MY_JAPAM_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
  });

  it('both Japams and their data remain unchanged — adoption is a selection-only move (no archive, no tombstone, no upsert)', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);

    const result = await ensureDefaultJapam(UID);

    // Both Japams still present and active.
    expect(result.japams.map((j) => j.id).sort()).toEqual([MY_JAPAM_ID, PR55_ID].sort());
    expect(result.japams.find((j) => j.id === PR55_ID)?.archivedAt).toBeNull();
    expect(result.japams.find((j) => j.id === MY_JAPAM_ID)?.archivedAt).toBeNull();
    // No tombstones were written for either Japam.
    const tombstones = JSON.parse((await AsyncStorage.getItem(`deletedJapams:${UID}`)) ?? '[]') as string[];
    expect(tombstones).not.toContain(PR55_ID);
    expect(tombstones).not.toContain(MY_JAPAM_ID);
    // No upsert fired during this adoption refresh — adoption is a selection-only move.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('never infers selection from History/group/counts: with no marker, persisted PR55 stays current even though My Japam has usage', async () => {
    await setupStagingState();
    // No pending adoption marker — the canonical scenario where NO server-side restore marker
    // exists. Adoption MUST NOT fall back to inferring selection from History or group counts.
    // (Pending marker queue is empty by default.)

    const result = await ensureDefaultJapam(UID);

    // Peek was called (every refresh probes the queue) but returned no rows, so we fell
    // through to the persisted pointer. PR55 stays current despite My Japam having 7 malas +
    // 1 group ref — those counts were never consulted for selection.
    expect(mockRpc).toHaveBeenCalledWith('get_pending_japam_adoption', { p_user_id: UID });
    expect(result.currentJapamId).toBe(PR55_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(PR55_ID);
    // And no per-Japam usage fetch was made for selection purposes.
    expect(mockRpc).not.toHaveBeenCalledWith(
      'get_owned_japam_usage',
      expect.objectContaining({ p_japam_id: MY_JAPAM_ID }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      'get_owned_japam_usage',
      expect.objectContaining({ p_japam_id: PR55_ID }),
    );
  });

  it('ignores a marker whose target is not in the active list: marker acknowledged (stale), persisted selection preserved, selection never inferred', async () => {
    // Edge case: marker references a Japam that was archived/deleted server-side between
    // the restore writing the marker and the client consuming it. The marker is ack'd (the
    // stale one is removed so we don't retry forever) but adoption does NOT happen —
    // selection stays put.
    await setupStagingState();
    const staleAdoptionId = 'my-japam-was-re-archived';
    mockPendingAdoption(staleAdoptionId);

    const result = await ensureDefaultJapam(UID);

    // The marker was ack'd (removed) since its target is not active.
    expect(pendingAdoptionQueue).toHaveLength(0);
    // Selection stayed on PR55.
    expect(result.currentJapamId).toBe(PR55_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(PR55_ID);
    // The console warning was logged for observability.
    expect(console.warn).toHaveBeenCalledWith(
      '[JAPAM_ADOPTION_TARGET_NOT_ACTIVE]',
      expect.objectContaining({ adoptionId: staleAdoptionId }),
    );
  });

  it('fails closed on peek RPC error: keeps PR55 current and leaves the server marker for the next refresh', async () => {
    await setupStagingState();
    mockPendingAdoption(MY_JAPAM_ID);
    // Marker is queued server-side, but the peek RPC errors this refresh.
    mockAdoptionPeekError('500', 'temporary outage');

    const first = await ensureDefaultJapam(UID);

    expect(first.currentJapamId).toBe(PR55_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(PR55_ID);
    // The mock queue still holds the marker (peek error short-circuits before removal)
    // so a later refresh can retry once the outage clears.
    expect(pendingAdoptionQueue).toHaveLength(1);

    // Retry: outage cleared, marker is now peeked and acked.
    (mockRpc as jest.Mock).mockClear();
    const second = await ensureDefaultJapam(UID);

    expect(second.currentJapamId).toBe(MY_JAPAM_ID);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(MY_JAPAM_ID);
    expect(pendingAdoptionQueue).toHaveLength(0);
  });
});

describe('renameJapam lifecycle sync', () => {
  it('does not trigger sync when userId is null', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Base');
    await flushMicrotasks();
    mockUpsert.mockReset();
    await renameJapam(null, r!.created.id, 'Renamed');
    await flushMicrotasks();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('archiveJapam lifecycle sync', () => {
  it('syncs archived_at', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'ToArchive');
    await flushMicrotasks();
    mockUpsert.mockReset();
    await archiveJapam(UID, r!.created.id);
    await flushMicrotasks();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].archived_at).not.toBeNull();
  });
});

describe('restoreJapam lifecycle sync', () => {
  it('syncs archived_at = null', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'ToRestore');
    await flushMicrotasks();
    await archiveJapam(UID, r!.created.id);
    await flushMicrotasks();
    mockRemoteRestore([{ restored_japam_id: r!.created.id }]);
    mockUpsert.mockReset();
    await restoreJapam(UID, r!.created.id);
    await flushMicrotasks();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].archived_at).toBeNull();
  });

  it('restores a tombstoned archived Japam atomically and makes it current', async () => {
    const archived = makeJapam({
      id: 'restore-me',
      name: 'My Japam',
      archivedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([archived]));
    await AsyncStorage.setItem(`deletedJapams:${UID}`, JSON.stringify([archived.id]));
    mockRemoteRestore([{ restored_japam_id: archived.id }]);

    const result = await restoreJapam(UID, archived.id);

    expect(mockRpc).toHaveBeenCalledWith('restore_owned_japam', { p_japam_id: archived.id });
    expect(result.find((j) => j.id === archived.id)?.archivedAt).toBeNull();
    expect(await AsyncStorage.getItem(`deletedJapams:${UID}`)).toBe('[]');
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(archived.id);
    expect((await loadJapams(UID)).find((j) => j.id === archived.id)?.archivedAt).toBeNull();
  });
});

describe('deleteJapam lifecycle sync', () => {
  it('successfully removes an archived Japam, keeps other Japams/history unchanged, and prevents refresh resurrection', async () => {
    const active = makeJapam({ id: 'active-japam', name: 'Active Japam' });
    const archived = makeJapam({
      id: 'archived-japam',
      name: 'Archived Japam',
      archivedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    const historyRaw = JSON.stringify([{ completionId: 'keep-history', japamId: archived.id }]);
    const tombstonesRaw = JSON.stringify(['keep-tombstone']);

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([active, archived]));
    await AsyncStorage.setItem(`currentJapamId:${UID}`, active.id);
    await AsyncStorage.setItem('history', historyRaw);
    await AsyncStorage.setItem('deletedCompletions', tombstonesRaw);
    mockRemoteDelete([{ deleted_japam_id: archived.id }], null);
    mockRemoteJapams([
      makeRemoteJapam({ id: active.id, name: active.name }),
    ]);

    const result = await deleteJapam(UID, archived.id);

    expect(mockRpc).toHaveBeenCalledWith('delete_owned_japam', { p_japam_id: archived.id });
    expect(result.map((j) => j.id)).toEqual([active.id]);
    expect((await loadJapams(UID)).map((j) => j.id)).toEqual([active.id]);
    expect(await AsyncStorage.getItem(`currentJapamId:${UID}`)).toBe(active.id);
    expect(await AsyncStorage.getItem('history')).toBe(historyRaw);
    expect(await AsyncStorage.getItem('deletedCompletions')).toBe(tombstonesRaw);

    const refreshed = await ensureDefaultJapam(UID);
    expect(refreshed.japams.map((j) => j.id)).toEqual([active.id]);
  });

  it('keeps the archived Japam visible locally when remote delete returns zero rows with no error', async () => {
    const active = makeJapam({ id: 'active-japam', name: 'Active Japam' });
    const archived = makeJapam({
      id: 'archived-japam',
      name: 'Archived Japam',
      archivedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    const historyRaw = JSON.stringify([{ completionId: 'keep-history', japamId: archived.id }]);
    const tombstonesRaw = JSON.stringify(['keep-tombstone']);

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([active, archived]));
    await AsyncStorage.setItem('history', historyRaw);
    await AsyncStorage.setItem('deletedCompletions', tombstonesRaw);
    mockRemoteDelete([], null);
    mockRemoteJapams([
      makeRemoteJapam({ id: active.id, name: active.name }),
      makeRemoteJapam({
        id: archived.id,
        name: archived.name,
        archived_at: archived.archivedAt,
        updated_at: archived.updatedAt,
        created_at: archived.createdAt,
      }),
    ]);

    const result = await deleteJapam(UID, archived.id);

    expect(result.map((j) => j.id)).toEqual([active.id, archived.id]);
    expect((await loadJapams(UID)).map((j) => j.id)).toEqual([active.id, archived.id]);
    expect(await AsyncStorage.getItem('history')).toBe(historyRaw);
    expect(await AsyncStorage.getItem('deletedCompletions')).toBe(tombstonesRaw);

    const refreshed = await ensureDefaultJapam(UID);
    expect(refreshed.japams.map((j) => j.id)).toEqual([active.id, archived.id]);
    expect(console.warn).toHaveBeenCalledWith('[JAPAM_REMOTE_DELETE_FAILED]', {
      japamId: archived.id,
      code: 'UNEXPECTED_RESPONSE',
      message: 'Delete did not return exactly one matching Japam ID',
    });
  });

  it('keeps the archived Japam visible locally when remote delete reports an unexpected count', async () => {
    const active = makeJapam({ id: 'active-japam', name: 'Active Japam' });
    const archived = makeJapam({
      id: 'archived-japam',
      name: 'Archived Japam',
      archivedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    const historyRaw = JSON.stringify([{ completionId: 'keep-history', japamId: archived.id }]);
    const tombstonesRaw = JSON.stringify(['keep-tombstone']);

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([active, archived]));
    await AsyncStorage.setItem('history', historyRaw);
    await AsyncStorage.setItem('deletedCompletions', tombstonesRaw);
    mockRemoteDelete([
      { deleted_japam_id: archived.id },
      { deleted_japam_id: archived.id },
    ], null);

    const result = await deleteJapam(UID, archived.id);

    expect(result.map((j) => j.id)).toEqual([active.id, archived.id]);
    expect((await loadJapams(UID)).map((j) => j.id)).toEqual([active.id, archived.id]);
    expect(await AsyncStorage.getItem('history')).toBe(historyRaw);
    expect(await AsyncStorage.getItem('deletedCompletions')).toBe(tombstonesRaw);
    expect(console.warn).toHaveBeenCalledWith('[JAPAM_REMOTE_DELETE_FAILED]', {
      japamId: archived.id,
      code: 'UNEXPECTED_RESPONSE',
      message: 'Delete did not return exactly one matching Japam ID',
    });
  });

  it('accepts the legacy five-column delete RPC response shape', async () => {
    const active = makeJapam({ id: 'active-japam', name: 'Active Japam' });
    const archived = makeJapam({
      id: 'archived-japam',
      name: 'Archived Japam',
      archivedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([active, archived]));
    mockRemoteDelete([
      {
        deleted_japam_id: archived.id,
        scoped_history_deleted: 0,
        legacy_history_deleted: 0,
        tombstones_written: 1,
        ambiguous_legacy_count: 0,
      },
    ], null);

    const result = await deleteJapam(UID, archived.id);

    expect(result.map((j) => j.id)).toEqual([active.id]);
    expect(mockRpc).toHaveBeenCalledWith('delete_owned_japam', { p_japam_id: archived.id });
  });

  it('keeps the archived Japam visible locally when remote delete errors', async () => {
    const active = makeJapam({ id: 'active-japam', name: 'Active Japam' });
    const archived = makeJapam({
      id: 'archived-japam',
      name: 'Archived Japam',
      archivedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    const historyRaw = JSON.stringify([{ completionId: 'keep-history', japamId: archived.id }]);
    const tombstonesRaw = JSON.stringify(['keep-tombstone']);

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([active, archived]));
    await AsyncStorage.setItem('history', historyRaw);
    await AsyncStorage.setItem('deletedCompletions', tombstonesRaw);
    mockRemoteDelete([], { code: '42501', message: 'RLS violation' });

    const result = await deleteJapam(UID, archived.id);

    expect(result.map((j) => j.id)).toEqual([active.id, archived.id]);
    expect((await loadJapams(UID)).map((j) => j.id)).toEqual([active.id, archived.id]);
    expect(await AsyncStorage.getItem('history')).toBe(historyRaw);
    expect(await AsyncStorage.getItem('deletedCompletions')).toBe(tombstonesRaw);
    expect(console.warn).toHaveBeenCalledWith('[JAPAM_REMOTE_DELETE_FAILED]', {
      japamId: archived.id,
      code: '42501',
      message: 'RLS violation',
    });
  });

  it('leaves active Japams untouched when asked to permanently delete a non-archived Japam', async () => {
    const active = makeJapam({ id: 'active-japam', name: 'Active Japam' });
    const other = makeJapam({ id: 'other-japam', name: 'Other Japam' });
    const historyRaw = JSON.stringify([{ completionId: 'keep-history', japamId: active.id }]);

    await AsyncStorage.setItem(`userJapams:${UID}`, JSON.stringify([active, other]));
    await AsyncStorage.setItem('history', historyRaw);

    const result = await deleteJapam(UID, active.id);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.map((j) => j.id)).toEqual([active.id, other.id]);
    expect(await AsyncStorage.getItem('history')).toBe(historyRaw);
  });
});

describe('startup reconciliation', () => {
  it('syncs multiple Japams independently', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await createJapam(UID, 'First');
    await createJapam(UID, 'Second');
    await createJapam(UID, 'Third');
    await flushMicrotasks();
    mockUpsert.mockReset();
    mockUpsert.mockResolvedValue({ error: null });
    const result = await reconcileAllJapams(UID);
    expect(result.synced).toBe(3);
    expect(result.failed).toBe(0);
    expect(mockUpsert).toHaveBeenCalledTimes(3);
  });

  it('one failed Japam does not block others', async () => {
    let callCount = 0;
    mockUpsert.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { error: { code: 'ERROR', message: 'fail' } };
      return { error: null };
    });
    await createJapam(UID, 'Ok1');
    await createJapam(UID, 'Fail');
    await createJapam(UID, 'Ok2');
    await flushMicrotasks();
    mockUpsert.mockReset();
    let innerCall = 0;
    mockUpsert.mockImplementation(async () => {
      innerCall++;
      if (innerCall === 2) return { error: { code: 'ERROR', message: 'fail' } };
      return { error: null };
    });
    const result = await reconcileAllJapams(UID);
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(1);
    expect(mockUpsert).toHaveBeenCalledTimes(3);
  });

  it('repeated reconciliation is idempotent', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await createJapam(UID, 'Idempotent');
    await flushMicrotasks();
    mockUpsert.mockReset();
    mockUpsert.mockResolvedValue({ error: null });
    const r1 = await reconcileAllJapams(UID);
    expect(r1.synced).toBe(1);
    mockUpsert.mockReset();
    mockUpsert.mockResolvedValue({ error: null });
    const r2 = await reconcileAllJapams(UID);
    expect(r2.synced).toBe(1);
  });

  it('skips when userId is empty', async () => {
    await createJapam(null, 'GuestJapam');
    await flushMicrotasks();
    mockUpsert.mockReset();
    const result = await reconcileAllJapams('');
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('concurrency and stale-write safety', () => {
  it('serializes rapid updates with latest-state-wins semantics', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Concurrent');
    await flushMicrotasks();
    mockUpsert.mockReset();

    let callCount = 0;
    let resolveFirst: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    void renameJapam(UID, r!.created.id, 'Name_A');
    await flushMicrotasks();

    void renameJapam(UID, r!.created.id, 'Name_B');
    await flushMicrotasks();

    resolveFirst!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].name).toBe('Name_A');
    expect(mockUpsert.mock.calls[1][0].name).toBe('Name_B');
  });

  it('reconciliation prevents concurrent runs', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await createJapam(UID, 'ReconcileTest');
    await flushMicrotasks();
    mockUpsert.mockReset();
    const [, r2] = await Promise.all([
      reconcileAllJapams(UID),
      reconcileAllJapams(UID),
    ]);
    expect(r2.synced).toBe(0);
    expect(r2.failed).toBe(0);
  });

  it('sync failure does not affect local data', async () => {
    mockUpsert.mockRejectedValue(new Error('network down'));
    const result = await createJapam(UID, 'NetworkFail');
    await flushMicrotasks();
    expect(result).not.toBeNull();
    expect(result!.created.name).toBe('NetworkFail');
  });
});

describe('race-condition: latest-state-wins serialization', () => {
  it('create in flight + rename → remote ends with new name', async () => {
    let callCount = 0;
    let resolveCreate: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveCreate = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    void createJapam(UID, 'OldName');
    await flushMicrotasks();

    const japams = await loadJapams(UID);
    const id = japams[0].id;

    void renameJapam(UID, id, 'NewName');
    await flushMicrotasks();

    resolveCreate!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].name).toBe('OldName');
    expect(mockUpsert.mock.calls[1][0].name).toBe('NewName');
  });

  it('rename in flight + second rename → remote ends with latest name', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Base');
    await flushMicrotasks();
    mockUpsert.mockReset();

    let callCount = 0;
    let resolveFirst: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    void renameJapam(UID, r!.created.id, 'Draft');
    await flushMicrotasks();
    void renameJapam(UID, r!.created.id, 'Final');
    await flushMicrotasks();

    resolveFirst!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].name).toBe('Draft');
    expect(mockUpsert.mock.calls[1][0].name).toBe('Final');
  });

  it('archive in flight + restore → remote ends with archived_at = null', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Toggle');
    await flushMicrotasks();
    mockUpsert.mockReset();
    mockRemoteRestore([{ restored_japam_id: r!.created.id }]);

    let callCount = 0;
    let resolveFirst: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    void archiveJapam(UID, r!.created.id);
    await flushMicrotasks();

    void restoreJapam(UID, r!.created.id);
    await flushMicrotasks();

    resolveFirst!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].archived_at).not.toBeNull();
    expect(mockUpsert.mock.calls[1][0].archived_at).toBeNull();
  });

  it('restore in flight + archive → remote ends archived', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Toggle2');
    await flushMicrotasks();
    await archiveJapam(UID, r!.created.id);
    await flushMicrotasks();
    mockUpsert.mockReset();
    mockRemoteRestore([{ restored_japam_id: r!.created.id }]);

    let callCount = 0;
    let resolveFirst: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    void restoreJapam(UID, r!.created.id);
    await flushMicrotasks();

    void archiveJapam(UID, r!.created.id);
    await flushMicrotasks();

    resolveFirst!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].archived_at).toBeNull();
    expect(mockUpsert.mock.calls[1][0].archived_at).not.toBeNull();
  });

  it('three rapid updates collapse to latest local state', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Multi');
    await flushMicrotasks();
    mockUpsert.mockReset();

    let callCount = 0;
    let resolveFirst: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    void renameJapam(UID, r!.created.id, 'A');
    await flushMicrotasks();
    void renameJapam(UID, r!.created.id, 'B');
    await flushMicrotasks();
    void renameJapam(UID, r!.created.id, 'C');
    await flushMicrotasks();

    resolveFirst!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].name).toBe('A');
    expect(mockUpsert.mock.calls[1][0].name).toBe('C');
  });

  it('only one request per Japam is active at a time', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r = await createJapam(UID, 'Solo');
    await flushMicrotasks();
    mockUpsert.mockReset();

    let resolveFirst: (v: unknown) => void;
    mockUpsert.mockReturnValue(new Promise((resolve) => { resolveFirst = resolve; }));

    void renameJapam(UID, r!.created.id, 'First');
    await flushMicrotasks();

    void renameJapam(UID, r!.created.id, 'Second');
    await flushMicrotasks();

    // Second rename was folded into dirty flag — no new upsert fired yet
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    resolveFirst!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  it('does not loop forever on remote failure', async () => {
    mockUpsert.mockRejectedValue(new Error('network down'));
    const r = await createJapam(UID, 'FailLoop');
    await flushMicrotasks();
    // syncJapam returned false → syncLoop deleted the map entry and exited

    // Replace with a spy that counts calls, to prove no retry storm
    mockUpsert.mockReset();
    let fireCount = 0;
    mockUpsert.mockImplementation(() => {
      fireCount++;
      return Promise.reject(new Error('still down'));
    });

    // Trigger another lifecycle event — it must start a new loop (entry was cleaned)
    void renameJapam(UID, r!.created.id, 'Retry');
    await flushMicrotasks();
    await flushMicrotasks();

    // Exactly one attempt — loop did not retry after failure
    expect(fireCount).toBe(1);
  });

  it('different Japam IDs can sync independently', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const r1 = await createJapam(UID, 'IndieA');
    const r2 = await createJapam(UID, 'IndieB');
    await flushMicrotasks();
    mockUpsert.mockReset();

    let callCount = 0;
    let resolveA: (v: unknown) => void;
    mockUpsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      return Promise.resolve({ error: null });
    });

    // Block JapamA's sync
    void renameJapam(UID, r1!.created.id, 'IndieA-Renamed');
    await flushMicrotasks();

    // JapamB's sync runs independently
    void renameJapam(UID, r2!.created.id, 'IndieB-Renamed');
    await flushMicrotasks();

    const bCall = mockUpsert.mock.calls.find((c: any[]) => c[0].name === 'IndieB-Renamed');
    expect(bCall).toBeDefined();

    resolveA!({ error: null });
    await flushMicrotasks();
    await flushMicrotasks();

    const aCall = mockUpsert.mock.calls.find((c: any[]) => c[0].name === 'IndieA-Renamed');
    expect(aCall).toBeDefined();
  });
});

describe('deletion semantics', () => {
  it('syncJapam never does a hard delete', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await syncJapam(UID, makeJapam());
    const call = mockUpsert.mock.calls[0];
    expect(call[0]).toHaveProperty('id');
    expect(call[0]).toHaveProperty('user_id');
    expect(call[0]).toHaveProperty('name');
    expect(call[0]).toHaveProperty('archived_at');
  });
});

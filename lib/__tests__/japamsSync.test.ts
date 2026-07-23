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
  supabase: {
    from: jest.fn(),
  },
}));

/* eslint-disable import/first -- jest.mock() must precede imports; Jest hoists mock calls above import lines */
import { syncJapam, createJapam, renameJapam, archiveJapam, restoreJapam, loadJapams, reconcileAllJapams } from '../japamsRepository';
import { supabase } from '../supabase';
import { type Japam } from '../japams';
import AsyncStorage from '@react-native-async-storage/async-storage';
/* eslint-enable import/first */

const UID = 'user-123';
const UID_OTHER = 'user-999';
const NOW = '2026-07-22T10:00:00.000Z';

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
const mockFrom = supabase.from as jest.Mock;

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(async () => {
  await AsyncStorage.clear();
  mockFrom.mockReturnValue({ upsert: mockUpsert });
  mockUpsert.mockReset();
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

  it('never throws', async () => {
    mockUpsert.mockRejectedValue('unknown error');
    await expect(syncJapam(UID, makeJapam())).resolves.toBe(false);
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
    mockUpsert.mockReset();
    await restoreJapam(UID, r!.created.id);
    await flushMicrotasks();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].archived_at).toBeNull();
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

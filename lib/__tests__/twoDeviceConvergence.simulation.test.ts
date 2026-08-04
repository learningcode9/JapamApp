/**
 * Two-device production-symptom simulation.
 *
 * Drives the REAL repository + hydration layers (japamsRepository.ensureDefaultJapam and
 * historyRepository.hydrateHistoryForUserDetails) against mocked remote state and a controllable
 * network, exactly as the web History screen does on sign-in/refresh. This is the local-web
 * equivalent of the staged smoke validation for the "archived-duplicate selection convergence"
 * outage:
 *
 *   Device A — persisted currentJapamId = active canonical "My Japam", populated local History.
 *   Device B — persisted currentJapamId = archived + tombstoned duplicate "My Japam", empty local
 *              History.
 *
 * Both devices share the same remote world: one active canonical, the archived duplicate is
 * tombstoned in deleted_japams, a second archived "My Japam" exists with no tombstone, and the
 * canonical owns the remote History rows. Each device is simulated as an isolated AsyncStorage
 * partition (local web per-device storage), while every remote read is shared.
 *
 * Scenarios exercised (all six from the validation brief):
 *   1. Network up — sign-in/refresh on both devices.
 *   2. Transient failure of BOTH remote japams fetch AND authoritative deleted_japams/tombstone
 *      fetch — a valid local active selection and its currently visible History must survive.
 *   3. Network restored — refresh again on both devices.
 *   4. Reopen/relogin — no empty intermediate or final History state.
 *   5. No side effects anywhere: no new default Japam, no restore RPC, no History delete,
 *      no deleted_completions write, no tombstone creation.
 *   6. A later manual selection of another valid active Japam remains stable across refresh.
 *
 * The harness also records every RPC / table write so the report can list exactly what was observed.
 */
/* eslint-disable import/first */

jest.mock('@react-native-async-storage/async-storage', () => {
  const storeA: Record<string, string> = {};
  const storeB: Record<string, string> = {};
  const stores = { deviceA: storeA, deviceB: storeB };
  let active: 'deviceA' | 'deviceB' = 'deviceA';
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => stores[active][key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { stores[active][key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete stores[active][key]; }),
      clear: jest.fn(async () => { Object.keys(stores[active]).forEach((k) => { delete stores[active][k]; }); }),
      __simActivateDevice: (which: 'deviceA' | 'deviceB') => { active = which; },
      __simResetDevice: (which: 'deviceA' | 'deviceB') => { Object.keys(stores[which]).forEach((k) => { delete stores[which][k]; }); },
      __simStoreFor: (which: 'deviceA' | 'deviceB') => stores[which],
    },
  };
});

const mockSupabase = {
  from: jest.fn(),
  rpc: jest.fn(),
  auth: { getSession: jest.fn() },
};

jest.mock('../supabase', () => ({ supabase: mockSupabase }));

const mockFetchJapamHistoryRows = jest.fn();

jest.mock('../supabaseRestHelper', () => ({
  fetchJapamHistoryRows: (...args: unknown[]) => mockFetchJapamHistoryRows(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureDefaultJapam } from '../japamsRepository';
import {
  __resetHistoryHydrationState,
  hydrateHistoryForUserDetails,
} from '../historyRepository';
import { filterByJapam } from '../historyStore';
import { type Japam } from '../japams';
import { uuidV5 } from '../deterministicUuid';

const UID = 'user-123';
const CANONICAL_ID = 'canonical-11111111-aaaa';
const DUPLICATE_ID = 'duplicate-22222222-bbbb';
const SECOND_ID = 'third-33333333-cccc';
const MANUAL_ID = 'manual-44444444-dddd';
const DEFAULT_NAME = 'My Japam';

type RemoteJapamRow = {
  id: string;
  user_id: string;
  name: string;
  display_order: number | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

const remoteCanonical: RemoteJapamRow = {
  id: CANONICAL_ID,
  user_id: UID,
  name: DEFAULT_NAME,
  display_order: null,
  created_at: '2026-07-29T02:22:09.000Z',
  updated_at: '2026-07-29T02:22:09.000Z',
  archived_at: null,
};
const remoteDuplicate = {
  id: DUPLICATE_ID,
  user_id: UID,
  name: DEFAULT_NAME,
  display_order: null,
  created_at: '2026-08-02T00:00:00.000Z',
  updated_at: '2026-08-04T00:33:14.000Z',
  archived_at: '2026-08-04T00:33:14.000Z',
};
const remoteSecond = {
  id: SECOND_ID,
  user_id: UID,
  name: DEFAULT_NAME,
  display_order: null,
  created_at: '2026-07-29T02:22:09.527Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  archived_at: '2026-08-02T00:00:00.000Z',
};

const remoteCanonicalHistory = [
  {
    id: 'remote-canon-1',
    created_at: '2026-07-20T09:00:00.000Z',
    malas: 2,
    count: 216,
    user_name: 'learningcode9',
    completion_id: 'remote-canon-1',
    japam_id: CANONICAL_ID,
    japam_name: DEFAULT_NAME,
  },
  {
    id: 'remote-canon-2',
    created_at: '2026-07-21T09:00:00.000Z',
    malas: 3,
    count: 324,
    user_name: 'learningcode9',
    completion_id: 'remote-canon-2',
    japam_id: CANONICAL_ID,
    japam_name: DEFAULT_NAME,
  },
  {
    id: 'remote-canon-3',
    created_at: '2026-07-22T09:00:00.000Z',
    malas: 5,
    count: 540,
    user_name: 'learningcode9',
    completion_id: 'remote-canon-3',
    japam_id: CANONICAL_ID,
    japam_name: DEFAULT_NAME,
  },
];

const localCanonicalJapam: Japam = {
  id: CANONICAL_ID,
  userId: UID,
  name: DEFAULT_NAME,
  displayOrder: null,
  createdAt: '2026-07-29T02:22:09.000Z',
  updatedAt: '2026-07-29T02:22:09.000Z',
  archivedAt: null,
};

const deviceALocalHistory = [
  {
    date: '2026-07-19T09:00:00.000Z',
    malas: 1,
    totalCount: 108,
    duration: 0,
    manual: false,
    userId: UID,
    completionId: 'local-canon-a',
    syncStatus: 'synced' as const,
    japamId: CANONICAL_ID,
    japamName: DEFAULT_NAME,
  },
];

const CURRENT_JAPAM_KEY = `currentJapamId:${UID}`;
const USER_JAPAMS_KEY = `userJapams:${UID}`;
const HISTORY_KEY = 'history';
const DELETED_COMPLETIONS_KEY = 'deletedCompletions';

type Network = {
  japams: boolean;
  tombstones: boolean;
  history: boolean;
  deletedCompletions: boolean;
  usage: boolean;
};

let net: Network = {
  japams: true,
  tombstones: true,
  history: true,
  deletedCompletions: true,
  usage: true,
};

let remoteJapams: RemoteJapamRow[];
let remoteTombstones: { japam_id: string }[];
let remoteDeletedCompletions: { completion_id: string }[];
let usageByJapam: Record<string, { history_count: number; group_ref_count: number }>;
const restoreRpcCalls: string[] = [];
const deleteRpcCalls: string[] = [];
const upsertCalls: Record<string, unknown>[] = [];
const deletedCompletionsWrites: unknown[] = [];

const mockUpsert = jest.fn(async (row: Record<string, unknown>) => {
  upsertCalls.push(row);
  return { data: null, error: null };
});

const activateDevice = (device: 'deviceA' | 'deviceB') => {
  (AsyncStorage as unknown as { __simActivateDevice: (d: 'deviceA' | 'deviceB') => void })
    .__simActivateDevice(device);
};

const resetDevice = (device: 'deviceA' | 'deviceB') => {
  (AsyncStorage as unknown as { __simResetDevice: (d: 'deviceA' | 'deviceB') => void })
    .__simResetDevice(device);
};

const seedDeviceA = async () => {
  resetDevice('deviceA');
  activateDevice('deviceA');
  await AsyncStorage.setItem(CURRENT_JAPAM_KEY, CANONICAL_ID);
  await AsyncStorage.setItem(USER_JAPAMS_KEY, JSON.stringify([localCanonicalJapam]));
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(deviceALocalHistory));
};

const seedDeviceB = async () => {
  resetDevice('deviceB');
  activateDevice('deviceB');
  await AsyncStorage.setItem(CURRENT_JAPAM_KEY, DUPLICATE_ID);
  await AsyncStorage.setItem(USER_JAPAMS_KEY, JSON.stringify([]));
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
};

const readPersistedJapamId = async () => {
  activateDevice(deviceForThisCall());
  return AsyncStorage.getItem(CURRENT_JAPAM_KEY);
};

let currentDevice: 'deviceA' | 'deviceB' = 'deviceA';
const deviceForThisCall = () => currentDevice;

const signInRefresh = async () => {
  const result = await ensureDefaultJapam(UID);
  return result;
};

/** Mirrors the History screen: gate on a real current Japam, then filter hydrated rows. */
const loadVisibleHistory = async (japams: Japam[], currentJapamId: string | null) => {
  const currentJapam = currentJapamId ? japams.find((j) => j.id === currentJapamId) ?? null : null;
  const hydrated = await hydrateHistoryForUserDetails(UID);
  if (!currentJapam) {
    return { hydrated, visible: [] as string[], gateBlocked: true };
  }
  const includeBlankLegacy = currentJapamId === japams.filter((j) => j.archivedAt === null).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]?.id;
  const visible = filterByJapam(hydrated.records, currentJapamId, currentJapam.name, { includeBlankLegacy }, japams)
    .map((r) => r.completionId);
  return { hydrated, visible, gateBlocked: false };
};

describe('two-device convergence simulation (web local smoke)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await resetDevice('deviceA');
    await resetDevice('deviceB');
    __resetHistoryHydrationState();
    net = { japams: true, tombstones: true, history: true, deletedCompletions: true, usage: true };
    remoteJapams = [remoteCanonical, remoteDuplicate, remoteSecond];
    remoteTombstones = [{ japam_id: DUPLICATE_ID }];
    remoteDeletedCompletions = [];
    usageByJapam = {};
    restoreRpcCalls.length = 0;
    deleteRpcCalls.length = 0;
    upsertCalls.length = 0;
    deletedCompletionsWrites.length = 0;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'japams') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => (
                net.japams
                  ? { data: remoteJapams, error: null }
                  : { data: null, error: { code: '500', message: 'offline' } }
              ),
            }),
          }),
          upsert: mockUpsert,
        };
      }
      if (table === 'deleted_japams') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => (
                net.tombstones
                  ? { data: remoteTombstones, error: null }
                  : { data: null, error: { code: '500', message: 'offline' } }
              ),
            }),
          }),
        };
      }
      if (table === 'deleted_completions') {
        return {
          select: () => ({
            eq: async () => (
              net.deletedCompletions
                ? { data: remoteDeletedCompletions, error: null }
                : { data: null, error: { code: '500', message: 'offline' } }
            ),
          }),
        };
      }
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
    });

    mockSupabase.rpc.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'get_owned_japam_usage') {
        if (!net.usage) return { data: null, error: { code: '500', message: 'offline' } };
        const japamId = (params?.p_japam_id as string | undefined) ?? '';
        const usage = usageByJapam[japamId] ?? { history_count: 0, group_ref_count: 0 };
        return {
          data: [{
            japam_id: japamId,
            name: DEFAULT_NAME,
            archived_at: null,
            history_count: usage.history_count,
            group_ref_count: usage.group_ref_count,
          }],
          error: null,
        };
      }
      if (name === 'restore_owned_japam') {
        restoreRpcCalls.push((params?.p_japam_id as string | undefined) ?? '');
        return { data: [{ restored_japam_id: params?.p_japam_id, tombstones_deleted: 0 }], error: null };
      }
      if (name === 'delete_owned_japam') {
        deleteRpcCalls.push((params?.p_japam_id as string | undefined) ?? '');
        return { data: [{ deleted_japam_id: params?.p_japam_id }], error: null };
      }
      if (name === 'get_pending_japam_adoption') return { data: null, error: null };
      if (name === 'acknowledge_pending_japam_adoption') return { data: 0, error: null };
      return { data: null, error: null };
    });

    mockFetchJapamHistoryRows.mockImplementation(async () => (
      net.history ? remoteCanonicalHistory : null
    ));

    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  });

  const observeDeletedCompletionWrites = () => {
    const raw = (AsyncStorage as unknown as { __simStoreFor: (d: 'deviceA' | 'deviceB') => Record<string, string> })
      .__simStoreFor(currentDevice);
    const value = raw[DELETED_COMPLETIONS_KEY];
    if (value !== undefined) deletedCompletionsWrites.push(value);
  };

  it('SCENARIO 1: network up — both devices converge to the same canonical, canonical persisted before History renders, remote History visible on both', async () => {
    // Device A: valid local active selection + populated local History.
    currentDevice = 'deviceA';
    await seedDeviceA();
    const a = await signInRefresh();
    const persistedA = await readPersistedJapamId();
    const historyA = await loadVisibleHistory(a.japams, a.currentJapamId);

    expect(a.currentJapamId).toBe(CANONICAL_ID);
    expect(persistedA).toBe(CANONICAL_ID);
    expect(historyA.gateBlocked).toBe(false);
    expect(historyA.visible).toEqual(expect.arrayContaining(['remote-canon-1', 'remote-canon-2', 'remote-canon-3']));

    // Device B: stale pointer to the archived/tombstoned duplicate, empty local History.
    currentDevice = 'deviceB';
    await seedDeviceB();
    const b = await signInRefresh();
    const persistedB = await readPersistedJapamId();
    const historyB = await loadVisibleHistory(b.japams, b.currentJapamId);

    expect(b.currentJapamId).toBe(CANONICAL_ID);
    expect(persistedB).toBe(CANONICAL_ID);
    expect(historyB.gateBlocked).toBe(false);
    expect(historyB.visible).toEqual(expect.arrayContaining(['remote-canon-1', 'remote-canon-2', 'remote-canon-3']));

    expect(b.created).toBeNull();
    expect(restoreRpcCalls).toHaveLength(0);
    expect(deleteRpcCalls).toHaveLength(0);
  });

  it('SCENARIO 2: transient failure of BOTH japams and tombstone fetches — valid local selection and visible History survive', async () => {
    net.japams = false;
    net.tombstones = false;

    // Device A has a valid local active selection and currently visible History.
    currentDevice = 'deviceA';
    await seedDeviceA();
    const a = await signInRefresh();
    const persistedA = await readPersistedJapamId();
    const historyA = await loadVisibleHistory(a.japams, a.currentJapamId);

    expect(a.currentJapamId).toBe(CANONICAL_ID);
    expect(persistedA).toBe(CANONICAL_ID);
    expect(a.created).toBeNull();
    // History must stay visible (local rows remain; remote rows were already on screen).
    expect(historyA.gateBlocked).toBe(false);
    expect(historyA.visible).toContain('local-canon-a');
    // No side effects during the outage.
    expect(restoreRpcCalls).toHaveLength(0);
    expect(deleteRpcCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);

    // Device B has nothing valid locally (no active selection, empty History) — it must degrade
    // without creating or resurrecting anything, and without calling any RPC/write.
    currentDevice = 'deviceB';
    await seedDeviceB();
    const b = await signInRefresh();
    const persistedB = await readPersistedJapamId();
    const historyB = await loadVisibleHistory(b.japams, b.currentJapamId);

    expect(b.created).toBeNull();
    expect(restoreRpcCalls).toHaveLength(0);
    expect(deleteRpcCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
    expect(historyB.gateBlocked).toBe(true);
    expect(persistedB).toBe(DUPLICATE_ID); // stale pointer preserved, never wiped to a NEW value
  });

  it('SCENARIO 2 (variant): full remote History outage too — local History stays visible on Device A', async () => {
    net.japams = false;
    net.tombstones = false;
    net.history = false;
    net.deletedCompletions = false;

    currentDevice = 'deviceA';
    await seedDeviceA();
    const a = await signInRefresh();
    const historyA = await loadVisibleHistory(a.japams, a.currentJapamId);

    expect(a.currentJapamId).toBe(CANONICAL_ID);
    expect(historyA.gateBlocked).toBe(false);
    expect(historyA.visible).toEqual(['local-canon-a']);
    expect(a.created).toBeNull();
    expect(restoreRpcCalls).toHaveLength(0);
    expect(deleteRpcCalls).toHaveLength(0);
  });

  it('SCENARIO 3: network restored — refresh converges both devices back to the canonical', async () => {
    // Bring the network down and refresh Device B (stale pointer) first.
    net.japams = false;
    net.tombstones = false;
    currentDevice = 'deviceB';
    await seedDeviceB();
    await signInRefresh();

    // Restore the network and refresh again.
    net.japams = true;
    net.tombstones = true;
    const b = await signInRefresh();
    const persistedB = await readPersistedJapamId();
    const historyB = await loadVisibleHistory(b.japams, b.currentJapamId);

    expect(b.currentJapamId).toBe(CANONICAL_ID);
    expect(persistedB).toBe(CANONICAL_ID);
    expect(historyB.gateBlocked).toBe(false);
    expect(historyB.visible).toEqual(expect.arrayContaining(['remote-canon-1', 'remote-canon-2', 'remote-canon-3']));
    expect(b.created).toBeNull();

    // Device A likewise.
    currentDevice = 'deviceA';
    await seedDeviceA();
    const a = await signInRefresh();
    expect(a.currentJapamId).toBe(CANONICAL_ID);
    expect(a.created).toBeNull();
  });

  it('SCENARIO 4: reopen/relogin — no empty intermediate or final History state', async () => {
    currentDevice = 'deviceA';
    await seedDeviceA();
    const first = await signInRefresh();
    const historyFirst = await loadVisibleHistory(first.japams, first.currentJapamId);

    // "Reopen": fresh in-memory state, same persisted keys (no reseed of japams/history).
    __resetHistoryHydrationState();
    const second = await signInRefresh();
    const historySecond = await loadVisibleHistory(second.japams, second.currentJapamId);

    expect(first.currentJapamId).toBe(CANONICAL_ID);
    expect(second.currentJapamId).toBe(CANONICAL_ID);
    expect(historyFirst.gateBlocked).toBe(false);
    expect(historySecond.gateBlocked).toBe(false);
    expect(historySecond.visible).toEqual(expect.arrayContaining(['local-canon-a', 'remote-canon-1']));
    expect(second.created).toBeNull();

    // Device B relogin: converges from the stale pointer without an empty History screen.
    currentDevice = 'deviceB';
    await seedDeviceB();
    const b = await signInRefresh();
    const historyB = await loadVisibleHistory(b.japams, b.currentJapamId);
    expect(b.currentJapamId).toBe(CANONICAL_ID);
    expect(historyB.gateBlocked).toBe(false);
    expect(historyB.visible).toHaveLength(3);
  });

  it('SCENARIO 5: no new default, no restore RPC, no History delete, no deleted_completions write, no tombstone creation', async () => {
    currentDevice = 'deviceA';
    await seedDeviceA();
    const a = await signInRefresh();
    // Run the History load exactly as the screen does (hydrate merges remote rows into storage).
    await loadVisibleHistory(a.japams, a.currentJapamId);
    const aHistoryAfter = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');

    // No upsert (would be a new/edited Japam row), no restore/delete RPCs.
    expect(upsertCalls).toHaveLength(0);
    expect(restoreRpcCalls).toHaveLength(0);
    expect(deleteRpcCalls).toHaveLength(0);

    // No History delete: local rows persist and remote rows merged in.
    expect(aHistoryAfter.some((r: { completionId?: string }) => r.completionId === 'local-canon-a')).toBe(true);
    expect(aHistoryAfter.length).toBeGreaterThanOrEqual(2);

    // No deleted_completions write (remote tombstones empty → nothing written).
    observeDeletedCompletionWrites();
    expect(deletedCompletionsWrites).toHaveLength(0);

    // No tombstone creation: deleted_japams remote set unchanged and no delete RPC fired.
    expect(remoteTombstones.map((t) => t.japam_id)).toEqual([DUPLICATE_ID]);
    expect(deleteRpcCalls).toHaveLength(0);

    // No default Japam was created: the deterministic default id is absent from the stored list.
    const defaultId = uuidV5(`${UID}:default-japam`, '62f5824e-58fd-5d39-9f87-1f761082d8e3');
    const storedJapams = JSON.parse((await AsyncStorage.getItem(USER_JAPAMS_KEY)) || '[]');
    expect(storedJapams.map((j: { id?: string }) => j.id)).not.toContain(defaultId);
  });

  it('SCENARIO 6: a later manual selection of another valid active Japam remains stable across refresh', async () => {
    const remoteManual = {
      id: MANUAL_ID,
      user_id: UID,
      name: 'Manual Pick',
      display_order: null,
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
      archived_at: null,
    };
    remoteJapams = [remoteCanonical, remoteDuplicate, remoteSecond, remoteManual];

    currentDevice = 'deviceA';
    await seedDeviceA();
    await signInRefresh();
    expect(await readPersistedJapamId()).toBe(CANONICAL_ID);

    // User manually switches to the second valid active Japam.
    await AsyncStorage.setItem(CURRENT_JAPAM_KEY, MANUAL_ID);

    const refreshed = await signInRefresh();
    const persisted = await readPersistedJapamId();
    const historyManual = await loadVisibleHistory(refreshed.japams, refreshed.currentJapamId);

    expect(refreshed.currentJapamId).toBe(MANUAL_ID);
    expect(persisted).toBe(MANUAL_ID);
    expect(historyManual.gateBlocked).toBe(false);
    expect(refreshed.created).toBeNull();
    expect(restoreRpcCalls).toHaveLength(0);
    expect(deleteRpcCalls).toHaveLength(0);
  });

  it('guest/offline does not regress: no signed-in remote reconciliation is attempted for a guest userId', async () => {
    // Guest storage is keyed by 'guest'. A guest has no signed-in remote world to converge to.
    net.japams = false;
    net.tombstones = false;
    const guestResult = await ensureDefaultJapam('guest');
    expect(guestResult.currentJapamId).toBeNull();
    expect(guestResult.created).toBeNull();
  });
});

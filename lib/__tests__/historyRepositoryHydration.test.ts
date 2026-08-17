/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockFetchJapamHistoryRows = jest.fn();
const mockGetSession = jest.fn();
const mockSelectEq = jest.fn();

jest.mock('../supabaseRestHelper', () => ({
  fetchJapamHistoryRows: (...args: unknown[]) => mockFetchJapamHistoryRows(...args),
}));

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
    from: () => ({
      select: () => ({
        eq: (...args: unknown[]) => mockSelectEq(...args),
      }),
    }),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import {
  __resetHistoryHydrationState,
  drainHistoryForUser,
  hydrateHistoryForUser,
  hydrateHistoryForUserDetails,
  loadMoreHistoryForUser,
} from '../historyRepository';
import { japamStatsFor, statsByJapamWithAttribution, toLocalDayKey } from '../historyStore';

const UID = 'user-123';
const OTHER_UID = 'user-456';
const JAPAM_ID = 'japam-1';

const makeRecord = (overrides: Partial<Record<string, unknown>> = {}) => ({
  date: '2026-07-20T09:00:00.000Z',
  malas: 2,
  totalCount: 216,
  duration: 0,
  manual: false,
  userId: UID,
  completionId: 'remote-1',
  syncStatus: 'synced' as const,
  japamId: JAPAM_ID,
  japamName: 'My Japam',
  ...overrides,
});

const makeRecordForUser = (userId: string | null | undefined, completionId: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  ...makeRecord({ completionId, ...overrides }),
  userId,
});

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('historyRepository hydration', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    __resetHistoryHydrationState();
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
    mockSelectEq.mockResolvedValue({ data: [], error: null });
  });

  it('hydrates remote History on first load and computes the correct lifetime total', async () => {
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-1',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'learningcode9',
        completion_id: 'remote-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    const hydrated = await hydrateHistoryForUser(UID);
    const statsMap = statsByJapamWithAttribution(hydrated, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-20', toLocalDayKey);

    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);
    expect(japamStatsFor(statsMap, JAPAM_ID).lifetimeMalas).toBe(2);
    expect(japamStatsFor(statsMap, JAPAM_ID).lifetimeTotalCount).toBe(216);
  });

  it('excludes tombstoned remote completions', async () => {
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-deleted',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'learningcode9',
        completion_id: 'remote-deleted',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);
    mockSelectEq.mockResolvedValue({ data: [{ completion_id: 'remote-deleted' }], error: null });

    const hydrated = await hydrateHistoryForUser(UID);

    expect(hydrated).toHaveLength(0);
    expect(japamStatsFor(statsByJapamWithAttribution(hydrated, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-20', toLocalDayKey), JAPAM_ID).lifetimeMalas).toBe(0);
  });

  it('falls back to local History when offline', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([makeRecord({ completionId: 'local-1' })]));
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockFetchJapamHistoryRows.mockResolvedValue(null);

    const hydrated = await hydrateHistoryForUser(UID);
    const statsMap = statsByJapamWithAttribution(hydrated, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-20', toLocalDayKey);

    expect(hydrated).toHaveLength(1);
    expect(japamStatsFor(statsMap, JAPAM_ID).lifetimeMalas).toBe(2);
  });

  it('does not overwrite valid totals with zero when hydration fails', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([makeRecord({ completionId: 'local-1' })]));
    mockFetchJapamHistoryRows.mockResolvedValue(null);

    const hydrated = await hydrateHistoryForUser(UID);
    const statsMap = statsByJapamWithAttribution(hydrated, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-20', toLocalDayKey);

    expect(hydrated).toHaveLength(1);
    expect(japamStatsFor(statsMap, JAPAM_ID).lifetimeMalas).toBe(2);
    expect(JSON.parse((await AsyncStorage.getItem('history')) || '[]')).toHaveLength(1);
  });

  it('dedupes concurrent hydration requests', async () => {
    const deferred = createDeferred<unknown[]>();
    mockFetchJapamHistoryRows.mockImplementation(() => deferred.promise);

    const first = hydrateHistoryForUser(UID);
    const second = hydrateHistoryForUser(UID);

    await Promise.resolve();
    deferred.resolve([
      {
        id: 'remote-1',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'learningcode9',
        completion_id: 'remote-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toHaveLength(1);
  });

  it('preserves User B rows when hydrating User A', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecordForUser(UID, 'user-a-local'),
      makeRecordForUser(OTHER_UID, 'user-b-local', { completionId: 'user-b-local', userId: OTHER_UID, userName: 'User B' }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    const hydrated = await hydrateHistoryForUser(UID);
    const persisted = JSON.parse((await AsyncStorage.getItem('history')) || '[]') as { completionId?: string; userId?: string | null }[];

    expect(hydrated.every((row) => row.userId === UID)).toBe(true);
    expect(hydrated.map((row) => row.completionId)).toEqual(expect.arrayContaining(['user-a-local', 'remote-a']));
    expect(hydrated.map((row) => row.completionId)).not.toContain('user-b-local');
    expect(persisted.map((row) => row.completionId)).toEqual(expect.arrayContaining(['user-a-local', 'user-b-local', 'remote-a']));
    expect(persisted.find((row) => row.completionId === 'user-b-local')?.userId).toBe(OTHER_UID);
  });

  it('preserves guest rows when hydrating a signed-in user', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecordForUser(null, 'guest-row', { userId: null, userName: 'Guest' }),
      makeRecordForUser(UID, 'user-row', { userName: 'User A' }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 1,
        count: 108,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    const hydrated = await hydrateHistoryForUser(UID);
    const persisted = JSON.parse((await AsyncStorage.getItem('history')) || '[]') as { completionId?: string; userId?: string | null }[];

    expect(hydrated.every((row) => row.userId === UID)).toBe(true);
    expect(hydrated.map((row) => row.completionId)).toEqual(expect.arrayContaining(['user-row', 'remote-a']));
    expect(hydrated.map((row) => row.completionId)).not.toContain('guest-row');
    expect(persisted.map((row) => row.completionId)).toEqual(expect.arrayContaining(['guest-row', 'user-row', 'remote-a']));
    expect(persisted.find((row) => row.completionId === 'guest-row')?.userId ?? null).toBeNull();
  });

  it('keeps User B rows when User A tombstones are applied', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecordForUser(UID, 'user-a-row'),
      makeRecordForUser(OTHER_UID, 'user-b-row', { userName: 'User B' }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 1,
        count: 108,
        user_name: 'User A',
        completion_id: 'user-a-row',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);
    mockSelectEq.mockResolvedValue({ data: [{ completion_id: 'user-a-row' }], error: null });

    const hydrated = await hydrateHistoryForUser(UID);
    const persisted = JSON.parse((await AsyncStorage.getItem('history')) || '[]') as { completionId?: string }[];

    expect(hydrated.map((row) => row.completionId)).not.toContain('user-a-row');
    expect(hydrated.map((row) => row.completionId)).not.toContain('user-b-row');
    expect(persisted.map((row) => row.completionId)).toContain('user-b-row');
    expect(persisted.map((row) => row.completionId)).not.toContain('user-a-row');
  });

  it('hydrates once, reloads local pending rows without refetching, and force refresh fetches again', async () => {
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 1,
        count: 108,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    await hydrateHistoryForUser(UID);
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-new', syncStatus: 'pending', date: '2026-07-20T11:00:00.000Z' }),
    ]));
    const second = await hydrateHistoryForUser(UID);
    const forced = await hydrateHistoryForUser(UID, undefined, { force: true });

    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(2);
    expect(second.map((row) => row.completionId)).toEqual(expect.arrayContaining(['remote-a', 'local-new']));
    expect(forced.map((row) => row.completionId)).toEqual(expect.arrayContaining(['remote-a', 'local-new']));
  });

  it('localFirst returns local rows immediately without awaiting the remote fetch, then reconciles the local cache in the background', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', date: '2026-07-20T09:00:00.000Z' }),
    ]));
    let resolveRemote!: (value: unknown) => void;
    mockFetchJapamHistoryRows.mockImplementation(() => new Promise((resolve) => {
      resolveRemote = resolve;
    }));

    const hydrated = await hydrateHistoryForUserDetails(UID, undefined, { localFirst: true });

    // Local rows are returned immediately, before the (still-hanging) remote fetch resolves.
    expect(hydrated.hydrationSucceeded).toBe(false);
    expect(hydrated.records.map((row) => row.completionId)).toEqual(['local-1']);

    // Resolve the remote fetch: merged rows are persisted back into the local cache.
    resolveRemote([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const persisted = JSON.parse((await AsyncStorage.getItem('history')) || '[]') as { completionId?: string }[];
    expect(persisted.map((row) => row.completionId)).toEqual(expect.arrayContaining(['local-1', 'remote-a']));

    // A subsequent normal hydration serves the merged snapshot from the in-memory cache and
    // surfaces the remote rows without a second network fetch.
    const merged = await hydrateHistoryForUser(UID);
    expect(merged.map((row) => row.completionId)).toEqual(expect.arrayContaining(['remote-a', 'local-1']));
    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);
  });

  it('does not emit or retrigger hydration when the remote merge is unchanged', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({
        completionId: 'same-row',
        userName: 'User A',
        remoteId: 'same-row',
      }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'same-row',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'same-row',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');
    const historyUpdatedListener = jest.fn();
    const subscription = DeviceEventEmitter.addListener('japam-history-updated', historyUpdatedListener);
    try {
      const hydrated = await hydrateHistoryForUserDetails(UID, undefined, { localFirst: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(hydrated.records.map((row) => row.completionId)).toEqual(['same-row']);
      expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);
      expect(historyUpdatedListener).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalledWith('japam-history-updated');
      expect(emitSpy).not.toHaveBeenCalledWith('japam-stats-updated');
    } finally {
      subscription.remove();
      emitSpy.mockRestore();
    }
  });

  it('preserves a newer local addition and dedupes it against the remote result', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', date: '2026-07-20T09:00:00.000Z' }),
    ]));
    let resolveRemote!: (value: unknown) => void;
    mockFetchJapamHistoryRows.mockImplementation(() => new Promise((resolve) => {
      resolveRemote = resolve;
    }));

    await hydrateHistoryForUserDetails(UID, undefined, { localFirst: true });
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-new', date: '2026-07-20T11:00:00.000Z', syncStatus: 'pending' }),
      makeRecord({ completionId: 'local-1', date: '2026-07-20T09:00:00.000Z' }),
    ]));

    resolveRemote([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 1,
        count: 108,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
      {
        id: 'remote-local-1',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'local-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const persisted = JSON.parse((await AsyncStorage.getItem('history')) || '[]') as { completionId?: string }[];
    expect(persisted.map((row) => row.completionId)).toEqual(['local-new', 'remote-a', 'local-1']);
    expect(persisted.filter((row) => row.completionId === 'local-new')).toHaveLength(1);
  });

  it('preserves a newer local deletion and does not resurrect its remote row', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', date: '2026-07-20T09:00:00.000Z' }),
    ]));
    let resolveRemote!: (value: unknown) => void;
    mockFetchJapamHistoryRows.mockImplementation(() => new Promise((resolve) => {
      resolveRemote = resolve;
    }));

    await hydrateHistoryForUserDetails(UID, undefined, { localFirst: true });
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-new', date: '2026-07-20T11:00:00.000Z', syncStatus: 'pending' }),
    ]));
    await AsyncStorage.setItem('deletedCompletions', JSON.stringify(['local-1']));

    resolveRemote([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 1,
        count: 108,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
      {
        id: 'remote-local-1',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'local-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const persisted = JSON.parse((await AsyncStorage.getItem('history')) || '[]') as { completionId?: string }[];
    expect(persisted.map((row) => row.completionId)).toEqual(['local-new', 'remote-a']);
    expect(persisted.filter((row) => row.completionId === 'local-1')).toHaveLength(0);
    expect(JSON.parse((await AsyncStorage.getItem('deletedCompletions')) || '[]')).toContain('local-1');
  });

  it('does not reuse another user cache after logout or user change', async () => {
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-a',
        created_at: '2026-07-20T10:00:00.000Z',
        malas: 1,
        count: 108,
        user_name: 'User A',
        completion_id: 'remote-a',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);

    await hydrateHistoryForUser(UID);
    await hydrateHistoryForUser(OTHER_UID);

    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(2);
  });

  it('updates from 2 to 3 when a new local pending completion exists and remote hydration fails', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', malas: 2, totalCount: 216 }),
      makeRecord({ completionId: 'local-2', malas: 1, totalCount: 108, syncStatus: 'pending', date: '2026-07-20T10:30:00.000Z' }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValueOnce([
      {
        id: 'remote-a',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'local-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]).mockResolvedValueOnce(null);

    await hydrateHistoryForUserDetails(UID);
    const failed = await hydrateHistoryForUserDetails(UID, undefined, { force: true });

    expect(failed.hydrationSucceeded).toBe(false);
    expect(failed.localStateAuthoritativelyChanged).toBe(true);
    expect(failed.records.map((row) => row.completionId)).toEqual(expect.arrayContaining(['local-1', 'local-2']));
    expect(japamStatsFor(statsByJapamWithAttribution(failed.records, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-20', toLocalDayKey), JAPAM_ID).lifetimeMalas).toBe(3);
  });

  it('updates from 2 to 0 when the final local completion is tombstoned and remote hydration fails', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', malas: 2, totalCount: 216 }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValueOnce([
      {
        id: 'remote-a',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'local-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]).mockResolvedValueOnce(null);

    await hydrateHistoryForUserDetails(UID);
    await AsyncStorage.setItem('deletedCompletions', JSON.stringify(['local-1']));
    const failed = await hydrateHistoryForUserDetails(UID, undefined, { force: true });

    expect(failed.hydrationSucceeded).toBe(false);
    expect(failed.scopedLocalTombstoneApplied).toBe(true);
    expect(failed.localStateAuthoritativelyChanged).toBe(true);
    expect(failed.records).toHaveLength(0);
  });

  it('preserves the previously displayed 2 malas when remote hydration fails without an authoritative local change', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([
      makeRecord({ completionId: 'local-1', malas: 2, totalCount: 216 }),
    ]));
    mockFetchJapamHistoryRows.mockResolvedValueOnce([
      {
        id: 'remote-a',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'User A',
        completion_id: 'local-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]).mockResolvedValueOnce(null);

    await hydrateHistoryForUserDetails(UID);
    const failed = await hydrateHistoryForUserDetails(UID, undefined, { force: true });

    expect(failed.hydrationSucceeded).toBe(false);
    expect(failed.localStateAuthoritativelyChanged).toBe(false);
    expect(failed.records).toHaveLength(1);
    expect(japamStatsFor(statsByJapamWithAttribution(failed.records, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-20', toLocalDayKey), JAPAM_ID).lifetimeMalas).toBe(2);
  });

  it('stale empty local History plus populated remote History keeps the remote History visible after login/refresh', async () => {
    // Regression: a device whose local history key is empty (or lost) must still surface the
    // canonical's remote rows after login/refresh — an empty local cache must never hide them.
    mockFetchJapamHistoryRows.mockResolvedValue([
      {
        id: 'remote-1',
        created_at: '2026-07-20T09:00:00.000Z',
        malas: 2,
        count: 216,
        user_name: 'learningcode9',
        completion_id: 'remote-1',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
      {
        id: 'remote-2',
        created_at: '2026-07-21T09:00:00.000Z',
        malas: 3,
        count: 324,
        user_name: 'learningcode9',
        completion_id: 'remote-2',
        japam_id: JAPAM_ID,
        japam_name: 'My Japam',
      },
    ]);
    mockSelectEq.mockResolvedValue({ data: [], error: null });

    // Local history key is empty (stale device / first web load).
    await AsyncStorage.setItem('history', JSON.stringify([]));

    const hydrated = await hydrateHistoryForUserDetails(UID);

    expect(hydrated.hydrationSucceeded).toBe(true);
    expect(hydrated.records).toHaveLength(2);
    expect(hydrated.records.map((row) => row.completionId)).toEqual(['remote-2', 'remote-1']);
    const statsMap = statsByJapamWithAttribution(hydrated.records, UID, [{ id: JAPAM_ID, name: 'My Japam' }], JAPAM_ID, '2026-07-21', toLocalDayKey);
    expect(japamStatsFor(statsMap, JAPAM_ID).lifetimeMalas).toBe(5);
    // Remote rows were persisted back into the stale empty local cache.
    expect(JSON.parse((await AsyncStorage.getItem('history')) || '[]')).toHaveLength(2);
  });

  it('loads a bounded newest-first combined page and drains canonical plus legacy streams without gaps', async () => {
    const legacyUserId = 'legacy-user-123';
    const timestamp = '2026-07-20T09:00:00.000Z';
    const rowsFor = (prefix: string) => Array.from({ length: 30 }, (_, index) => ({
      id: `${prefix}-row-${index + 1}`,
      created_at: timestamp,
      malas: 1,
      count: 108,
      user_name: 'User A',
      completion_id: `${prefix}-${String(30 - index).padStart(2, '0')}`,
      japam_id: JAPAM_ID,
      japam_name: 'My Japam',
    }));
    const canonicalRows = rowsFor('canonical');
    const legacyRows = rowsFor('legacy');
    // The same completion can be visible through the canonical and legacy identity during an
    // identity transition. It must remain one local record after both streams are drained.
    legacyRows[legacyRows.length - 1].completion_id = canonicalRows[0].completion_id;
    const rowsByUser = new Map([
      [UID, canonicalRows],
      [legacyUserId, legacyRows],
    ]);
    mockFetchJapamHistoryRows.mockImplementation((options: {
      userId: string;
      limit?: number;
      before?: { createdAt: string; completionId: string };
    }) => {
      const allRows = [...(rowsByUser.get(options.userId) || [])].sort((a, b) =>
        b.completion_id.localeCompare(a.completion_id)
      );
      const start = options.before
        ? allRows.findIndex((row) => row.completion_id < options.before!.completionId)
        : 0;
      const first = start < 0 ? allRows.length : start;
      return Promise.resolve(allRows.slice(first, first + (options.limit ?? allRows.length)));
    });

    const initial = await hydrateHistoryForUserDetails(UID, legacyUserId, { remotePageSize: 50 });

    expect(initial.hydrationSucceeded).toBe(true);
    expect(initial.records).toHaveLength(50);
    expect(initial.hasMoreRemote).toBe(true);
    expect(new Set(initial.records.map((row) => row.completionId)).size).toBe(50);
    const firstRequests = mockFetchJapamHistoryRows.mock.calls.map(([options]) => options as {
      userId: string;
      limit?: number;
      order?: unknown;
      secondaryOrder?: unknown;
      before?: unknown;
    });
    expect(firstRequests).toHaveLength(2);
    expect(firstRequests.every((request) => request.limit === 50)).toBe(true);
    expect(firstRequests.every((request) => (request.order as { column: string; ascending: boolean }).column === 'created_at')).toBe(true);
    expect(firstRequests.every((request) => (request.order as { column: string; ascending: boolean }).ascending === false)).toBe(true);
    expect(firstRequests.every((request) => (request.secondaryOrder as { column: string }).column === 'completion_id')).toBe(true);

    const older = await loadMoreHistoryForUser(UID, legacyUserId, { pageSize: 50 });
    expect(older.pageLoaded).toBe(true);
    expect(older.hasMoreRemote).toBe(false);
    expect(older.records).toHaveLength(59);
    expect(new Set(older.records.map((row) => row.completionId)).size).toBe(59);
    expect(older.records.map((row) => row.completionId)).toEqual(
      [...older.records].sort((a, b) => {
        const dateDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
        return dateDiff || b.completionId.localeCompare(a.completionId);
      }).map((row) => row.completionId),
    );
    expect(older.records.map((row) => row.completionId).sort()).toEqual(
      [...canonicalRows, ...legacyRows].map((row) => row.completion_id).filter((id, index, all) => all.indexOf(id) === index).sort(),
    );
  });

  it('chooses the globally newest initial page when canonical and legacy volumes are asymmetric', async () => {
    const legacyUserId = 'legacy-user-123';
    const canonicalRows = Array.from({ length: 60 }, (_, index) => ({
      id: `canonical-row-${index}`,
      created_at: new Date(Date.UTC(2026, 7, 20, 12, -index)).toISOString(),
      malas: 1,
      count: 108,
      user_name: 'User A',
      completion_id: `canonical-${String(60 - index).padStart(3, '0')}`,
      japam_id: JAPAM_ID,
      japam_name: 'My Japam',
    }));
    const legacyRows = Array.from({ length: 2 }, (_, index) => ({
      id: `legacy-row-${index}`,
      created_at: new Date(Date.UTC(2026, 7, 1, 12, -index)).toISOString(),
      malas: 1,
      count: 108,
      user_name: 'User A',
      completion_id: `legacy-${String(2 - index).padStart(3, '0')}`,
      japam_id: JAPAM_ID,
      japam_name: 'My Japam',
    }));
    const rowsByUser = new Map([
      [UID, canonicalRows],
      [legacyUserId, legacyRows],
    ]);
    mockFetchJapamHistoryRows.mockImplementation((options: {
      userId: string;
      limit?: number;
      before?: { createdAt: string; completionId: string };
    }) => {
      const ordered = [...(rowsByUser.get(options.userId) || [])].sort((a, b) => {
        const dateDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        return dateDiff || b.completion_id.localeCompare(a.completion_id);
      });
      const start = options.before
        ? ordered.findIndex((row) => (
          row.created_at < options.before!.createdAt
          || (row.created_at === options.before!.createdAt && row.completion_id < options.before!.completionId)
        ))
        : 0;
      const first = start < 0 ? ordered.length : start;
      return Promise.resolve(ordered.slice(first, first + (options.limit ?? ordered.length)));
    });

    const initial = await hydrateHistoryForUserDetails(UID, legacyUserId, { remotePageSize: 50 });

    expect(initial.records).toHaveLength(50);
    expect(initial.records.map((row) => row.completionId)).toEqual(
      canonicalRows.slice(0, 50).map((row) => row.completion_id),
    );
    expect(mockFetchJapamHistoryRows.mock.calls.map(([options]) => (options as { limit?: number }).limit)).toEqual([50, 50]);

    const older = await loadMoreHistoryForUser(UID, legacyUserId, { pageSize: 50 });
    expect(older.pageLoaded).toBe(true);
    expect(older.hasMoreRemote).toBe(false);
    expect(older.records).toHaveLength(62);
    expect(new Set(older.records.map((row) => row.completionId)).size).toBe(62);
    expect(older.records.map((row) => row.completionId)).toEqual(
      [...older.records].sort((a, b) => {
        const dateDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
        return dateDiff || b.completionId.localeCompare(a.completionId);
      }).map((row) => row.completionId),
    );
  });

  it('keeps old pending/tombstoned local state and leaves it untouched when an older page fails', async () => {
    const localPending = makeRecord({ completionId: 'local-pending-old', syncStatus: 'pending', date: '2025-01-01T09:00:00.000Z' });
    const localDeleted = makeRecord({ completionId: 'local-deleted-old', date: '2025-01-02T09:00:00.000Z' });
    await AsyncStorage.setItem('history', JSON.stringify([localPending, localDeleted]));
    await AsyncStorage.setItem('deletedCompletions', JSON.stringify(['local-deleted-old']));
    const remotePage = Array.from({ length: 50 }, (_, index) => ({
      id: `remote-${index}`,
      created_at: '2026-07-20T09:00:00.000Z',
      malas: 1,
      count: 108,
      user_name: 'User A',
      completion_id: index === 0 ? 'remote-new' : `remote-${String(index).padStart(2, '0')}`,
      japam_id: JAPAM_ID,
      japam_name: 'My Japam',
    }));
    mockFetchJapamHistoryRows.mockResolvedValueOnce(remotePage).mockResolvedValueOnce(null);

    const initial = await hydrateHistoryForUserDetails(UID, undefined, { remotePageSize: 50 });
    expect(initial.records.map((row) => row.completionId)).toEqual(expect.arrayContaining(['local-pending-old']));
    expect(initial.records).toHaveLength(51);
    expect(initial.records.map((row) => row.completionId)).not.toContain('local-deleted-old');
    const beforeFailedPage = await AsyncStorage.getItem('history');

    const failed = await loadMoreHistoryForUser(UID, undefined, { pageSize: 50 });
    expect(failed.pageLoaded).toBe(false);
    expect(await AsyncStorage.getItem('history')).toBe(beforeFailedPage);
    expect(JSON.parse((await AsyncStorage.getItem('deletedCompletions')) || '[]')).toEqual(['local-deleted-old']);
  });

  it('drains only for complete operations and preserves the full record/completionId set and totals', async () => {
    const rows = Array.from({ length: 55 }, (_, index) => ({
      id: `row-${index}`,
      created_at: `2026-07-${String(20 - Math.floor(index / 10)).padStart(2, '0')}T09:00:00.000Z`,
      malas: index % 3 + 1,
      count: (index % 3 + 1) * 108,
      user_name: 'User A',
      completion_id: `drain-${String(index).padStart(3, '0')}`,
      japam_id: JAPAM_ID,
      japam_name: 'My Japam',
    }));
    mockFetchJapamHistoryRows.mockImplementation((options: { limit?: number; before?: { createdAt: string; completionId: string } }) => {
      const ordered = [...rows].sort((a, b) => {
        const dateDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        return dateDiff || b.completion_id.localeCompare(a.completion_id);
      });
      const start = options.before
        ? ordered.findIndex((row) => (
          row.created_at < options.before!.createdAt
          || (row.created_at === options.before!.createdAt && row.completion_id < options.before!.completionId)
        ))
        : 0;
      const first = start < 0 ? ordered.length : start;
      return Promise.resolve(ordered.slice(first, first + (options.limit ?? ordered.length)));
    });

    const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
    const drained = await drainHistoryForUser(UID, undefined, { pageSize: 50 });

    expect(drained.complete).toBe(true);
    expect(drained.records).toHaveLength(rows.length);
    expect(new Set(drained.records.map((row) => row.completionId))).toEqual(
      new Set(rows.map((row) => row.completion_id)),
    );
    expect(drained.records.reduce((sum, row) => sum + row.totalCount, 0)).toBe(totalCount);
  });

  it('keeps offline export on the complete scoped local cache when remote history is unavailable', async () => {
    const cached = [
      makeRecord({ completionId: 'cached-1', date: '2026-07-20T09:00:00.000Z' }),
      makeRecord({ completionId: 'cached-2', date: '2026-07-19T09:00:00.000Z' }),
    ];
    await AsyncStorage.setItem('history', JSON.stringify(cached));
    mockFetchJapamHistoryRows.mockResolvedValue(null);

    const drained = await drainHistoryForUser(UID, undefined, { pageSize: 50 });

    expect(drained.complete).toBe(true);
    expect(drained.records.map((row) => row.completionId)).toEqual(['cached-1', 'cached-2']);
  });
});

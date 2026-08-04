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
import { __resetHistoryHydrationState, hydrateHistoryForUser, hydrateHistoryForUserDetails } from '../historyRepository';
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
});

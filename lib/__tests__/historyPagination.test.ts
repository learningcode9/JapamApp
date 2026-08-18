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
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    from: () => ({
      select: () => ({ eq: (...args: unknown[]) => mockSelectEq(...args) }),
    }),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetHistoryHydrationState,
  hydrateHistoryForUserDetails,
  loadMoreHistoryForUser,
} from '../historyRepository';

const UID = 'history-pagination-user';

const remoteRow = (id: string, createdAt: string) => ({
  id,
  created_at: createdAt,
  malas: 1,
  count: 108,
  user_name: 'Test User',
  completion_id: id,
  japam_id: 'japam-1',
  japam_name: 'Test Japam',
});

describe('history remote pagination', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    __resetHistoryHydrationState();
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
    mockSelectEq.mockResolvedValue({ data: [], error: null });
  });

  it('uses a bounded newest page, advances by keyset cursor, and reuses the page cache', async () => {
    mockFetchJapamHistoryRows
      .mockResolvedValueOnce([
        remoteRow('newest', '2026-08-18T10:00:00.000Z'),
        remoteRow('older', '2026-08-17T10:00:00.000Z'),
      ])
      .mockResolvedValueOnce([remoteRow('oldest', '2026-08-16T10:00:00.000Z')]);

    const initial = await hydrateHistoryForUserDetails(UID, undefined, { remotePageSize: 2 });
    expect(initial.hasMoreRemote).toBe(true);
    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);
    expect(mockFetchJapamHistoryRows).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: UID,
        limit: 2,
        order: { column: 'created_at', ascending: false },
        secondaryOrder: { column: 'completion_id', ascending: false },
        before: undefined,
      }),
    );

    const cached = await hydrateHistoryForUserDetails(UID, undefined, { remotePageSize: 2 });
    expect(cached.records).toHaveLength(2);
    expect(mockFetchJapamHistoryRows).toHaveBeenCalledTimes(1);

    const next = await loadMoreHistoryForUser(UID, undefined, { pageSize: 2 });
    expect(next.pageLoaded).toBe(true);
    expect(next.hasMoreRemote).toBe(false);
    expect(next.records.map((record) => record.completionId)).toEqual(
      expect.arrayContaining(['newest', 'older', 'oldest']),
    );
    expect(mockFetchJapamHistoryRows).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: UID,
        limit: 2,
        before: { createdAt: '2026-08-17T10:00:00.000Z', completionId: 'older' },
      }),
    );
    expect(mockFetchJapamHistoryRows.mock.calls.every(([options]) => options.limit === 2)).toBe(true);
  });

  it('keeps local history intact when the bounded remote read is unavailable', async () => {
    await AsyncStorage.setItem('history', JSON.stringify([{
      date: '2026-08-18T10:00:00.000Z',
      malas: 3,
      totalCount: 324,
      duration: 0,
      manual: false,
      userId: UID,
      completionId: 'local-history',
      syncStatus: 'synced',
    }]));
    mockFetchJapamHistoryRows.mockResolvedValue(null);

    const result = await hydrateHistoryForUserDetails(UID, undefined, { remotePageSize: 2 });

    expect(result.records.map((record) => record.completionId)).toEqual(['local-history']);
    expect(JSON.parse((await AsyncStorage.getItem('history')) || '[]')).toHaveLength(1);
  });
});

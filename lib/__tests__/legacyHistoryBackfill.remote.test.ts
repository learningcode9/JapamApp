const localStore: Record<string, string> = {};
const mockGetSession = jest.fn();
const mockRpc = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: jest.fn(async (key: string) => localStore[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { localStore[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete localStore[key]; }),
  },
  __esModule: true,
}));

jest.mock('../supabase', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

import { getGroupDashboard } from '../groupsRepository';
import {
  applyLegacyHistoryBackfill,
  loadHistoryForJapam,
} from '../historyRepository';
import { filterByJapam, type HistoryRecord } from '../historyStore';
import type { Japam } from '../japams';

const USER_ID = 'user-123';
const OTHER_USER_ID = 'user-other';
const DEFAULT_ID = 'default-japam';
const DEFAULT_NAME = 'My Japam';
const OTHER_ID = 'other-japam';
const OTHER_NAME = 'Govinda';

const defaultJapams: Japam[] = [
  {
    id: DEFAULT_ID,
    userId: USER_ID,
    name: DEFAULT_NAME,
    displayOrder: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
  },
  {
    id: OTHER_ID,
    userId: USER_ID,
    name: OTHER_NAME,
    displayOrder: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archivedAt: null,
  },
];

const legacyRecord = (
  completionId: string,
  malas: number,
  over: Partial<HistoryRecord> = {},
) => ({
  date: '2026-08-01T10:00:00.000Z',
  malas,
  totalCount: malas * 108,
  duration: 0,
  manual: false,
  userId: USER_ID,
  userName: 'Test User',
  completionId,
  syncStatus: 'synced' as const,
  japamId: null,
  japamName: null,
  ...over,
});

const remoteRows: Array<Record<string, unknown>> = [];

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});

beforeEach(async () => {
  Object.keys(localStore).forEach((key) => delete localStore[key]);
  remoteRows.splice(0, remoteRows.length,
    { id: 1, user_id: USER_ID, created_at: '2026-08-01T10:00:00.000Z', malas: 2, count: 216, completion_id: 'legacy-1', japam_id: null, japam_name: null },
    { id: 2, user_id: USER_ID, created_at: '2026-08-01T10:01:00.000Z', malas: 1, count: 108, completion_id: 'legacy-2', japam_id: null, japam_name: null },
    { id: 3, user_id: USER_ID, created_at: '2026-08-01T10:02:00.000Z', malas: 1, count: 108, completion_id: 'legacy-3', japam_id: null, japam_name: null },
    { id: 4, user_id: USER_ID, created_at: '2026-08-01T10:03:00.000Z', malas: 1, count: 108, completion_id: 'legacy-4', japam_id: null, japam_name: null },
    { id: 5, user_id: USER_ID, created_at: '2026-08-01T10:04:00.000Z', malas: 9, count: 972, completion_id: 'other-legacy', japam_id: null, japam_name: OTHER_NAME },
    { id: 6, user_id: OTHER_USER_ID, created_at: '2026-08-01T10:05:00.000Z', malas: 99, count: 10692, completion_id: 'other-user', japam_id: null, japam_name: null },
  );

  localStore.history = JSON.stringify([
    legacyRecord('legacy-1', 2),
    legacyRecord('legacy-2', 1),
    legacyRecord('legacy-3', 1),
    legacyRecord('legacy-4', 1),
    legacyRecord('other-legacy', 9, { japamName: OTHER_NAME }),
    legacyRecord('other-user', 99, { userId: OTHER_USER_ID }),
  ]);

  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'session-token' } } });
  mockRpc.mockReset();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://staging.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'staging-anon-key';

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return response(remoteRows.filter((row) => row.user_id === USER_ID));
    }

    const id = requestUrl.searchParams.get('id')?.replace(/^eq\./, '');
    const userId = requestUrl.searchParams.get('user_id')?.replace(/^eq\./, '');
    const row = remoteRows.find((candidate) => String(candidate.id) === id && candidate.user_id === userId);
    if (!row) return response([], false);
    Object.assign(row, JSON.parse(String(init?.body)));
    return response([]);
  }) as unknown as typeof fetch;

});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  jest.restoreAllMocks();
});

describe('legacy History backfill across History and Group', () => {
  it('persists only History-attributed default rows and both views show 5/540', async () => {
    const beforeHistory = await loadHistoryForJapam(
      USER_ID,
      DEFAULT_ID,
      DEFAULT_NAME,
      { includeBlankLegacy: true },
      defaultJapams,
    );
    expect(beforeHistory.reduce((sum, row) => sum + row.totalCount, 0)).toBe(540);

    const eligibleIds = new Set(
      filterByJapam(
        beforeHistory,
        DEFAULT_ID,
        DEFAULT_NAME,
        { includeBlankLegacy: true },
        defaultJapams,
      )
        .filter((row) => row.japamId == null)
        .map((row) => row.completionId)
    );

    const plan = await applyLegacyHistoryBackfill(
      USER_ID,
      DEFAULT_ID,
      DEFAULT_NAME,
      { onlyCompletionIds: eligibleIds, japams: defaultJapams },
    );

    expect(plan.reassignedRecords.map((row) => row.completionId).sort()).toEqual([
      'legacy-1', 'legacy-2', 'legacy-3', 'legacy-4',
    ]);
    expect(plan.remoteSyncedIds.sort()).toEqual([
      'legacy-1', 'legacy-2', 'legacy-3', 'legacy-4',
    ]);

    const persisted = JSON.parse(localStore.history) as HistoryRecord[];
    expect(persisted.filter((row) => row.userId === USER_ID && row.japamId === DEFAULT_ID))
      .toHaveLength(4);
    expect(persisted.find((row) => row.completionId === 'other-legacy'))
      .toMatchObject({ japamId: null, japamName: OTHER_NAME });
    expect(persisted.find((row) => row.completionId === 'other-user'))
      .toMatchObject({ userId: OTHER_USER_ID, japamId: null });

    const afterHistory = await loadHistoryForJapam(USER_ID, DEFAULT_ID, DEFAULT_NAME, {}, defaultJapams);
    expect(afterHistory.reduce((sum, row) => sum + row.totalCount, 0)).toBe(540);
    expect(afterHistory.every((row) => row.japamId === DEFAULT_ID)).toBe(true);

    mockRpc.mockImplementation(async (_name: string, args: { p_japam_id: string }) => {
      const scoped = remoteRows.filter(
        (row) => row.user_id === USER_ID && row.japam_id === args.p_japam_id,
      );
      return {
        data: [{
          user_id: USER_ID,
          user_name: 'Test User',
          role: 'member',
          joined_at: '2026-01-01T00:00:00.000Z',
          today_malas: scoped.reduce((sum, row) => sum + Number(row.malas), 0),
          today_count: scoped.reduce((sum, row) => sum + Number(row.count), 0),
          total_malas: scoped.reduce((sum, row) => sum + Number(row.malas), 0),
          total_count: scoped.reduce((sum, row) => sum + Number(row.count), 0),
          last_updated: '2026-08-01T10:03:00.000Z',
        }],
        error: null,
      };
    });

    const groupRows = await getGroupDashboard(
      'group-1',
      USER_ID,
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
      DEFAULT_ID,
    );
    expect(groupRows[0]).toMatchObject({ todayMalas: 5, todayCount: 540, totalMalas: 5, totalCount: 540 });
    expect(mockRpc).toHaveBeenCalledWith('get_group_dashboard', expect.objectContaining({ p_japam_id: DEFAULT_ID }));
  });
});

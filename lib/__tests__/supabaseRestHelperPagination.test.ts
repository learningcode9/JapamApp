import { fetchJapamHistoryRows, resetFetchCoalesceCache } from '../supabaseRestHelper';
import { supabase } from '../supabase';

jest.mock('../supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    from: jest.fn(),
  },
}));

const mockGetSession = supabase.auth.getSession as jest.Mock;
const mockFrom = supabase.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetFetchCoalesceCache();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
});

it('builds a bounded keyset query for an older japam_history page', async () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn((resolve: (value: unknown) => void) => resolve({ data: [], error: null })),
  };
  mockFrom.mockReturnValue(chain);

  await fetchJapamHistoryRows({
    select: 'id,created_at,completion_id',
    userId: 'user-1',
    order: { column: 'created_at', ascending: false },
    secondaryOrder: { column: 'completion_id', ascending: false },
    before: { createdAt: '2026-08-17T10:00:00.000Z', completionId: 'older' },
    limit: 50,
  });

  expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false });
  expect(chain.order).toHaveBeenNthCalledWith(2, 'completion_id', { ascending: false });
  expect(chain.or).toHaveBeenCalledWith(
    'created_at.lt.2026-08-17T10:00:00.000Z,and(created_at.eq.2026-08-17T10:00:00.000Z,completion_id.lt.older)',
  );
  expect(chain.limit).toHaveBeenCalledWith(50);
});

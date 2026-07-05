import { isDuplicateSummary, getUnsubscribedUserIds, getActiveUsersInPeriod } from '../email/dataAccess';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Minimal fake that supports exactly the query chain isDuplicateSummary
 * uses: from().select().eq().eq().in().order().limit() -> { data, error }.
 * Each method returns `this` except the final `limit`, which resolves.
 */
function fakeSupabase(rows: Array<{ period_end: string }>): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

/**
 * Fake supporting getActiveUsersInPeriod's full query set: japam_history
 * (activity), user_email_preferences (unsubscribes), and auth.admin.listUsers.
 */
function fakeSupabaseForActiveUsers(params: {
  activityUserIds: string[];
  unsubscribedUserIds: string[];
  authUsers: Array<{ id: string; email: string }>;
}): SupabaseClient {
  const { activityUserIds, unsubscribedUserIds, authUsers } = params;

  const japamHistoryChain = {
    select: () => japamHistoryChain,
    gte: () => japamHistoryChain,
    lte: () => japamHistoryChain,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: activityUserIds.map(user_id => ({ user_id })), error: null }),
  };

  const preferencesChain = {
    select: () => preferencesChain,
    not: () => preferencesChain,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: unsubscribedUserIds.map(user_id => ({ user_id })), error: null }),
  };

  return {
    from: (table: string) => (table === 'japam_history' ? japamHistoryChain : preferencesChain),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: authUsers }, error: null }),
      },
    },
  } as unknown as SupabaseClient;
}

describe('isDuplicateSummary (15-day cadence enforcement)', () => {
  it('is not a duplicate when the user has never received this campaign', async () => {
    const supabase = fakeSupabase([]);
    const result = await isDuplicateSummary(supabase, 'u1', '15day_inspiration', '2026-06-20');
    expect(result).toBe(false);
  });

  it('IS a duplicate when the most recent send`s period overlaps the new period start', async () => {
    // Most recent send covered up through 2026-06-25. A new run computing
    // periodStart=2026-06-20 (e.g. because the sender was invoked again the
    // very next day, or via a daily cron) must be blocked — fewer than
    // periodDays have elapsed since the last send.
    const supabase = fakeSupabase([{ period_end: '2026-06-25' }]);
    const result = await isDuplicateSummary(supabase, 'u1', '15day_inspiration', '2026-06-20');
    expect(result).toBe(true);
  });

  it('is NOT a duplicate once a full period has elapsed since the last send', async () => {
    // Last send's period ended 2026-06-19; a new period starting 2026-06-20
    // or later is a legitimate next send.
    const supabase = fakeSupabase([{ period_end: '2026-06-19' }]);
    const result = await isDuplicateSummary(supabase, 'u1', '15day_inspiration', '2026-06-20');
    expect(result).toBe(false);
  });

  it('does not re-flag as duplicate on the exact boundary day after the prior period ended', async () => {
    const supabase = fakeSupabase([{ period_end: '2026-06-20' }]);
    // A new period starting the day after prior period_end is a legitimate next send.
    const result = await isDuplicateSummary(supabase, 'u1', '15day_inspiration', '2026-06-21');
    expect(result).toBe(false);
  });
});

describe('getUnsubscribedUserIds', () => {
  it('returns an empty set when nobody has unsubscribed', async () => {
    const supabase = fakeSupabaseForActiveUsers({
      activityUserIds: [],
      unsubscribedUserIds: [],
      authUsers: [],
    });
    const result = await getUnsubscribedUserIds(supabase);
    expect(result.size).toBe(0);
  });

  it('returns the set of unsubscribed user ids', async () => {
    const supabase = fakeSupabaseForActiveUsers({
      activityUserIds: [],
      unsubscribedUserIds: ['u2', 'u3'],
      authUsers: [],
    });
    const result = await getUnsubscribedUserIds(supabase);
    expect(result.has('u2')).toBe(true);
    expect(result.has('u3')).toBe(true);
    expect(result.has('u1')).toBe(false);
  });
});

describe('getActiveUsersInPeriod (unsubscribe + allowlist enforcement)', () => {
  const ORIGINAL_ALLOWLIST = process.env.EMAIL_ALLOWLIST;

  afterEach(() => {
    if (ORIGINAL_ALLOWLIST === undefined) {
      delete process.env.EMAIL_ALLOWLIST;
    } else {
      process.env.EMAIL_ALLOWLIST = ORIGINAL_ALLOWLIST;
    }
  });

  it('excludes users who have unsubscribed, even though they are active', async () => {
    delete process.env.EMAIL_ALLOWLIST;
    const supabase = fakeSupabaseForActiveUsers({
      activityUserIds: ['u1', 'u2'],
      unsubscribedUserIds: ['u2'],
      authUsers: [
        { id: 'u1', email: 'user1@example.com' },
        { id: 'u2', email: 'user2@example.com' },
      ],
    });

    const result = await getActiveUsersInPeriod(supabase, '2026-06-20', '2026-07-04');

    expect(result.map(u => u.id)).toEqual(['u1']);
  });

  it('restricts to EMAIL_ALLOWLIST addresses when set', async () => {
    process.env.EMAIL_ALLOWLIST = 'user1@example.com';
    const supabase = fakeSupabaseForActiveUsers({
      activityUserIds: ['u1', 'u2'],
      unsubscribedUserIds: [],
      authUsers: [
        { id: 'u1', email: 'user1@example.com' },
        { id: 'u2', email: 'user2@example.com' },
      ],
    });

    const result = await getActiveUsersInPeriod(supabase, '2026-06-20', '2026-07-04');

    expect(result.map(u => u.id)).toEqual(['u1']);
  });

  it('applies no restriction when EMAIL_ALLOWLIST is unset (default behavior preserved)', async () => {
    delete process.env.EMAIL_ALLOWLIST;
    const supabase = fakeSupabaseForActiveUsers({
      activityUserIds: ['u1', 'u2'],
      unsubscribedUserIds: [],
      authUsers: [
        { id: 'u1', email: 'user1@example.com' },
        { id: 'u2', email: 'user2@example.com' },
      ],
    });

    const result = await getActiveUsersInPeriod(supabase, '2026-06-20', '2026-07-04');

    expect(result.map(u => u.id).sort()).toEqual(['u1', 'u2']);
  });

  it('applies both filters together', async () => {
    process.env.EMAIL_ALLOWLIST = 'user1@example.com,user2@example.com';
    const supabase = fakeSupabaseForActiveUsers({
      activityUserIds: ['u1', 'u2', 'u3'],
      unsubscribedUserIds: ['u2'],
      authUsers: [
        { id: 'u1', email: 'user1@example.com' },
        { id: 'u2', email: 'user2@example.com' },
        { id: 'u3', email: 'user3@example.com' },
      ],
    });

    const result = await getActiveUsersInPeriod(supabase, '2026-06-20', '2026-07-04');

    // u2 is allowlisted but unsubscribed; u3 is active but not allowlisted.
    expect(result.map(u => u.id)).toEqual(['u1']);
  });
});

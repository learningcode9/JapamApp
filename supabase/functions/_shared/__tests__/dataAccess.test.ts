import { isDuplicateSummary } from '../email/dataAccess';
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

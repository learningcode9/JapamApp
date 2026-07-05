// Shared Supabase data-access functions used by every email service
// (SummaryEmailService and the generic CampaignEmailService alike).
// Extracted so query logic exists in exactly one place — adding a new
// campaign never means re-writing "find active users" or "check for a
// duplicate send" again.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser, JapamHistoryRow, EmailSummaryRecord } from './types';

export async function getActiveUsersInPeriod(
  supabase: SupabaseClient,
  periodStart: string,
  periodEnd: string,
): Promise<AuthUser[]> {
  const { data: activityRows, error: activityErr } = await supabase
    .from('japam_history')
    .select('user_id')
    .gte('created_at', `${periodStart}T00:00:00.000Z`)
    .lte('created_at', `${periodEnd}T23:59:59.999Z`);

  if (activityErr) {
    throw new Error(`getActiveUsersInPeriod: japam_history query failed — ${activityErr.message}`);
  }
  if (!activityRows?.length) return [];

  const activeIds = new Set(activityRows.map(r => r.user_id as string).filter(Boolean));
  if (activeIds.size === 0) return [];

  const { data: { users }, error: authErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (authErr) {
    throw new Error(`getActiveUsersInPeriod: auth.admin.listUsers failed — ${authErr.message}`);
  }

  return (users ?? [])
    .filter(u => u.email && activeIds.has(u.id))
    .map(u => ({
      id: u.id,
      email: u.email!,
      displayName:
        (u.user_metadata?.full_name as string | undefined) ??
        (u.user_metadata?.name as string | undefined),
    }));
}

export async function getHistoryForUser(
  supabase: SupabaseClient,
  userId: string,
  periodStart: string,
  periodEnd: string,
): Promise<JapamHistoryRow[]> {
  // NOTE: `source` is deliberately NOT in this select. The live `japam_history`
  // table (schema.sql) has no `source` column — selecting it errors with
  // "column japam_history.source does not exist" against real Supabase data
  // (confirmed in the paused email-campaign Phase 0 investigation). types.ts
  // already types `source` as optional and calculator.ts already handles its
  // absence gracefully (`breakdown: null`), so omitting it here changes
  // nothing observable — it only prevents a query that would otherwise fail
  // on every real (non-fake-data) run.
  const { data, error } = await supabase
    .from('japam_history')
    .select('user_id, user_name, malas, count, created_at, completion_id')
    .eq('user_id', userId)
    .gte('created_at', `${periodStart}T00:00:00.000Z`)
    .lte('created_at', `${periodEnd}T23:59:59.999Z`);

  if (error) {
    throw new Error(`getHistoryForUser(${userId}): ${error.message}`);
  }
  return (data ?? []) as JapamHistoryRow[];
}

export interface LifetimeStats {
  lifetimeTotalMalas: number;
  /** ISO timestamp of the user's earliest japam_history row, or null if they have none. */
  firstActivityAt: string | null;
}

/**
 * Full-history (all-time) stats for a user — used for the "lifetime total"
 * stat shown in inspirational campaigns, and to gate brand-new users out of
 * a campaign whose copy assumes an established practice (see
 * campaignService.ts's "too new" eligibility check). Combines what used to
 * be two separate full-table-scan queries (a sum and a min) into one.
 */
export async function getLifetimeStats(
  supabase: SupabaseClient,
  userId: string,
): Promise<LifetimeStats> {
  const { data, error } = await supabase
    .from('japam_history')
    .select('malas, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`getLifetimeStats(${userId}): ${error.message}`);
  }

  const rows = data ?? [];
  return {
    lifetimeTotalMalas: rows.reduce((sum, row) => sum + (Number(row.malas) || 0), 0),
    firstActivityAt: rows.length > 0 ? (rows[0].created_at as string) : null,
  };
}

export async function isDuplicateSummary(
  supabase: SupabaseClient,
  userId: string,
  emailType: string,
  periodStart: string,
): Promise<boolean> {
  // Deliberately NOT an exact match on period_start. periodStart is computed
  // as "today - (periodDays-1)" at call time (see calculator.ts), so it is a
  // different value every single day. An exact-match check only catches a
  // second run on the *same calendar day* — if the sender is ever invoked
  // more than once per period (e.g. a daily cron, which this repo's own
  // SUMMARY_EMAIL_SETUP.md docs suggest as a valid scheduling option), every
  // active user would receive a new email every day instead of every N days.
  //
  // Instead, look at the most recent sent/dry_run record for this user+type
  // and treat it as a duplicate if its period still overlaps with (or ends
  // after) the start of the period being computed now — i.e. fewer than
  // `periodDays` have elapsed since the last send.
  const { data, error } = await supabase
    .from('user_email_summaries')
    .select('period_end')
    .eq('user_id', userId)
    .eq('email_type', emailType)
    .in('status', ['sent', 'dry_run'])
    .order('period_start', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`isDuplicateSummary(${userId}): ${error.message}`);
  }
  if (!data?.length) return false;

  return data[0].period_end >= periodStart;
}

export async function recordSummary(
  supabase: SupabaseClient,
  record: Omit<EmailSummaryRecord, 'id' | 'created_at'>,
): Promise<void> {
  const { error } = await supabase
    .from('user_email_summaries')
    .upsert(record, { onConflict: 'user_id,email_type,period_start' });

  if (error) {
    throw new Error(`recordSummary: ${error.message}`);
  }
}

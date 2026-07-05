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
  const { data, error } = await supabase
    .from('japam_history')
    .select('user_id, user_name, malas, count, created_at, completion_id, source')
    .eq('user_id', userId)
    .gte('created_at', `${periodStart}T00:00:00.000Z`)
    .lte('created_at', `${periodEnd}T23:59:59.999Z`);

  if (error) {
    throw new Error(`getHistoryForUser(${userId}): ${error.message}`);
  }
  return (data ?? []) as JapamHistoryRow[];
}

/**
 * Full-history (all-time) total malas for a user — used for the "lifetime
 * total" stat shown in inspirational campaigns. Deliberately separate from
 * `getHistoryForUser`, which is period-bounded.
 */
export async function getLifetimeTotalMalas(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('japam_history')
    .select('malas')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`getLifetimeTotalMalas(${userId}): ${error.message}`);
  }
  return (data ?? []).reduce((sum, row) => sum + (Number(row.malas) || 0), 0);
}

export async function isDuplicateSummary(
  supabase: SupabaseClient,
  userId: string,
  emailType: string,
  periodStart: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_email_summaries')
    .select('id')
    .eq('user_id', userId)
    .eq('email_type', emailType)
    .eq('period_start', periodStart)
    .in('status', ['sent', 'dry_run'])
    .limit(1);

  if (error) {
    throw new Error(`isDuplicateSummary(${userId}): ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
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

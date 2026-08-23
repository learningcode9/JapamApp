// Shared Supabase data-access functions used by every email service
// (SummaryEmailService and the generic CampaignEmailService alike).
// Extracted so query logic exists in exactly one place — adding a new
// campaign never means re-writing "find active users" or "check for a
// duplicate send" again.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { AuthUser, JapamHistoryRow, EmailSummaryRecord } from './types.ts';
import { parseAllowlist, parseExcludedEmails } from './config.ts';
import { getEnv } from './env.ts';

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_USERS_PAGE_SIZE = 1000;

/**
 * Auth admin listUsers is paginated at 1,000 users per request. Fetch pages
 * sequentially so a campaign never silently ignores users beyond page one.
 * The seen set protects against an overlapping/duplicated page.
 */
async function* listAllAuthUsers(supabase: SupabaseClient) {
  const seenUserIds = new Set<string>();

  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });

    if (error) {
      throw new Error(`listAllAuthUsers: auth.admin.listUsers failed on page ${page} — ${error.message}`);
    }

    const users = data?.users ?? [];
    let newUsersOnPage = 0;
    for (const user of users) {
      if (seenUserIds.has(user.id)) continue;
      seenUserIds.add(user.id);
      newUsersOnPage += 1;
      yield user;
    }

    // A short page is the normal end condition. The second condition also
    // prevents an accidental repeated full page from causing an infinite loop.
    if (users.length < AUTH_USERS_PAGE_SIZE || newUsersOnPage === 0) break;
  }
}

export function isValidEmail(email: string | null | undefined): email is string {
  const normalized = email?.trim();
  return Boolean(normalized && normalized.length <= 254 && SIMPLE_EMAIL_PATTERN.test(normalized));
}

/**
 * user_ids with a non-null unsubscribed_at in user_email_preferences — i.e.
 * everyone who has opted out of campaign emails. See the 20260705 migration
 * for why this is its own table rather than a column on user_profiles.
 */
export async function getUnsubscribedUserIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('user_email_preferences')
    .select('user_id')
    .not('unsubscribed_at', 'is', null);

  if (error) {
    throw new Error(`getUnsubscribedUserIds: ${error.message}`);
  }
  return new Set((data ?? []).map(r => r.user_id as string));
}

export async function markUserUnsubscribed(
  supabase: SupabaseClient,
  userId: string,
  unsubscribedAt = new Date().toISOString(),
): Promise<void> {
  const { error } = await supabase.from('user_email_preferences').upsert(
    {
      user_id: userId,
      unsubscribed_at: unsubscribedAt,
      reason: 'unsubscribe_link',
    },
    { onConflict: 'user_id' },
  );

  if (error) {
    throw new Error(`markUserUnsubscribed: ${error.message}`);
  }
}

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

  const unsubscribedIds = await getUnsubscribedUserIds(supabase);

  // EMAIL_ALLOWLIST, when set, restricts every campaign to only the listed
  // addresses — intended for controlled testing against real production
  // data without emailing real users. Unset (the default) means no
  // restriction, identical to behavior before this filter existed.
  const allowlist = parseAllowlist(getEnv('EMAIL_ALLOWLIST'));

  const users: AuthUser[] = [];
  for await (const user of listAllAuthUsers(supabase)) {
    if (!isValidEmail(user.email) || !activeIds.has(user.id)) continue;
    if (unsubscribedIds.has(user.id)) continue;
    if (allowlist !== null && !allowlist.has(user.email!.trim().toLowerCase())) continue;

    users.push({
      id: user.id,
      email: user.email!.trim(),
      createdAt: user.created_at,
      displayName:
        (user.user_metadata?.full_name as string | undefined) ??
        (user.user_metadata?.name as string | undefined),
    });
  }
  return users;
}

/**
 * Loads auth users for campaign eligibility decisions without pre-filtering
 * by activity. The campaign service intentionally owns the deterministic
 * decision order so dry-runs can explain invalid, excluded, suppressed, and
 * no-activity skips instead of silently dropping them.
 */
export async function getCampaignCandidates(supabase: SupabaseClient): Promise<AuthUser[]> {
  const unsubscribedIds = await getUnsubscribedUserIds(supabase);

  // Preserve the existing operator safety valve for campaign runs. When set,
  // only explicitly listed valid addresses enter the decision loop.
  const allowlist = parseAllowlist(getEnv('EMAIL_ALLOWLIST'));
  const excludedEmails = parseExcludedEmails(getEnv('EMAIL_CAMPAIGN_EXCLUDED_EMAILS'));
  const users: AuthUser[] = [];
  for await (const user of listAllAuthUsers(supabase)) {
      const email = user.email?.trim() ?? '';
      users.push({
        id: user.id,
        email,
        createdAt: user.created_at,
        displayName:
          (user.user_metadata?.full_name as string | undefined) ??
          (user.user_metadata?.name as string | undefined),
        isUnsubscribed: unsubscribedIds.has(user.id),
        isExcluded: excludedEmails.has(email.toLowerCase()),
      });
  }
  return users.filter(user =>
    allowlist === null || (isValidEmail(user.email) && allowlist.has(user.email.toLowerCase())),
  );
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
  lifetimeTotalCount: number;
  /** ISO timestamp of the user's earliest japam_history row, or null if they have none. */
  firstActivityAt: string | null;
}

/**
 * Full-history (all-time) stats for a user — used for the lifetime stats shown
 * in inspirational campaigns. The campaign's activity eligibility is evaluated
 * separately from these totals. Combines what used to be two separate
 * full-table-scan queries (a sum and a min) into one.
 */
export async function getLifetimeStats(
  supabase: SupabaseClient,
  userId: string,
): Promise<LifetimeStats> {
  const { data, error } = await supabase
    .from('japam_history')
    .select('malas, count, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`getLifetimeStats(${userId}): ${error.message}`);
  }

  const rows = data ?? [];
  return {
    lifetimeTotalMalas: rows.reduce((sum, row) => sum + (Number(row.malas) || 0), 0),
    lifetimeTotalCount: rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
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
  // Instead, look at the most recent sent/pending record for this user+type
  // and treat it as a duplicate if its period still overlaps with (or ends
  // after) the start of the period being computed now — i.e. fewer than
  // `periodDays` have elapsed since the last send.
  const { data, error } = await supabase
    .from('user_email_summaries')
    .select('period_end')
    .eq('user_id', userId)
    .eq('email_type', emailType)
    .in('status', ['sent', 'pending'])
    .order('period_start', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`isDuplicateSummary(${userId}): ${error.message}`);
  }
  if (!data?.length) return false;

  return data[0].period_end >= periodStart;
}

/**
 * Checks the recurring campaign's fixed cycle and enforces a full-period gap
 * from the previous successful send. Pending rows remain a permanent automatic
 * block because they may represent an ambiguous provider outcome. Dry-run rows
 * are deliberately ignored: this campaign never writes them, and they must
 * never block a real send. The unique (user_id, email_type, period_start)
 * constraint remains the atomic claim boundary for all new rows.
 */
export async function isCampaignCycleDuplicate(
  supabase: SupabaseClient,
  userId: string,
  emailType: string,
  cycleStart: string,
  cycleEnd: string,
  periodDays: number,
  now = new Date(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_email_summaries')
    .select('period_start, period_end, status, sent_at')
    .eq('user_id', userId)
    .eq('email_type', emailType)
    .in('status', ['sent', 'pending']);

  if (error) {
    throw new Error(`isCampaignCycleDuplicate(${userId}): ${error.message}`);
  }
  const minimumSpacingMs = periodDays * 86_400_000;
  const nowMs = now.getTime();

  return (data ?? []).some(record => {
    if (record.status === 'pending') return true;

    const sameCycle = record.period_end >= cycleStart && record.period_start <= cycleEnd;
    if (sameCycle) return true;

    // Legacy successful rows may not have sent_at. Their period_end is a
    // conservative lower bound for the previous send time, so they do not
    // become a permanent block while still protecting the spacing boundary.
    const sentAtMs = Date.parse(record.sent_at ?? `${record.period_end}T23:59:59.999Z`);
    if (!Number.isFinite(sentAtMs)) return true;

    return nowMs - sentAtMs < minimumSpacingMs;
  });
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

/**
 * Atomically claims a user/campaign/period slot for sending.
 *
 * The unique constraint handles the first claim race. A failed claim may be
 * retried by conditionally moving only that failed row back to pending; sent
 * and in-flight rows remain owned by their original attempt. The caller must
 * use the same provider idempotency key when retrying after an uncertain
 * provider response.
 */
export async function claimSummary(
  supabase: SupabaseClient,
  record: Omit<EmailSummaryRecord, 'id' | 'created_at'>,
): Promise<boolean> {
  const inserted = await supabase
    .from('user_email_summaries')
    .upsert(record, {
      onConflict: 'user_id,email_type,period_start',
      ignoreDuplicates: true,
    })
    .select('id');

  if (inserted.error) {
    throw new Error(`claimSummary: ${inserted.error.message}`);
  }
  if ((inserted.data ?? []).length > 0) return true;

  const retried = await supabase
    .from('user_email_summaries')
    .update({
      period_end: record.period_end,
      sent_at: null,
      status: 'pending',
      provider_message_id: null,
      error: null,
    })
    .eq('user_id', record.user_id)
    .eq('email_type', record.email_type)
    .eq('period_start', record.period_start)
    .eq('status', 'failed')
    .select('id');

  if (retried.error) {
    throw new Error(`claimSummary retry: ${retried.error.message}`);
  }
  return (retried.data ?? []).length > 0;
}

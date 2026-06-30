import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EmailProvider } from './emailProvider';
import type {
  JapamHistoryRow,
  AuthUser,
  EmailSummaryRecord,
  SummaryRunOptions,
  SummaryRunResult,
} from './types';
import { calculateSummaryStats, getPeriodDates } from './calculator';
import { buildEmailHtml, buildEmailText } from './template';

const EMAIL_TYPE = '15day_summary';
const EMAIL_SUBJECT = '🙏 Your 15-Day Japam Journey';

// ─── Service ──────────────────────────────────────────────────────────────────

export class SummaryEmailService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly emailProvider: EmailProvider | null,
    private readonly fromAddress: string,
    private readonly appUrl: string = '',
  ) {}

  async run(options: SummaryRunOptions): Promise<SummaryRunResult[]> {
    const { dryRun, periodDays = 15, forceResend = false } = options;
    const { periodStart, periodEnd } = getPeriodDates(periodDays);

    console.log(
      `[SummaryEmail] period=${periodStart}→${periodEnd}  dryRun=${dryRun}  forceResend=${forceResend}`,
    );

    const users = await this.getActiveUsers(periodStart, periodEnd);
    console.log(`[SummaryEmail] ${users.length} user(s) with activity in period`);

    const results: SummaryRunResult[] = [];

    for (const user of users) {
      const result = await this.processUser(user, periodStart, periodEnd, dryRun, forceResend);
      results.push(result);
      const extra = result.reason ? ` — ${result.reason}` : result.messageId ? ` (${result.messageId})` : '';
      console.log(`[SummaryEmail] ${user.email}: ${result.status}${extra}`);
    }

    const counts = results.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
      {},
    );
    console.log('[SummaryEmail] done', counts);

    return results;
  }

  // ─── Data access (protected for test subclassing) ─────────────────────────

  protected async getActiveUsers(periodStart: string, periodEnd: string): Promise<AuthUser[]> {
    const { data: activityRows, error: activityErr } = await this.supabase
      .from('japam_history')
      .select('user_id')
      .gte('created_at', `${periodStart}T00:00:00.000Z`)
      .lte('created_at', `${periodEnd}T23:59:59.999Z`);

    if (activityErr) {
      throw new Error(`getActiveUsers: japam_history query failed — ${activityErr.message}`);
    }
    if (!activityRows?.length) return [];

    const activeIds = new Set(activityRows.map(r => r.user_id as string).filter(Boolean));
    if (activeIds.size === 0) return [];

    const { data: { users }, error: authErr } = await this.supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (authErr) {
      throw new Error(`getActiveUsers: auth.admin.listUsers failed — ${authErr.message}`);
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

  protected async getHistoryForUser(
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<JapamHistoryRow[]> {
    const { data, error } = await this.supabase
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

  protected async isDuplicate(userId: string, periodStart: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('user_email_summaries')
      .select('id')
      .eq('user_id', userId)
      .eq('email_type', EMAIL_TYPE)
      .eq('period_start', periodStart)
      .in('status', ['sent', 'dry_run'])
      .limit(1);

    if (error) {
      throw new Error(`isDuplicate(${userId}): ${error.message}`);
    }
    return (data?.length ?? 0) > 0;
  }

  protected async recordSummary(record: Omit<EmailSummaryRecord, 'id' | 'created_at'>): Promise<void> {
    const { error } = await this.supabase
      .from('user_email_summaries')
      .upsert(record, { onConflict: 'user_id,email_type,period_start' });

    if (error) {
      throw new Error(`recordSummary: ${error.message}`);
    }
  }

  // ─── Per-user orchestration ────────────────────────────────────────────────

  private async processUser(
    user: AuthUser,
    periodStart: string,
    periodEnd: string,
    dryRun: boolean,
    forceResend: boolean,
  ): Promise<SummaryRunResult> {
    try {
      if (!forceResend && (await this.isDuplicate(user.id, periodStart))) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_duplicate',
          reason: 'already sent for this period',
        };
      }

      const rows = await this.getHistoryForUser(user.id, periodStart, periodEnd);
      const stats = calculateSummaryStats(user.id, user.email, rows, periodStart, periodEnd);

      if (!stats) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_no_activity',
          reason: 'no japam activity in period',
        };
      }

      if (dryRun) {
        console.log('[DRY RUN] Would send to:', user.email);
        console.log('[DRY RUN] Stats:', JSON.stringify(stats, null, 2));
        await this.recordSummary({
          user_id: user.id,
          email_type: EMAIL_TYPE,
          period_start: periodStart,
          period_end: periodEnd,
          sent_at: null,
          status: 'dry_run',
          provider_message_id: null,
          error: null,
        });
        return { userId: user.id, email: user.email, status: 'dry_run' };
      }

      if (!this.emailProvider) {
        throw new Error('emailProvider is null — pass dryRun:true or provide a provider');
      }

      // Mark pending before attempting send to prevent races
      await this.recordSummary({
        user_id: user.id,
        email_type: EMAIL_TYPE,
        period_start: periodStart,
        period_end: periodEnd,
        sent_at: null,
        status: 'pending',
        provider_message_id: null,
        error: null,
      });

      const html = buildEmailHtml(stats, this.appUrl);
      const text = buildEmailText(stats, this.appUrl);

      const { messageId } = await this.emailProvider.sendEmail({
        to: user.email,
        from: this.fromAddress,
        subject: EMAIL_SUBJECT,
        html,
        text,
      });

      await this.recordSummary({
        user_id: user.id,
        email_type: EMAIL_TYPE,
        period_start: periodStart,
        period_end: periodEnd,
        sent_at: new Date().toISOString(),
        status: 'sent',
        provider_message_id: messageId,
        error: null,
      });

      return { userId: user.id, email: user.email, status: 'sent', messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort failure record — do not rethrow, continue to next user
      await this.recordSummary({
        user_id: user.id,
        email_type: EMAIL_TYPE,
        period_start: periodStart,
        period_end: periodEnd,
        sent_at: null,
        status: 'failed',
        provider_message_id: null,
        error: message,
      }).catch(() => {/* ignore secondary failure */});

      return { userId: user.id, email: user.email, status: 'failed', reason: message };
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSummaryEmailService(
  emailProvider: EmailProvider | null,
): SummaryEmailService {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS ?? 'Japam App <noreply@japamapp.com>';
  const appUrl = process.env.APP_URL ?? '';

  if (!url) throw new Error('SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) env var is required');
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY env var is required');

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return new SummaryEmailService(supabase, emailProvider, from, appUrl);
}

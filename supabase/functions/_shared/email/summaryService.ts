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
import * as dataAccess from './dataAccess';

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
    return dataAccess.getActiveUsersInPeriod(this.supabase, periodStart, periodEnd);
  }

  protected async getHistoryForUser(
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<JapamHistoryRow[]> {
    return dataAccess.getHistoryForUser(this.supabase, userId, periodStart, periodEnd);
  }

  protected async isDuplicate(userId: string, periodStart: string): Promise<boolean> {
    return dataAccess.isDuplicateSummary(this.supabase, userId, EMAIL_TYPE, periodStart);
  }

  protected async recordSummary(record: Omit<EmailSummaryRecord, 'id' | 'created_at'>): Promise<void> {
    return dataAccess.recordSummary(this.supabase, record);
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

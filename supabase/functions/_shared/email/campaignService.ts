import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EmailProvider } from './emailProvider';
import type { AuthUser, JapamHistoryRow, EmailSummaryRecord, SummaryRunResult } from './types';
import type { CampaignDefinition } from './campaigns/types';
import type { EmailConfig } from './config';
import { calculateSummaryStats, getPeriodDates } from './calculator';
import { loadEmailConfig } from './config';
import * as dataAccess from './dataAccess';

export interface CampaignRunOptions {
  dryRun: boolean;
  /** Skip the duplicate check and re-send regardless. */
  forceResend?: boolean;
}

/**
 * Generic engine that runs any CampaignDefinition against every user active
 * in that campaign's period window: find active users, skip anyone already
 * sent-to this period, compute stats + lifetime totals, render, send, and
 * record the outcome in `user_email_summaries` (keyed by the campaign's own
 * `id` as `email_type`, so no per-campaign DB migration is ever needed).
 *
 * Data-access methods are `protected` for the same reason they are in
 * SummaryEmailService: tests subclass this service and replace them with
 * fakes rather than mocking the Supabase query builder.
 */
export class CampaignEmailService {
  constructor(
    private readonly campaign: CampaignDefinition,
    private readonly supabase: SupabaseClient,
    private readonly emailProvider: EmailProvider | null,
    private readonly config: EmailConfig,
  ) {}

  async run(options: CampaignRunOptions): Promise<SummaryRunResult[]> {
    const { dryRun, forceResend = false } = options;
    const { periodStart, periodEnd } = getPeriodDates(this.campaign.periodDays);

    console.log(
      `[Campaign:${this.campaign.id}] period=${periodStart}→${periodEnd} dryRun=${dryRun} forceResend=${forceResend}`,
    );

    const users = await this.getActiveUsers(periodStart, periodEnd);
    console.log(`[Campaign:${this.campaign.id}] ${users.length} user(s) with activity in period`);

    const results: SummaryRunResult[] = [];
    for (const user of users) {
      const result = await this.processUser(user, periodStart, periodEnd, dryRun, forceResend);
      results.push(result);
      const extra = result.reason ? ` — ${result.reason}` : result.messageId ? ` (${result.messageId})` : '';
      console.log(`[Campaign:${this.campaign.id}] ${user.email}: ${result.status}${extra}`);
    }

    const counts = results.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
      {},
    );
    console.log(`[Campaign:${this.campaign.id}] done`, counts);

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

  protected async getLifetimeStats(userId: string): Promise<dataAccess.LifetimeStats> {
    return dataAccess.getLifetimeStats(this.supabase, userId);
  }

  protected async isDuplicate(userId: string, periodStart: string): Promise<boolean> {
    return dataAccess.isDuplicateSummary(this.supabase, userId, this.campaign.id, periodStart);
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
    const emailType = this.campaign.id;

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

      const { lifetimeTotalMalas, firstActivityAt } = await this.getLifetimeStats(user.id);

      // This campaign's copy ("fifteen days ago, you began...") assumes an
      // established practice of at least one full period. Without this
      // check, a user who signed up and practiced once yesterday would
      // immediately qualify (they have "activity in the period") and
      // receive a message that describes a journey they haven't had yet.
      if (firstActivityAt) {
        const daysSinceFirstActivity =
          (Date.parse(`${periodEnd}T23:59:59.999Z`) - Date.parse(firstActivityAt)) / 86_400_000;
        if (daysSinceFirstActivity < this.campaign.periodDays) {
          return {
            userId: user.id,
            email: user.email,
            status: 'skipped_too_new',
            reason: `first activity ${daysSinceFirstActivity.toFixed(1)} days ago — requires ${this.campaign.periodDays}`,
          };
        }
      }

      const ctx = { stats, lifetimeTotalMalas, config: this.config };

      if (dryRun) {
        console.log(`[Campaign:${emailType}] DRY RUN would send to:`, user.email);
        await this.recordSummary({
          user_id: user.id,
          email_type: emailType,
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

      // Mark pending before attempting send to prevent races.
      await this.recordSummary({
        user_id: user.id,
        email_type: emailType,
        period_start: periodStart,
        period_end: periodEnd,
        sent_at: null,
        status: 'pending',
        provider_message_id: null,
        error: null,
      });

      const html = this.campaign.buildHtml(ctx);
      const text = this.campaign.buildText(ctx);

      const { messageId } = await this.emailProvider.sendEmail({
        to: user.email,
        from: this.config.fromAddress,
        subject: this.campaign.subject,
        html,
        text,
      });

      await this.recordSummary({
        user_id: user.id,
        email_type: emailType,
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
      await this.recordSummary({
        user_id: user.id,
        email_type: emailType,
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

export function createCampaignService(
  campaign: CampaignDefinition,
  emailProvider: EmailProvider | null,
): CampaignEmailService {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) env var is required');
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY env var is required');

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return new CampaignEmailService(campaign, supabase, emailProvider, loadEmailConfig());
}

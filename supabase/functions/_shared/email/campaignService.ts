import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EmailProviderError } from './emailProvider';
import type { EmailProvider } from './emailProvider';
import type { AuthUser, JapamHistoryRow, EmailSummaryRecord, SummaryRunResult } from './types';
import type { CampaignDefinition } from './campaigns/types';
import type { EmailConfig } from './config';
import {
  calculateSummaryStats,
  getAccountAgeDays,
  getPeriodDates,
  isWithinAccountMilestoneWindow,
} from './calculator';
import { loadEmailConfig } from './config';
import { buildUnsubscribeUrl } from './unsubscribeToken';
import * as dataAccess from './dataAccess';

export interface CampaignRunOptions {
  dryRun: boolean;
  /** Injectable clock for deterministic local tests; production uses now. */
  now?: Date;
}

/**
 * Generic engine that runs any CampaignDefinition against campaign candidates:
 * it makes deterministic eligibility decisions, skips anyone already sent to
 * this milestone, computes stats + lifetime totals, renders, sends, and
 * records the outcome in `user_email_summaries` (keyed by the campaign's own
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
    const { dryRun, now = new Date() } = options;
    const { periodStart, periodEnd } = getPeriodDates(this.campaign.periodDays, now);

    console.log(
      `[Campaign:${this.campaign.id}] period=${periodStart}→${periodEnd} dryRun=${dryRun}`,
    );

    const users = await this.getActiveUsers(periodStart, periodEnd);
    console.log(`[Campaign:${this.campaign.id}] ${users.length} campaign candidate(s)`);

    const results: SummaryRunResult[] = [];
    for (const user of users) {
      const result = await this.processUser(user, periodStart, periodEnd, dryRun, now);
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
    void periodStart;
    void periodEnd;
    return dataAccess.getCampaignCandidates(this.supabase);
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

  /** Read-only advisory check; claimSummary remains the race-safe authority. */
  protected async isDuplicate(userId: string, periodStart: string): Promise<boolean> {
    return dataAccess.isDuplicateSummary(this.supabase, userId, this.campaign.id, periodStart);
  }

  protected async claimSummary(record: Omit<EmailSummaryRecord, 'id' | 'created_at'>): Promise<boolean> {
    return dataAccess.claimSummary(this.supabase, record);
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
    now: Date,
  ): Promise<SummaryRunResult> {
    const emailType = this.campaign.id;
    let claimed = false;
    let providerAccepted = false;

    try {
      if (!dataAccess.isValidEmail(user.email)) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_invalid_email',
          reason: 'missing or invalid recipient email',
        };
      }

      if (user.isExcluded) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_excluded',
          reason: 'explicitly excluded campaign recipient',
        };
      }

      if (user.isUnsubscribed) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_unsubscribed',
          reason: 'unsubscribed/suppressed',
        };
      }

      const accountAgeDays = getAccountAgeDays(user.createdAt, now);
      if (accountAgeDays === null) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_missing_account_age',
          reason: 'auth account creation timestamp is missing or invalid',
        };
      }
      if (accountAgeDays < this.campaign.periodDays) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_too_new',
          reason: `account is ${accountAgeDays} days old — requires ${this.campaign.periodDays}`,
        };
      }
      if (!isWithinAccountMilestoneWindow(accountAgeDays, this.campaign.periodDays)) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_outside_milestone',
          reason: `account is ${accountAgeDays} days old — ${this.campaign.periodDays}-day milestone window has passed`,
        };
      }

      if (await this.isDuplicate(user.id, periodStart)) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_duplicate',
          reason: 'already claimed or sent for this period',
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

      const { lifetimeTotalMalas } = await this.getLifetimeStats(user.id);

      if (dryRun) {
        const campaignConfig =
          this.config.unsubscribeUrl && this.config.unsubscribeSecret
            ? {
                ...this.config,
                unsubscribeUrl: await buildUnsubscribeUrl(
                  this.config.unsubscribeUrl,
                  user.id,
                  this.config.unsubscribeSecret,
                  now.getTime(),
                ),
              }
            : this.config;
        const ctx = { stats, lifetimeTotalMalas, config: campaignConfig };
        const html = this.campaign.buildHtml(ctx);
        const text = this.campaign.buildText(ctx);

        console.log(`[Campaign:${emailType}] DRY RUN would send to:`, user.email);
        console.log(`[Campaign:${emailType}] subject:`, this.campaign.subject);
        console.log(`[Campaign:${emailType}] stats:`, JSON.stringify(stats));
        console.log(`[Campaign:${emailType}] rendered bytes:`, html.length + text.length);
        return { userId: user.id, email: user.email, status: 'dry_run' };
      }

      if (!this.emailProvider) {
        throw new Error('emailProvider is null — pass dryRun:true or provide a provider');
      }

      if (!this.config.unsubscribeUrl || !this.config.unsubscribeSecret) {
        throw new Error(
          'a signed unsubscribe link requires unsubscribeUrl and unsubscribeSecret for a real campaign send',
        );
      }

      const campaignConfig = {
        ...this.config,
        unsubscribeUrl: await buildUnsubscribeUrl(
          this.config.unsubscribeUrl,
          user.id,
          this.config.unsubscribeSecret,
          now.getTime(),
        ),
      };
      const ctx = { stats, lifetimeTotalMalas, config: campaignConfig };

      const pendingRecord: Omit<EmailSummaryRecord, 'id' | 'created_at'> = {
        user_id: user.id,
        email_type: emailType,
        period_start: periodStart,
        period_end: periodEnd,
        sent_at: null,
        status: 'pending',
        provider_message_id: null,
        error: null,
      };

      // The unique key plus a conditional failed-row retry makes this claim
      // atomic across concurrent scheduler invocations.
      claimed = await this.claimSummary(pendingRecord);
      if (!claimed) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_duplicate',
          reason: 'already claimed or sent for this period',
        };
      }

      const html = this.campaign.buildHtml(ctx);
      const text = this.campaign.buildText(ctx);

      const { messageId } = await this.emailProvider.sendEmail({
        to: user.email,
        from: this.config.fromAddress,
        subject: this.campaign.subject,
        html,
        text,
        idempotencyKey: `${emailType}/${user.id}/${periodStart}`,
      });
      providerAccepted = true;

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
      if (claimed) {
        const safeToRetry = !(err instanceof EmailProviderError) || err.safeToRetry;
        await this.recordSummary({
          user_id: user.id,
          email_type: emailType,
          period_start: periodStart,
          period_end: periodEnd,
          sent_at: null,
          status: providerAccepted || !safeToRetry ? 'pending' : 'failed',
          provider_message_id: null,
          error: message,
        }).catch(() => {/* ignore secondary failure */});
      }

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

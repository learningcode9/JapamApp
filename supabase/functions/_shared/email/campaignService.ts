import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { EmailProviderError } from './emailProvider.ts';
import type { EmailProvider } from './emailProvider.ts';
import type { AuthUser, JapamHistoryRow, EmailSummaryRecord, SummaryRunResult } from './types.ts';
import type { CampaignDefinition } from './campaigns/types.ts';
import type { EmailConfig } from './config.ts';
import { calculateSummaryStats, getCampaignCycleDates, getPeriodDates } from './calculator.ts';
import { buildUnsubscribeUrl } from './unsubscribeToken.ts';
import { selectGitaVerseForOrdinal } from './campaigns/gitaVerses.ts';
import * as dataAccess from './dataAccess.ts';

export interface CampaignRunOptions {
  dryRun: boolean;
  /** Injectable clock for deterministic local tests; production uses now. */
  now?: Date;
}

/**
 * Generic engine that runs any CampaignDefinition against campaign candidates:
 * it makes deterministic safety decisions, requires genuine activity in the
 * campaign's rolling period, skips anyone already sent to this milestone,
 * computes stats + lifetime totals, renders, sends, and records the outcome
 * in `user_email_summaries` (keyed by the campaign's own `id` as `email_type`,
 * so no per-campaign DB migration is ever needed).
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
    const { cycleStart, cycleEnd } = getCampaignCycleDates(this.campaign.periodDays, now);

    console.log(
      `[Campaign:${this.campaign.id}] activity=${periodStart}→${periodEnd} cycle=${cycleStart}→${cycleEnd} dryRun=${dryRun}`,
    );

    const users = await this.getActiveUsers(periodStart, periodEnd);
    console.log(`[Campaign:${this.campaign.id}] ${users.length} campaign candidate(s)`);

    const results: SummaryRunResult[] = [];
    for (const user of users) {
      const result = await this.processUser(user, periodStart, periodEnd, cycleStart, cycleEnd, dryRun, now);
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

  protected async getCampaignSendOrdinal(
    userId: string,
    cycleStart: string,
    cycleEnd: string,
  ): Promise<number> {
    return dataAccess.getCampaignSendOrdinal(this.supabase, userId, this.campaign.id, cycleStart, cycleEnd);
  }

  /** Read-only advisory check; claimSummary remains the race-safe authority. */
  protected async isDuplicate(
    userId: string,
    cycleStart: string,
    cycleEnd: string,
    now: Date,
  ): Promise<boolean> {
    return dataAccess.isCampaignCycleDuplicate(
      this.supabase,
      userId,
      this.campaign.id,
      cycleStart,
      cycleEnd,
      this.campaign.periodDays,
      now,
    );
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
    activityPeriodStart: string,
    activityPeriodEnd: string,
    cycleStart: string,
    cycleEnd: string,
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

      if (await this.isDuplicate(user.id, cycleStart, cycleEnd, now)) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_duplicate',
          reason: 'already claimed or sent for this period',
        };
      }

      const rows = await this.getHistoryForUser(user.id, activityPeriodStart, activityPeriodEnd);
      const stats = calculateSummaryStats(
        user.id,
        user.email,
        rows,
        activityPeriodStart,
        activityPeriodEnd,
      );

      if (!stats) {
        return {
          userId: user.id,
          email: user.email,
          status: 'skipped_no_activity',
          reason: 'no japam activity in period',
        };
      }

      const { lifetimeTotalMalas, lifetimeTotalCount } = await this.getLifetimeStats(user.id);
      const sendOrdinal = await this.getCampaignSendOrdinal(user.id, cycleStart, cycleEnd);

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
        const gitaVerse = selectGitaVerseForOrdinal(user.id, sendOrdinal);
        const ctx = { stats, lifetimeTotalMalas, lifetimeTotalCount, gitaVerse, config: campaignConfig };
        const html = this.campaign.buildHtml(ctx);
        const text = this.campaign.buildText(ctx);
        const subject = this.campaign.getSubject?.(ctx) ?? this.campaign.subject;

        console.log(`[Campaign:${emailType}] DRY RUN would send to:`, user.email);
        console.log(`[Campaign:${emailType}] subject:`, subject);
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
      const gitaVerse = selectGitaVerseForOrdinal(user.id, sendOrdinal);
      const ctx = { stats, lifetimeTotalMalas, lifetimeTotalCount, gitaVerse, config: campaignConfig };

      const pendingRecord: Omit<EmailSummaryRecord, 'id' | 'created_at'> = {
        user_id: user.id,
        email_type: emailType,
        period_start: cycleStart,
        period_end: cycleEnd,
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
      const subject = this.campaign.getSubject?.(ctx) ?? this.campaign.subject;

      const { messageId } = await this.emailProvider.sendEmail({
        to: user.email,
        from: this.config.fromAddress,
        subject,
        html,
        text,
        idempotencyKey: `${emailType}/${user.id}/${cycleStart}`,
      });
      providerAccepted = true;

      await this.recordSummary({
        user_id: user.id,
        email_type: emailType,
        period_start: cycleStart,
        period_end: cycleEnd,
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
          period_start: cycleStart,
          period_end: cycleEnd,
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

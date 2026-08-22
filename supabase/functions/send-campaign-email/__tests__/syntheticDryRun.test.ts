import { handleCampaignRequest } from '../handler';
import { isOperatorAuthorization } from '../../_shared/email/operatorAuth';
import { CampaignEmailService } from '../../_shared/email/campaignService';
import { fifteenDayInspirationCampaign } from '../../_shared/email/campaigns/fifteenDayInspiration';
import { loadEmailConfig } from '../../_shared/email/config';
import { getPeriodDates } from '../../_shared/email/calculator';
import { verifyUnsubscribeToken } from '../../_shared/email/unsubscribeToken';
import type { CampaignContext, CampaignDefinition } from '../../_shared/email/campaigns/types';
import type { AuthUser, EmailSummaryRecord, JapamHistoryRow } from '../../_shared/email/types';

const NOW = new Date('2026-08-22T12:00:00.000Z');

class SyntheticService extends CampaignEmailService {
  public providerCalls = 0;
  public remoteWrites = 0;

  constructor(campaign: CampaignDefinition, config: CampaignContext['config']) {
    super(campaign, {} as never, null, config);
  }

  override async run(options: { dryRun: boolean }) {
    return super.run({ ...options, now: NOW });
  }

  protected override async getActiveUsers(): Promise<AuthUser[]> {
    return [{
      id: 'fixture-user',
      email: 'fixture@example.com',
      displayName: 'Synthetic User',
      createdAt: '2020-01-01T00:00:00.000Z',
    }];
  }

  protected override async getHistoryForUser(): Promise<JapamHistoryRow[]> {
    const { periodStart } = getPeriodDates(15, NOW);
    return [{
      user_id: 'fixture-user',
      user_name: 'Synthetic User',
      malas: 2,
      count: 216,
      created_at: `${periodStart}T12:00:00.000Z`,
      completion_id: 'fixture-completion',
    }];
  }

  protected override async isDuplicate(): Promise<boolean> {
    return false;
  }

  protected override async getLifetimeStats(): Promise<{ lifetimeTotalMalas: number; firstActivityAt: string }> {
    return { lifetimeTotalMalas: 12, firstActivityAt: '2026-07-01T12:00:00.000Z' };
  }

  protected override async recordSummary(
    _record: Omit<EmailSummaryRecord, 'id' | 'created_at'>,
  ): Promise<void> {
    this.remoteWrites += 1;
  }
}

describe('synthetic send-campaign-email dry-run', () => {
  it('renders one eligible fixture with zero provider calls and zero writes', async () => {
    let capturedContext: CampaignContext | null = null;
    const campaign: CampaignDefinition = {
      ...fifteenDayInspirationCampaign,
      buildHtml: context => {
        capturedContext = context;
        return fifteenDayInspirationCampaign.buildHtml(context);
      },
      buildText: context => fifteenDayInspirationCampaign.buildText(context),
    };
    const originalEnv = { ...process.env };
    process.env.EMAIL_UNSUBSCRIBE_URL = 'https://fixture.test/unsubscribe';
    process.env.EMAIL_UNSUBSCRIBE_SECRET = 'fixture-secret';
    process.env.EMAIL_FROM_ADDRESS = 'Japam App <fixture@example.com>';

    try {
      const config = loadEmailConfig();
      const service = new SyntheticService(campaign, config);
      const env: Record<string, string> = {
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
        EMAIL_CONTROLLED_RECIPIENT: 'mantrajapamapp@gmail.com',
        EMAIL_ALLOWLIST: 'mantrajapamapp@gmail.com',
      };
      let providerCalls = 0;
      const response = await handleCampaignRequest(
        new Request('https://fixture.test/send-campaign-email', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${Buffer.from('header').toString('base64')}.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`,
          },
          body: JSON.stringify({ campaign_id: '15day_inspiration', dry_run: true }),
        }),
        {
          getEnv: name => env[name] ?? process.env[name],
          isOperatorAuthorization,
          getCampaign: () => campaign,
          validateProductionEnv: () => [],
          assertCampaignUnsubscribeReady: () => undefined,
          loadEmailConfig: () => config,
          createSupabaseClient: () => ({}),
          createEmailProvider: () => {
            providerCalls += 1;
            return {};
          },
          createCampaignService: () => service,
        },
      );
      const body = (await response.json()) as { campaign_id: string; eligible_count: number; provider_calls: number; campaign_history_writes: number };

      expect(response.status).toBe(200);
      expect(body.campaign_id).toBe('15day_inspiration');
      expect(body.eligible_count).toBe(1);
      expect(body.provider_calls).toBe(0);
      expect(body.campaign_history_writes).toBe(0);
      expect(providerCalls).toBe(0);
      expect(service.remoteWrites).toBe(0);
      expect(capturedContext).not.toBeNull();

      const context = capturedContext!;
      const unsubscribeUrl = new URL(context.config.unsubscribeUrl);
      expect(await verifyUnsubscribeToken(
        unsubscribeUrl.searchParams.get('token')!,
        'fixture-secret',
        NOW.getTime(),
      )).toBe('fixture-user');
      expect(context.stats.totalSessions).toBe(1);
      expect(context.stats.totalMalas).toBe(2);
      expect(context.lifetimeTotalMalas).toBe(12);

      if (process.env.SHOW_EMAIL_DRY_RUN === 'true') {
        console.log(JSON.stringify({
          campaign: body.campaign_id,
          eligible_count: body.eligible_count,
          skipped_counts: {},
          subject: campaign.subject,
          period_stats: {
            sessions: context.stats.totalSessions,
            malas: context.stats.totalMalas,
          },
          lifetime_malas: context.lifetimeTotalMalas,
          unsubscribe_verified: true,
          provider_calls: body.provider_calls,
          remote_writes: body.campaign_history_writes,
        }));
      }
    } finally {
      process.env = originalEnv;
    }
  });
});

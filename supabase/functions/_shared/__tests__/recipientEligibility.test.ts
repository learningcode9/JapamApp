import { CampaignEmailService } from '../email/campaignService';
import { loadEmailConfig } from '../email/config';
import { fifteenDayInspirationCampaign } from '../email/campaigns/fifteenDayInspiration';
import type { EmailProvider } from '../email/emailProvider';
import type { AuthUser, EmailSummaryRecord, JapamHistoryRow } from '../email/types';
import type { CampaignDefinition } from '../email/campaigns/types';
import { verifyUnsubscribeToken } from '../email/unsubscribeToken';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function historyRow(userId: string, malas: number, count: number): JapamHistoryRow {
  return {
    user_id: userId,
    user_name: userId,
    malas,
    count,
    created_at: '2026-08-20T08:00:00.000Z',
    completion_id: `${userId}-completion`,
  };
}

class EligibilityService extends CampaignEmailService {
  public recordedSummaries: Omit<EmailSummaryRecord, 'id' | 'created_at'>[] = [];

  constructor(
    private readonly fakeUsers: AuthUser[],
    private readonly fakeHistory: Record<string, JapamHistoryRow[]>,
    private readonly duplicateIds: Set<string> = new Set(),
    provider: EmailProvider | null = null,
    campaign: CampaignDefinition = fifteenDayInspirationCampaign,
  ) {
    super(
      campaign,
      {} as never,
      provider,
      {
        ...loadEmailConfig(),
        unsubscribeUrl: 'https://example.test/unsubscribe',
        unsubscribeSecret: 'recipient-eligibility-test-secret',
      },
    );
  }

  override async run(options: { dryRun: boolean; now?: Date }) {
    return super.run({ now: NOW, ...options });
  }

  protected override async getActiveUsers(): Promise<AuthUser[]> {
    return this.fakeUsers;
  }

  protected override async getHistoryForUser(
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<JapamHistoryRow[]> {
    const start = Date.parse(`${periodStart}T00:00:00.000Z`);
    const end = Date.parse(`${periodEnd}T23:59:59.999Z`);
    return (this.fakeHistory[userId] ?? []).filter(row => {
      const createdAt = Date.parse(row.created_at);
      return createdAt >= start && createdAt <= end;
    });
  }

  protected override async getLifetimeStats(userId: string) {
    return {
      lifetimeTotalMalas: (this.fakeHistory[userId] ?? []).reduce(
        (total, row) => total + row.malas,
        0,
      ),
      firstActivityAt: this.fakeHistory[userId]?.[0]?.created_at ?? null,
    };
  }

  protected override async isDuplicate(userId: string): Promise<boolean> {
    return this.duplicateIds.has(userId);
  }

  protected override async claimSummary(): Promise<boolean> {
    return true;
  }

  protected override async recordSummary(
    record: Omit<EmailSummaryRecord, 'id' | 'created_at'>,
  ): Promise<void> {
    this.recordedSummaries.push(record);
  }
}

describe('15-day rolling activity eligibility', () => {
  it('allows an old account with one recent Mala', async () => {
    const service = new EligibilityService(
      [{ id: 'old-mala', email: 'old-mala@example.test', createdAt: '2020-01-01T00:00:00.000Z' }],
      { 'old-mala': [historyRow('old-mala', 1, 108)] },
      new Set(),
      null,
    );

    expect((await service.run({ dryRun: true }))[0].status).toBe('dry_run');
  });

  it('allows an old account with recent positive count-only activity', async () => {
    const service = new EligibilityService(
      [{ id: 'old-count', email: 'old-count@example.test', createdAt: '2020-01-01T00:00:00.000Z' }],
      { 'old-count': [historyRow('old-count', 0, 50)] },
      new Set(),
      null,
    );

    expect((await service.run({ dryRun: true }))[0].status).toBe('dry_run');
  });

  it('allows a new account with recent activity', async () => {
    const service = new EligibilityService(
      [{ id: 'new', email: 'new@example.test', createdAt: '2026-08-21T12:00:00.000Z' }],
      { new: [historyRow('new', 1, 108)] },
      new Set(),
      null,
    );

    expect((await service.run({ dryRun: true }))[0].status).toBe('dry_run');
  });

  it('skips activity that is only outside the rolling 15-day window', async () => {
    const service = new EligibilityService(
      [{ id: 'stale', email: 'stale@example.test', createdAt: '2020-01-01T00:00:00.000Z' }],
      { stale: [{ ...historyRow('stale', 1, 108), created_at: '2026-08-06T08:00:00.000Z' }] },
      new Set(),
      null,
    );

    const result = await service.run({ dryRun: true });
    expect(result[0]).toMatchObject({
      status: 'skipped_no_activity',
      reason: 'no japam activity in period',
    });
  });
});

describe('15-day recipient safety decisions', () => {
  it('allows Mala and count-only activity but skips all unsafe synthetic recipients', async () => {
    const users: AuthUser[] = [
      { id: 'new10', email: 'new10@example.test', createdAt: '2026-08-12T12:00:00.000Z' },
      { id: 'mala15', email: 'mala15@example.test', createdAt: '2026-08-07T12:00:00.000Z' },
      { id: 'count15', email: 'count15@example.test', createdAt: '2026-08-07T12:00:00.000Z' },
      { id: 'zero15', email: 'zero15@example.test', createdAt: '2026-08-07T12:00:00.000Z' },
      { id: 'old20', email: 'old20@example.test', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'unsubscribed', email: 'unsubscribed@example.test', createdAt: '2026-08-07T12:00:00.000Z', isUnsubscribed: true },
      { id: 'alreadySent', email: 'already-sent@example.test', createdAt: '2026-08-07T12:00:00.000Z' },
      { id: 'excluded', email: 'Reviewer@Example.test', createdAt: '2026-08-07T12:00:00.000Z', isExcluded: true },
      { id: 'invalid', email: 'not-an-email', createdAt: '2026-08-07T12:00:00.000Z' },
    ];
    const provider: EmailProvider = { sendEmail: jest.fn() };
    const service = new EligibilityService(
      users,
      {
        mala15: [historyRow('mala15', 1, 108)],
        count15: [historyRow('count15', 0, 50)],
        old20: [historyRow('old20', 1, 108)],
        alreadySent: [historyRow('alreadySent', 1, 108)],
        excluded: [historyRow('excluded', 1, 108)],
      },
      new Set(['alreadySent']),
      provider,
    );

    const results = await service.run({ dryRun: true });
    const byId = new Map(results.map(result => [result.userId, result]));

    expect(byId.get('mala15')?.status).toBe('dry_run');
    expect(byId.get('count15')?.status).toBe('dry_run');
    expect(byId.get('new10')?.status).toBe('skipped_no_activity');
    expect(byId.get('old20')?.status).toBe('dry_run');
    expect(byId.get('zero15')).toMatchObject({
      status: 'skipped_no_activity',
      reason: 'no japam activity in period',
    });
    expect(byId.get('unsubscribed')?.status).toBe('skipped_unsubscribed');
    expect(byId.get('alreadySent')?.status).toBe('skipped_duplicate');
    expect(byId.get('excluded')?.status).toBe('skipped_excluded');
    expect(byId.get('invalid')?.status).toBe('skipped_invalid_email');
    expect(provider.sendEmail).not.toHaveBeenCalled();
    expect(service.recordedSummaries).toHaveLength(0);
  });

  it('keeps activity and rendered stats isolated per user', async () => {
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockResolvedValue({ messageId: 'dry-run-not-used' }),
    };
    const service = new EligibilityService(
      [
        { id: 'u1', email: 'u1@example.test', createdAt: '2026-08-07T12:00:00.000Z' },
        { id: 'u2', email: 'u2@example.test', createdAt: '2026-08-07T12:00:00.000Z' },
      ],
      {
        u1: [historyRow('u1', 2, 216)],
        u2: [historyRow('u2', 7, 756)],
      },
      new Set(),
      provider,
    );

    const results = await service.run({ dryRun: true });
    expect(results.filter(result => result.status === 'dry_run')).toHaveLength(2);
  });

  it('verifies the per-user signed unsubscribe URL generated during dry-run rendering', async () => {
    let renderedUrl = '';
    const campaign: CampaignDefinition = {
      ...fifteenDayInspirationCampaign,
      buildHtml: context => {
        renderedUrl = context.config.unsubscribeUrl;
        return '<html />';
      },
      buildText: context => context.config.unsubscribeUrl,
    };
    const service = new EligibilityService(
      [{ id: 'u1', email: 'u1@example.test', createdAt: '2026-08-07T12:00:00.000Z' }],
      { u1: [historyRow('u1', 1, 108)] },
      new Set(),
      null,
      campaign,
    );

    const results = await service.run({ dryRun: true });
    const token = new URL(renderedUrl).searchParams.get('token');

    expect(results[0].status).toBe('dry_run');
    expect(token).toBeTruthy();
    expect(await verifyUnsubscribeToken(token!, 'recipient-eligibility-test-secret')).toBe('u1');
  });
});

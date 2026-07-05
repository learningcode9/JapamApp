import { CampaignEmailService } from '../email/campaignService';
import type { EmailProvider } from '../email/emailProvider';
import type { JapamHistoryRow, AuthUser, EmailSummaryRecord } from '../email/types';
import type { CampaignDefinition, CampaignContext } from '../email/campaigns/types';
import { loadEmailConfig } from '../email/config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<JapamHistoryRow> = {}): JapamHistoryRow {
  return {
    user_id: 'u1',
    user_name: 'Test User',
    malas: 2,
    count: 216,
    created_at: '2026-06-20T08:00:00.000Z',
    completion_id: 'c1',
    ...overrides,
  };
}

const USER: AuthUser = { id: 'u1', email: 'user@example.com', displayName: 'Test User' };

const FAKE_CAMPAIGN: CampaignDefinition = {
  id: 'test_campaign',
  periodDays: 15,
  subject: 'Test Subject',
  buildHtml: (ctx: CampaignContext) => `<html>${ctx.stats.userName}:${ctx.lifetimeTotalMalas}</html>`,
  buildText: (ctx: CampaignContext) => `${ctx.stats.userName}:${ctx.lifetimeTotalMalas}`,
};

/**
 * Subclass that replaces all Supabase data-access methods with injectable
 * fakes — same pattern as SummaryEmailService's TestService.
 */
class TestService extends CampaignEmailService {
  public recordedSummaries: Array<Omit<EmailSummaryRecord, 'id' | 'created_at'>> = [];

  constructor(
    public fakeUsers: AuthUser[] = [USER],
    public fakeHistory: JapamHistoryRow[] = [makeRow()],
    public fakeDuplicate = false,
    public fakeLifetimeTotal = 42,
    emailProvider: EmailProvider | null = null,
    campaign: CampaignDefinition = FAKE_CAMPAIGN,
  ) {
    super(campaign, {} as never, emailProvider, loadEmailConfig());
  }

  protected override async getActiveUsers(): Promise<AuthUser[]> {
    return this.fakeUsers;
  }

  protected override async getHistoryForUser(): Promise<JapamHistoryRow[]> {
    return this.fakeHistory;
  }

  protected override async getLifetimeTotalMalas(): Promise<number> {
    return this.fakeLifetimeTotal;
  }

  protected override async isDuplicate(): Promise<boolean> {
    return this.fakeDuplicate;
  }

  protected override async recordSummary(
    record: Omit<EmailSummaryRecord, 'id' | 'created_at'>,
  ): Promise<void> {
    this.recordedSummaries.push(record);
  }
}

// ─── Dry-run ──────────────────────────────────────────────────────────────────

describe('CampaignEmailService dry-run mode', () => {
  it('does not call emailProvider.sendEmail', async () => {
    const provider: EmailProvider = { sendEmail: jest.fn() };
    const service = new TestService([USER], [makeRow()], false, 42, provider);

    await service.run({ dryRun: true });

    expect(provider.sendEmail).not.toHaveBeenCalled();
  });

  it('records a dry_run row using the campaign id as email_type', async () => {
    const service = new TestService([USER], [makeRow()], false, 42, null);
    await service.run({ dryRun: true });

    const record = service.recordedSummaries.find(r => r.status === 'dry_run');
    expect(record?.email_type).toBe('test_campaign');
    expect(record?.user_id).toBe('u1');
  });
});

// ─── No activity ──────────────────────────────────────────────────────────────

describe('CampaignEmailService no activity', () => {
  it('skips a user with no history rows', async () => {
    const service = new TestService([USER], [], false, 42, null);
    const results = await service.run({ dryRun: true });

    expect(results[0].status).toBe('skipped_no_activity');
  });
});

// ─── Duplicate prevention ─────────────────────────────────────────────────────

describe('CampaignEmailService duplicate prevention', () => {
  it('skips when a record already exists, scoped per campaign id', async () => {
    const provider: EmailProvider = { sendEmail: jest.fn() };
    const service = new TestService([USER], [makeRow()], true, 42, provider);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('skipped_duplicate');
    expect(provider.sendEmail).not.toHaveBeenCalled();
  });

  it('forceResend bypasses duplicate check', async () => {
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-1' }),
    };
    const service = new TestService([USER], [makeRow()], true, 42, provider);

    const results = await service.run({ dryRun: false, forceResend: true });

    expect(results[0].status).toBe('sent');
  });
});

// ─── Real sending ─────────────────────────────────────────────────────────────

describe('CampaignEmailService real sending', () => {
  it('passes lifetimeTotalMalas + stats into the campaign builders', async () => {
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-abc' }),
    };
    const service = new TestService([USER], [makeRow({ user_name: 'Devotee' })], false, 999, provider);

    await service.run({ dryRun: false });

    expect(provider.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('999'),
        text: expect.stringContaining('999'),
        subject: 'Test Subject',
      }),
    );
  });

  it('records failed status when provider throws, and continues to next user', async () => {
    const USER2: AuthUser = { id: 'u2', email: 'user2@example.com' };
    let callCount = 0;
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('first fails'));
        return Promise.resolve({ messageId: 'msg-2' });
      }),
    };

    class MultiUserService extends TestService {
      protected override async getActiveUsers(): Promise<AuthUser[]> {
        return [USER, USER2];
      }
    }

    const service = new MultiUserService([USER, USER2], [makeRow()], false, 42, provider);
    const results = await service.run({ dryRun: false });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('sent');
  });
});

describe('CampaignEmailService provider null guard', () => {
  it('records failed status when dryRun=false but no provider', async () => {
    const service = new TestService([USER], [makeRow()], false, 42, null);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('emailProvider is null');
  });
});

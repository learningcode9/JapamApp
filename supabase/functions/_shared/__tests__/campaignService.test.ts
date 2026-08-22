import { CampaignEmailService } from '../email/campaignService';
import { EmailProviderError } from '../email/emailProvider';
import type { EmailProvider } from '../email/emailProvider';
import type { JapamHistoryRow, AuthUser, EmailSummaryRecord } from '../email/types';
import type { CampaignDefinition, CampaignContext } from '../email/campaigns/types';
import { loadEmailConfig } from '../email/config';
import { verifyUnsubscribeToken } from '../email/unsubscribeToken';

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

const NOW = new Date('2026-08-22T12:00:00.000Z');
const EXACTLY_15_DAYS_OLD = '2026-08-07T12:00:00.000Z';
const TOO_EARLY = '2026-08-08T12:00:00.000Z';
const USER: AuthUser = {
  id: 'u1',
  email: 'user@example.com',
  displayName: 'Test User',
  createdAt: '2020-01-01T00:00:00.000Z',
};

const FAKE_CAMPAIGN: CampaignDefinition = {
  id: 'test_campaign',
  periodDays: 15,
  subject: 'Test Subject',
  buildHtml: (ctx: CampaignContext) => `<html>${ctx.stats.userName}:${ctx.lifetimeTotalMalas}</html>`,
  buildText: (ctx: CampaignContext) => `${ctx.stats.userName}:${ctx.lifetimeTotalMalas}`,
};

// Far enough in the past that every existing test (none of which are about
// the "too new" eligibility gate) is unaffected by its introduction.
const LONG_ESTABLISHED_USER_ISO = '2020-01-01T00:00:00.000Z';

const withUnsubscribeEnv = async (run: () => Promise<void>) => {
  const originalUrl = process.env.EMAIL_UNSUBSCRIBE_URL;
  const originalSecret = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  process.env.EMAIL_UNSUBSCRIBE_URL = 'http://127.0.0.1:54321/functions/v1/unsubscribe-email';
  process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';

  try {
    await run();
  } finally {
    if (originalUrl === undefined) delete process.env.EMAIL_UNSUBSCRIBE_URL;
    else process.env.EMAIL_UNSUBSCRIBE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = originalSecret;
  }
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
  public fakeClaimResults: boolean[] = [],
  ) {
    super(campaign, {} as never, emailProvider, loadEmailConfig());
  }

  protected override async getActiveUsers(): Promise<AuthUser[]> {
    return this.fakeUsers;
  }

  protected override async getHistoryForUser(
    _userId: string,
    _periodStart: string,
    _periodEnd: string,
  ): Promise<JapamHistoryRow[]> {
    return this.fakeHistory;
  }

  protected override async getLifetimeStats(): Promise<{ lifetimeTotalMalas: number; firstActivityAt: string | null }> {
    return { lifetimeTotalMalas: this.fakeLifetimeTotal, firstActivityAt: LONG_ESTABLISHED_USER_ISO };
  }

  protected override async isDuplicate(): Promise<boolean> {
    return this.fakeDuplicate;
  }

  protected override async claimSummary(): Promise<boolean> {
    if (this.fakeClaimResults.length > 0) return this.fakeClaimResults.shift()!;
    return !this.fakeDuplicate;
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

  it('does not write campaign history during a dry-run', async () => {
    const service = new TestService([USER], [makeRow()], false, 42, null);
    await service.run({ dryRun: true });

    expect(service.recordedSummaries).toHaveLength(0);
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

// ─── New-user eligibility ───────────────────────────────────────────────────

describe('CampaignEmailService new-user eligibility', () => {
  it('allows a user whose auth account is exactly 15 days old', async () => {
    const user = { ...USER, createdAt: EXACTLY_15_DAYS_OLD };
    const service = new TestService([user], [makeRow()], false, 42, null);
    const results = await service.run({ dryRun: true, now: NOW });

    expect(results[0].status).toBe('dry_run');
  });

  it('skips an auth account that is too early for the campaign', async () => {
    const user = { ...USER, createdAt: TOO_EARLY };
    const service = new TestService([user], [makeRow()], false, 42, null);
    const results = await service.run({ dryRun: true, now: NOW });

    expect(results[0].status).toBe('skipped_too_new');
  });

  it('does not skip a long-established user', async () => {
    const service = new TestService([USER], [makeRow()], false, 42, null, FAKE_CAMPAIGN);
    const results = await service.run({ dryRun: true });

    expect(results[0].status).toBe('dry_run');
  });

  it('fails closed when the auth account creation timestamp is missing', async () => {
    const service = new TestService([{ ...USER, createdAt: undefined }], [makeRow()], false, 42, null);
    const results = await service.run({ dryRun: true });

    expect(results[0].status).toBe('skipped_missing_account_age');
  });
});

// ─── Duplicate prevention ─────────────────────────────────────────────────────

describe('CampaignEmailService duplicate prevention', () => {
  it('skips when a record already exists, scoped per campaign id', async () => {
    await withUnsubscribeEnv(async () => {
      const provider: EmailProvider = { sendEmail: jest.fn() };
      const service = new TestService([USER], [makeRow()], true, 42, provider);

      const results = await service.run({ dryRun: false });

      expect(results[0].status).toBe('skipped_duplicate');
      expect(provider.sendEmail).not.toHaveBeenCalled();
    });
  });

  it('does not duplicate a send when the scheduler runs again', async () => {
    await withUnsubscribeEnv(async () => {
      const provider: EmailProvider = {
        sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };
      const service = new TestService([USER], [makeRow()], false, 42, provider, FAKE_CAMPAIGN, [true, false]);

      const first = await service.run({ dryRun: false, now: NOW });
      const second = await service.run({ dryRun: false, now: NOW });

      expect(first[0].status).toBe('sent');
      expect(second[0].status).toBe('skipped_duplicate');
      expect(provider.sendEmail).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Real sending ─────────────────────────────────────────────────────────────

describe('CampaignEmailService real sending', () => {
  it('passes a signed per-user unsubscribe URL to campaign builders', async () => {
    await withUnsubscribeEnv(async () => {
      const provider: EmailProvider = {
        sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-unsubscribe' }),
      };
      const campaign: CampaignDefinition = {
        ...FAKE_CAMPAIGN,
        buildHtml: (ctx: CampaignContext) => ctx.config.unsubscribeUrl,
        buildText: (ctx: CampaignContext) => ctx.config.unsubscribeUrl,
      };
      const service = new TestService([USER], [makeRow()], false, 42, provider, campaign);

      await service.run({ dryRun: false });

      const sent = (provider.sendEmail as jest.Mock).mock.calls[0][0] as { html: string };
      const url = new URL(sent.html);
      expect(await verifyUnsubscribeToken(url.searchParams.get('token')!, 'test-unsubscribe-secret')).toBe('u1');
    });
  });

  it('passes lifetimeTotalMalas + stats into the campaign builders', async () => {
    await withUnsubscribeEnv(async () => {
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
  });

  it('fails closed instead of sending without a signed unsubscribe link', async () => {
    const originalUrl = process.env.EMAIL_UNSUBSCRIBE_URL;
    const originalSecret = process.env.EMAIL_UNSUBSCRIBE_SECRET;
    delete process.env.EMAIL_UNSUBSCRIBE_URL;
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;

    try {
      const provider: EmailProvider = { sendEmail: jest.fn() };
      const service = new TestService([USER], [makeRow()], false, 42, provider);

      const results = await service.run({ dryRun: false });

      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('signed unsubscribe link');
      expect(provider.sendEmail).not.toHaveBeenCalled();
    } finally {
      if (originalUrl === undefined) delete process.env.EMAIL_UNSUBSCRIBE_URL;
      else process.env.EMAIL_UNSUBSCRIBE_URL = originalUrl;
      if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
      else process.env.EMAIL_UNSUBSCRIBE_SECRET = originalSecret;
    }
  });

  it('records failed status when provider throws, and continues to next user', async () => {
    await withUnsubscribeEnv(async () => {
      const USER2: AuthUser = {
        id: 'u2',
        email: 'user2@example.com',
        createdAt: '2020-01-01T00:00:00.000Z',
      };
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
});

describe('CampaignEmailService provider null guard', () => {
  it('records failed status when dryRun=false but no provider', async () => {
    const service = new TestService([USER], [makeRow()], false, 42, null);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('emailProvider is null');
  });
});

describe('CampaignEmailService input safety', () => {
  it('skips a missing or invalid email without calling the provider', async () => {
    const provider: EmailProvider = { sendEmail: jest.fn() };
    const service = new TestService(
      [{ ...USER, email: 'not-an-email' }],
      [makeRow()],
      false,
      42,
      provider,
    );

    const results = await service.run({ dryRun: false, now: NOW });

    expect(results[0].status).toBe('skipped_invalid_email');
    expect(provider.sendEmail).not.toHaveBeenCalled();
  });

  it('retries a provider failure with the same idempotency key', async () => {
    await withUnsubscribeEnv(async () => {
      const provider: EmailProvider = {
        sendEmail: jest
          .fn()
          .mockRejectedValueOnce(new Error('temporary provider failure'))
          .mockResolvedValueOnce({ messageId: 'msg-retry' }),
      };
      const service = new TestService(
        [USER],
        [makeRow()],
        false,
        42,
        provider,
        FAKE_CAMPAIGN,
        [true, true],
      );

      const first = await service.run({ dryRun: false, now: NOW });
      const second = await service.run({ dryRun: false, now: NOW });
      const firstKey = (provider.sendEmail as jest.Mock).mock.calls[0][0].idempotencyKey;
      const secondKey = (provider.sendEmail as jest.Mock).mock.calls[1][0].idempotencyKey;

      expect(first[0].status).toBe('failed');
      expect(second[0].status).toBe('sent');
      expect(firstKey).toBe(secondKey);
    });
  });

  it('leaves an uncertain provider failure pending and blocks automatic retry', async () => {
    await withUnsubscribeEnv(async () => {
      const provider: EmailProvider = {
        sendEmail: jest.fn().mockRejectedValue(new EmailProviderError('network timeout', false)),
      };
      const service = new TestService(
        [USER],
        [makeRow()],
        false,
        42,
        provider,
        FAKE_CAMPAIGN,
        [true, false],
      );

      const first = await service.run({ dryRun: false, now: NOW });
      const second = await service.run({ dryRun: false, now: NOW });

      expect(first[0].status).toBe('failed');
      expect(service.recordedSummaries.find(record => record.status === 'pending')).toBeDefined();
      expect(second[0].status).toBe('skipped_duplicate');
      expect(provider.sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps period stats scoped to each user', async () => {
    await withUnsubscribeEnv(async () => {
      const user2: AuthUser = {
        id: 'u2',
        email: 'second@example.com',
        createdAt: '2020-01-01T00:00:00.000Z',
      };
      const provider: EmailProvider = {
        sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-isolated' }),
      };
      class IsolatedService extends TestService {
        protected override async getHistoryForUser(userId: string): Promise<JapamHistoryRow[]> {
          return [
            makeRow({
              user_id: userId,
              user_name: userId === 'u1' ? 'First' : 'Second',
              malas: userId === 'u1' ? 3 : 9,
            }),
          ];
        }
      }

      const isolatedCampaign: CampaignDefinition = {
        ...FAKE_CAMPAIGN,
        buildHtml: (ctx: CampaignContext) => `${ctx.stats.userName}:${ctx.stats.totalMalas}`,
        buildText: (ctx: CampaignContext) => `${ctx.stats.userName}:${ctx.stats.totalMalas}`,
      };
      const service = new IsolatedService(
        [USER, user2],
        [makeRow()],
        false,
        42,
        provider,
        isolatedCampaign,
      );
      await service.run({ dryRun: false, now: NOW });

      const messages = (provider.sendEmail as jest.Mock).mock.calls.map(call => call[0]);
      expect(messages[0].html).toContain('First');
      expect(messages[0].html).toContain('3');
      expect(messages[0].html).not.toContain('Second');
      expect(messages[1].html).toContain('Second');
      expect(messages[1].html).toContain('9');
      expect(messages[1].html).not.toContain('First');
    });
  });
});

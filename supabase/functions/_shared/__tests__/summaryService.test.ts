import { SummaryEmailService } from '../email/summaryService';
import type { EmailProvider } from '../email/emailProvider';
import type { JapamHistoryRow, AuthUser } from '../email/types';

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

/**
 * Subclass that replaces all Supabase data-access methods with injectable fakes,
 * so tests stay pure without needing to mock the Supabase query builder chain.
 */
class TestService extends SummaryEmailService {
  public recordedSummaries: Array<Parameters<SummaryEmailService['recordSummary']>[0]> = [];

  constructor(
    public fakeUsers: AuthUser[] = [USER],
    public fakeHistory: JapamHistoryRow[] = [makeRow()],
    public fakeDuplicate = false,
    emailProvider: EmailProvider | null = null,
  ) {
    // Supabase client is unused — all data comes from the fakes above
    super({} as never, emailProvider, 'from@test.com');
  }

  protected override async getActiveUsers(): Promise<AuthUser[]> {
    return this.fakeUsers;
  }

  protected override async getHistoryForUser(): Promise<JapamHistoryRow[]> {
    return this.fakeHistory;
  }

  protected override async isDuplicate(): Promise<boolean> {
    return this.fakeDuplicate;
  }

  protected override async recordSummary(
    record: Parameters<SummaryEmailService['recordSummary']>[0],
  ): Promise<void> {
    this.recordedSummaries.push(record);
  }
}

// ─── Dry-run ──────────────────────────────────────────────────────────────────

describe('dry-run mode', () => {
  it('does not call emailProvider.sendEmail', async () => {
    const provider: EmailProvider = { sendEmail: jest.fn() };
    const service = new TestService([USER], [makeRow()], false, provider);

    await service.run({ dryRun: true });

    expect(provider.sendEmail).not.toHaveBeenCalled();
  });

  it('returns dry_run status for each active user', async () => {
    const service = new TestService([USER], [makeRow()], false, null);
    const results = await service.run({ dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('dry_run');
    expect(results[0].userId).toBe('u1');
  });

  it('records a dry_run row in user_email_summaries', async () => {
    const service = new TestService([USER], [makeRow()], false, null);
    await service.run({ dryRun: true });

    const record = service.recordedSummaries.find(r => r.status === 'dry_run');
    expect(record).toBeDefined();
    expect(record?.user_id).toBe('u1');
    expect(record?.email_type).toBe('15day_summary');
  });
});

// ─── No activity ──────────────────────────────────────────────────────────────

describe('no activity', () => {
  it('skips a user with no history rows', async () => {
    const service = new TestService([USER], [] /* empty history */, false, null);
    const results = await service.run({ dryRun: true });

    expect(results[0].status).toBe('skipped_no_activity');
  });

  it('does not record a summary row when activity is absent', async () => {
    const service = new TestService([USER], [], false, null);
    await service.run({ dryRun: true });

    expect(service.recordedSummaries).toHaveLength(0);
  });

  it('skips when getActiveUsers returns an empty list', async () => {
    const service = new TestService([] /* no users */, [], false, null);
    const results = await service.run({ dryRun: true });

    expect(results).toHaveLength(0);
  });
});

// ─── Duplicate prevention ─────────────────────────────────────────────────────

describe('duplicate prevention', () => {
  it('skips user when a previous record already exists for the period', async () => {
    const provider: EmailProvider = { sendEmail: jest.fn() };
    const service = new TestService([USER], [makeRow()], true /* duplicate */, provider);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('skipped_duplicate');
    expect(provider.sendEmail).not.toHaveBeenCalled();
  });

  it('sends when forceResend bypasses the duplicate check', async () => {
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-1' }),
    };
    const service = new TestService([USER], [makeRow()], true /* duplicate */, provider);

    const results = await service.run({ dryRun: false, forceResend: true });

    expect(results[0].status).toBe('sent');
    expect(provider.sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ─── Real sending ─────────────────────────────────────────────────────────────

describe('real sending', () => {
  it('sends email and records sent status with messageId', async () => {
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-abc' }),
    };
    const service = new TestService([USER], [makeRow()], false, provider);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('sent');
    expect(results[0].messageId).toBe('msg-abc');

    const sentRecord = service.recordedSummaries.find(r => r.status === 'sent');
    expect(sentRecord?.provider_message_id).toBe('msg-abc');
    expect(sentRecord?.sent_at).not.toBeNull();
  });

  it('records failed status when provider throws', async () => {
    const provider: EmailProvider = {
      sendEmail: jest.fn().mockRejectedValue(new Error('Resend API error: HTTP 429')),
    };
    const service = new TestService([USER], [makeRow()], false, provider);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('429');

    const failedRecord = service.recordedSummaries.find(r => r.status === 'failed');
    expect(failedRecord?.error).toContain('429');
  });

  it('continues processing remaining users after one fails', async () => {
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

    const service = new MultiUserService([USER, USER2], [makeRow()], false, provider);
    const results = await service.run({ dryRun: false });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('sent');
  });
});

// ─── Provider null guard ───────────────────────────────────────────────────────

describe('provider null guard', () => {
  it('records failed status when dryRun=false but no provider', async () => {
    const service = new TestService([USER], [makeRow()], false, null /* no provider */);

    const results = await service.run({ dryRun: false });

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('emailProvider is null');
  });
});

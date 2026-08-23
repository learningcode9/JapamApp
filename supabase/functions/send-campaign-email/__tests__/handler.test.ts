import { handleCampaignRequest } from '../handler';
import { isOperatorAuthorization } from '../../_shared/email/operatorAuth';

function operatorToken(role = 'service_role'): string {
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url');
  return `header.${payload}.signature`;
}

function request(body: unknown, authorization = `Bearer ${operatorToken()}`): Request {
  return new Request('https://example.test/functions/v1/send-campaign-email', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function makeDeps(results: unknown[] = [{ userId: 'u1', email: 'user@example.com', status: 'dry_run' }]) {
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-only',
    RESEND_API_KEY: 'resend-test-only',
    EMAIL_FROM_ADDRESS: 'Japam App <noreply@example.com>',
    EMAIL_UNSUBSCRIBE_URL: 'https://example.com/unsubscribe',
    EMAIL_UNSUBSCRIBE_SECRET: 'unsubscribe-test-only',
    EMAIL_SEND_MODE: 'controlled',
    EMAIL_ALLOWLIST: 'learningcode9@gmail.com',
    EMAIL_CONTROLLED_RECIPIENT: 'learningcode9@gmail.com',
  };
  let providerCreations = 0;
  let remoteWrites = 0;
  const serviceRun = jest.fn().mockResolvedValue(results);
  const loadedConfigs: unknown[] = [];

  const deps = {
    getEnv: (name: string) => env[name],
    isOperatorAuthorization,
    getCampaign: (id: string) => {
      if (id !== '15day_inspiration') throw new Error(`Unknown campaign ${id}`);
      return { id };
    },
    validateProductionEnv: () => [],
    assertCampaignUnsubscribeReady: jest.fn(),
    loadEmailConfig: () => {
      const config = {
        excludedEmails: new Set((env.EMAIL_CAMPAIGN_EXCLUDED_EMAILS ?? '').split(',').filter(Boolean)),
      };
      loadedConfigs.push(config);
      return config;
    },
    createSupabaseClient: jest.fn(() => ({ remoteWrites })),
    createEmailProvider: jest.fn(() => {
      providerCreations += 1;
      return { sendEmail: jest.fn() };
    }),
    createCampaignService: jest.fn(() => ({
      run: serviceRun,
    })),
  };

  return {
    deps,
    env,
    serviceRun,
    loadedConfigs,
    get providerCreations() {
      return providerCreations;
    },
    get remoteWrites() {
      return remoteWrites;
    },
  };
}

describe('send-campaign-email wrapper', () => {
  it('rejects unauthorized requests', async () => {
    const fixture = makeDeps();
    const response = await handleCampaignRequest(request({ dry_run: true }, 'Bearer not-a-jwt'), fixture.deps);

    expect(response.status).toBe(403);
    expect(fixture.serviceRun).not.toHaveBeenCalled();
  });

  it('accepts an authorized dry-run with zero provider calls and zero remote writes', async () => {
    const fixture = makeDeps();
    const response = await handleCampaignRequest(request({ campaign_id: '15day_inspiration', dry_run: true }), fixture.deps);
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.campaign_id).toBe('15day_inspiration');
    expect(body.provider_calls).toBe(0);
    expect(body.campaign_history_writes).toBe(0);
    expect(fixture.providerCreations).toBe(0);
    expect(fixture.remoteWrites).toBe(0);
    expect(fixture.serviceRun).toHaveBeenCalledWith({ dryRun: true });
  });

  it('keeps dry-run provider calls and writes at zero when real-send mode is missing', async () => {
    const fixture = makeDeps();
    delete fixture.env.EMAIL_SEND_MODE;
    const response = await handleCampaignRequest(request({ dry_run: true }), fixture.deps);
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.provider_calls).toBe(0);
    expect(body.campaign_history_writes).toBe(0);
    expect(fixture.providerCreations).toBe(0);
    expect(fixture.remoteWrites).toBe(0);
  });

  it('reports the effective mode and real-send authorization from validate_only', async () => {
    const fixture = makeDeps();
    const body = await responseJson(
      await handleCampaignRequest(request({ validate_only: true }), fixture.deps),
    );

    expect(body.effective_mode).toBe('controlled');
    expect(body.real_send_authorized).toBe(true);
    expect(body.allowlist_recipient_count).toBe(1);
  });

  it('rejects malformed input instead of silently treating it as a dry-run', async () => {
    const fixture = makeDeps();
    const response = await handleCampaignRequest(
      new Request('https://example.test/functions/v1/send-campaign-email', {
        method: 'POST',
        headers: { authorization: `Bearer ${operatorToken()}` },
        body: '{not-json',
      }),
      fixture.deps,
    );

    expect(response.status).toBe(400);
    expect(fixture.serviceRun).not.toHaveBeenCalled();
  });

  it('rejects the legacy force_resend bypass', async () => {
    const fixture = makeDeps();
    const response = await handleCampaignRequest(request({ force_resend: true }), fixture.deps);

    expect(response.status).toBe(400);
    expect(fixture.serviceRun).not.toHaveBeenCalled();
  });

  it('preserves the controlled-recipient allowlist for real sends', async () => {
    const fixture = makeDeps([{ userId: 'u1', email: 'learningcode9@gmail.com', status: 'sent' }]);
    const response = await handleCampaignRequest(request({ dry_run: false }), fixture.deps);

    expect(response.status).toBe(200);
    expect(fixture.providerCreations).toBe(1);
    expect(fixture.deps.assertCampaignUnsubscribeReady).toHaveBeenCalled();
  });

  it('rejects the previous controlled recipient after the controlled hash moves', async () => {
    const fixture = makeDeps();
    fixture.env.EMAIL_ALLOWLIST = 'mantrajapamapp@gmail.com';
    fixture.env.EMAIL_CONTROLLED_RECIPIENT = 'mantrajapamapp@gmail.com';
    const response = await handleCampaignRequest(request({ dry_run: false }), fixture.deps);

    expect(response.status).toBe(409);
    expect(fixture.providerCreations).toBe(0);
    expect(fixture.serviceRun).not.toHaveBeenCalled();
  });

  it('blocks a real send when the allowlist is not exactly the controlled recipient', async () => {
    const fixture = makeDeps();
    fixture.env.EMAIL_ALLOWLIST = 'other@example.com';
    const response = await handleCampaignRequest(request({ dry_run: false }), fixture.deps);

    expect(response.status).toBe(409);
    expect(fixture.providerCreations).toBe(0);
    expect(fixture.serviceRun).not.toHaveBeenCalled();
  });

  it('supports a confirmed production mode with an unset allowlist', async () => {
    const fixture = makeDeps([{ userId: 'u1', email: 'user@example.com', status: 'sent' }]);
    fixture.env.EMAIL_SEND_MODE = 'production';
    fixture.env.EMAIL_PRODUCTION_CONFIRMATION = 'SEND_TO_ALL_ELIGIBLE_USERS';
    delete fixture.env.EMAIL_ALLOWLIST;
    delete fixture.env.EMAIL_CONTROLLED_RECIPIENT;

    const response = await handleCampaignRequest(request({ dry_run: false }), fixture.deps);

    expect(response.status).toBe(200);
    expect(fixture.providerCreations).toBe(1);
  });

  it('supports a confirmed production mode narrowed by a valid allowlist', async () => {
    const fixture = makeDeps([{ userId: 'u1', email: 'user@example.com', status: 'sent' }]);
    fixture.env.EMAIL_SEND_MODE = 'production';
    fixture.env.EMAIL_PRODUCTION_CONFIRMATION = 'SEND_TO_ALL_ELIGIBLE_USERS';
    fixture.env.EMAIL_ALLOWLIST = 'user@example.com';

    const response = await handleCampaignRequest(request({ dry_run: false }), fixture.deps);

    expect(response.status).toBe(200);
    expect(fixture.providerCreations).toBe(1);
  });

  it('blocks production mode without the exact confirmation', async () => {
    const fixture = makeDeps();
    fixture.env.EMAIL_SEND_MODE = 'production';
    delete fixture.env.EMAIL_PRODUCTION_CONFIRMATION;
    delete fixture.env.EMAIL_ALLOWLIST;

    const response = await handleCampaignRequest(request({ dry_run: false }), fixture.deps);
    const body = await responseJson(response);

    expect(response.status).toBe(409);
    expect(body.reason).toMatch(/EMAIL_PRODUCTION_CONFIRMATION/);
    expect(fixture.providerCreations).toBe(0);
  });

  it('blocks missing/invalid mode and malformed allowlists before provider creation', async () => {
    const missingMode = makeDeps();
    delete missingMode.env.EMAIL_SEND_MODE;
    const missingResponse = await handleCampaignRequest(request({ dry_run: false }), missingMode.deps);
    expect(missingResponse.status).toBe(409);
    expect(missingMode.providerCreations).toBe(0);

    const malformedAllowlist = makeDeps();
    malformedAllowlist.env.EMAIL_ALLOWLIST = 'not-an-email';
    const malformedResponse = await handleCampaignRequest(
      request({ dry_run: false }),
      malformedAllowlist.deps,
    );
    expect(malformedResponse.status).toBe(409);
    expect(malformedAllowlist.providerCreations).toBe(0);
  });

  it('passes EMAIL_CAMPAIGN_EXCLUDED_EMAILS into the shared campaign configuration', async () => {
    const fixture = makeDeps();
    fixture.env.EMAIL_CAMPAIGN_EXCLUDED_EMAILS = 'Reviewer@example.com,internal@example.com';
    await handleCampaignRequest(request({ dry_run: true }), fixture.deps);

    const config = fixture.loadedConfigs[0] as { excludedEmails: Set<string> };
    expect(config.excludedEmails).toEqual(
      new Set(['Reviewer@example.com', 'internal@example.com']),
    );
  });

  it('reports shared-service eligibility outcomes without changing them', async () => {
    const statuses = [
      'dry_run',
      'skipped_no_activity',
      'skipped_duplicate',
      'skipped_unsubscribed',
      'skipped_invalid_email',
      'skipped_account_too_new',
    ];
    const fixture = makeDeps(statuses.map((status, index) => ({
      userId: `u${index}`,
      email: `user${index}@example.com`,
      status,
    })));
    const body = await responseJson(await handleCampaignRequest(request({ dry_run: true }), fixture.deps));

    expect(body.eligible_count).toBe(1);
    expect(body.skipped_counts).toEqual({
      skipped_no_activity: 1,
      skipped_duplicate: 1,
      skipped_unsubscribed: 1,
      skipped_invalid_email: 1,
      skipped_account_too_new: 1,
    });
  });

  it('delegates repeated-send, idempotency, and ambiguous-failure safety to the shared service', async () => {
    const fixture = makeDeps([
      { userId: 'u1', email: 'user@example.com', status: 'skipped_duplicate' },
      { userId: 'u2', email: 'user2@example.com', status: 'failed', reason: 'provider timeout' },
    ]);
    const response = await handleCampaignRequest(request({ dry_run: true }), fixture.deps);
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.counts.skipped_duplicate).toBe(1);
    expect(body.counts.failed).toBe(1);
    expect(fixture.serviceRun).toHaveBeenCalledTimes(1);
  });
});

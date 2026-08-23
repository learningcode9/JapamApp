import { getRealSendAuthorization } from '../_shared/email/config.ts';

export interface CampaignHandlerDependencies {
  getEnv(name: string): string | undefined;
  isOperatorAuthorization(request: Request): boolean;
  getCampaign(id: string): { id: string };
  validateProductionEnv(): string[];
  assertCampaignUnsubscribeReady(): void;
  loadEmailConfig(): unknown;
  createSupabaseClient(url: string, serviceRoleKey: string): unknown;
  createEmailProvider(): unknown;
  createCampaignService(
    campaign: unknown,
    supabase: unknown,
    provider: unknown,
    config: unknown,
  ): { run(options: { dryRun: boolean }): Promise<unknown[]> };
}

type RequestBody = {
  campaign_id?: unknown;
  dry_run?: unknown;
  validate_only?: unknown;
  force_resend?: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function resultCounts(results: unknown[]): Record<string, number> {
  return results.reduce<Record<string, number>>((counts, result) => {
    const status =
      typeof result === 'object' && result !== null && 'status' in result
        ? String((result as { status: unknown }).status)
        : 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function invalidBody(body: RequestBody): string | null {
  if (body.campaign_id !== undefined && typeof body.campaign_id !== 'string') {
    return 'campaign_id must be a string.';
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
    return 'dry_run must be a boolean.';
  }
  if (body.validate_only !== undefined && typeof body.validate_only !== 'boolean') {
    return 'validate_only must be a boolean.';
  }
  if (body.force_resend !== undefined) {
    return 'force_resend is not supported; duplicate protection cannot be bypassed.';
  }
  return null;
}

export async function handleCampaignRequest(
  request: Request,
  deps: CampaignHandlerDependencies,
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Use POST for campaign execution.' }, 405);
  }

  // The deployed function uses verify_jwt=true at the gateway and this
  // second check to require a service_role operator token.
  if (!deps.isOperatorAuthorization(request)) {
    return json({ ok: false, error: 'Operator authorization required.' }, 403);
  }

  let body: RequestBody = {};
  try {
    const rawBody = await request.text();
    if (rawBody.trim()) body = JSON.parse(rawBody) as RequestBody;
  } catch {
    return json({ ok: false, error: 'Request body must be valid JSON.' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ ok: false, error: 'Request body must be a JSON object.' }, 400);
  }

  const bodyProblem = invalidBody(body);
  if (bodyProblem) return json({ ok: false, error: bodyProblem }, 400);

  const campaignId = (body.campaign_id as string | undefined) ?? '15day_inspiration';
  const dryRun = body.dry_run !== false;
  const validateOnly = body.validate_only === true;

  try {
    const campaign = deps.getCampaign(campaignId);
    const productionProblems = deps.validateProductionEnv();
    const authorization = await getRealSendAuthorization(deps.getEnv);

    if (validateOnly) {
      return json({
        ok: productionProblems.length === 0 && authorization.authorized,
        function: 'send-campaign-email',
        campaign_id: campaign.id,
        dry_run: dryRun,
        validation_only: true,
        production_ready: productionProblems.length === 0,
        effective_mode: authorization.mode,
        real_send_authorized: authorization.authorized,
        allowlist_configured: authorization.allowlist !== null,
        allowlist_recipient_count: authorization.allowlist?.size ?? 0,
        missing: productionProblems.map(problem => problem.split(' — ')[0]),
        real_send_blocker: authorization.authorized ? null : authorization.reason,
      });
    }

    if (!dryRun) {
      if (!authorization.authorized) {
        return json(
          {
            ok: false,
            error: 'Real-send authorization failed.',
            effective_mode: authorization.mode,
            reason: authorization.reason,
          },
          409,
        );
      }
      if (productionProblems.length > 0) {
        return json(
          { ok: false, error: 'Production configuration is incomplete.', missing: productionProblems.map(problem => problem.split(' — ')[0]) },
          503,
        );
      }
      deps.assertCampaignUnsubscribeReady();
    }

    const supabaseUrl = deps.getEnv('SUPABASE_URL') ?? deps.getEnv('EXPO_PUBLIC_SUPABASE_URL');
    const serviceRoleKey = deps.getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: 'Supabase server configuration is incomplete.' }, 503);
    }

    const supabase = deps.createSupabaseClient(supabaseUrl, serviceRoleKey);
    const provider = dryRun ? null : deps.createEmailProvider();
    const service = deps.createCampaignService(
      campaign,
      supabase,
      provider,
      deps.loadEmailConfig(),
    );
    const results = await service.run({ dryRun });
    const counts = resultCounts(results);

    return json({
      ok: true,
      campaign_id: campaign.id,
      dry_run: dryRun,
      eligible_count: counts.dry_run ?? 0,
      skipped_counts: Object.fromEntries(
        Object.entries(counts).filter(([status]) => status.startsWith('skipped_')),
      ),
      counts,
      results,
      ...(dryRun ? { provider_calls: 0, campaign_history_writes: 0 } : {}),
    });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : 'Campaign request failed.' },
      400,
    );
  }
}

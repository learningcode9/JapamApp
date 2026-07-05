/**
 * Supabase Edge Function: send-campaign-email
 *
 * Architecture:
 *   Business logic lives in ../_shared/email/ and is shared across all email
 *   functions. This function is generic over campaign id — it does not
 *   hardcode "15day_inspiration"; the campaign to run is read from the
 *   request body (or a scheduled trigger's config), looked up via
 *   ../_shared/email/campaigns/registry.ts.
 *
 * Local CLI usage (Node):
 *   CAMPAIGN_ID=15day_inspiration npx tsx scripts/sendCampaignEmail.ts
 *
 * Future Deno/Edge Function deployment:
 *   supabase functions deploy send-campaign-email
 *
 * Deno adaptation notes (for when this is wired up as a real Edge Function —
 * not done yet; no scheduling exists in this repo today):
 *   - Replace import paths with npm: specifiers or esm.sh URLs
 *   - Replace process.env with Deno.env.get()
 *   - Wrap with Deno.serve()
 *   - Example:
 *
 *     import { createClient } from 'npm:@supabase/supabase-js@2';
 *     import { CampaignEmailService } from '../_shared/email/campaignService.ts';
 *     import { getCampaign } from '../_shared/email/campaigns/registry.ts';
 *     import { loadEmailConfig } from '../_shared/email/config.ts';
 *     import { ResendProvider } from '../_shared/email/emailProvider.ts';
 *
 *     Deno.serve(async (req) => {
 *       const body = await req.json().catch(() => ({}));
 *       const campaign = getCampaign(body.campaign_id ?? '15day_inspiration');
 *       const dryRun = body.dry_run !== false;
 *       const url = Deno.env.get('SUPABASE_URL')!;
 *       const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 *       const supabase = createClient(url, key, { auth: { persistSession: false } });
 *       const provider = dryRun ? null : new ResendProvider(Deno.env.get('RESEND_API_KEY')!);
 *       const service = new CampaignEmailService(campaign, supabase, provider, loadEmailConfig());
 *       const results = await service.run({ dryRun, forceResend: body.force_resend ?? false });
 *       return Response.json({ results });
 *     });
 *
 * Adding a new campaign requires zero changes to this file — only a new
 * module under ../_shared/email/campaigns/ and one registry.ts entry.
 */

export {};

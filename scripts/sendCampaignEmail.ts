/**
 * CLI runner for any registered email campaign (see
 * supabase/functions/_shared/email/campaigns/registry.ts for the list).
 *
 * Usage:
 *   # Dry-run (default — no emails sent, would-send logged):
 *   CAMPAIGN_ID=15day_inspiration DRY_RUN=true npx tsx scripts/sendCampaignEmail.ts
 *
 *   # Real send (requires RESEND_API_KEY):
 *   CAMPAIGN_ID=15day_inspiration DRY_RUN=false RESEND_API_KEY=re_xxx npx tsx scripts/sendCampaignEmail.ts
 *
 * Required env vars — see docs/CAMPAIGN_EMAIL_ARCHITECTURE.md for the full list.
 * Reads .env.local automatically if present.
 */

import { createCampaignService } from '../supabase/functions/_shared/email/campaignService';
import { createEmailProvider } from '../supabase/functions/_shared/email/emailProvider';
import { getCampaign } from '../supabase/functions/_shared/email/campaigns/registry';

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: '.env.local' });
} catch {
  // dotenv is optional; ignore if not installed
}

async function main(): Promise<void> {
  const campaignId = process.env.CAMPAIGN_ID ?? '15day_inspiration';
  const dryRun = process.env.DRY_RUN !== 'false';
  const forceResend = process.env.FORCE_RESEND === 'true';

  console.log('[sendCampaignEmail] Starting');
  console.log(`  campaignId  = ${campaignId}`);
  console.log(`  dryRun      = ${dryRun}`);
  console.log(`  forceResend = ${forceResend}`);

  const campaign = getCampaign(campaignId);
  const emailProvider = dryRun ? null : createEmailProvider();
  const service = createCampaignService(campaign, emailProvider);

  const results = await service.run({ dryRun, forceResend });

  const failed = results.filter(r => r.status === 'failed');
  if (failed.length > 0) {
    console.error('[sendCampaignEmail] Failed deliveries:');
    for (const f of failed) {
      console.error(`  ${f.email}: ${f.reason}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[sendCampaignEmail] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

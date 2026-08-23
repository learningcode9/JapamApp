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

import { createCampaignService } from '../supabase/functions/_shared/email/campaignServiceFactory';
import { createCampaignEmailProvider } from '../supabase/functions/_shared/email/emailProvider';
import { getCampaign } from '../supabase/functions/_shared/email/campaigns/registry';
import {
  assertCampaignUnsubscribeReady,
  assertRealSendAuthorized,
  assertProductionReady,
} from '../supabase/functions/_shared/email/config';
import { getEnv } from '../supabase/functions/_shared/email/env';

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: '.env.local' });
} catch {
  // dotenv is optional; ignore if not installed
}

export async function ensureCliRealSendAuthorized(
  readEnv: (name: string) => string | undefined = getEnv,
): Promise<void> {
  return assertRealSendAuthorized(readEnv);
}

async function main(): Promise<void> {
  const campaignId = process.env.CAMPAIGN_ID ?? '15day_inspiration';
  const dryRun = process.env.DRY_RUN !== 'false';

  console.log('[sendCampaignEmail] Starting');
  console.log(`  campaignId  = ${campaignId}`);
  console.log(`  dryRun      = ${dryRun}`);

  if (!dryRun) {
    await ensureCliRealSendAuthorized();
    assertProductionReady();
    assertCampaignUnsubscribeReady();
  }

  const campaign = getCampaign(campaignId);
  const emailProvider = dryRun ? null : createCampaignEmailProvider();
  const service = createCampaignService(campaign, emailProvider);

  const results = await service.run({ dryRun });

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

if (!process.env.JEST_WORKER_ID) {
  main().catch(err => {
    console.error('[sendCampaignEmail] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

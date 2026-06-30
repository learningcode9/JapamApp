/**
 * CLI runner for 15-day Japam summary emails.
 *
 * Usage:
 *   # Dry-run (default — no emails sent, stats logged):
 *   DRY_RUN=true npx ts-node --project server/tsconfig.json scripts/sendSummaryEmails.ts
 *
 *   # Real send (requires RESEND_API_KEY):
 *   DRY_RUN=false RESEND_API_KEY=re_xxx npx ts-node --project server/tsconfig.json scripts/sendSummaryEmails.ts
 *
 * Required env vars — see SUMMARY_EMAIL_SETUP.md for full list.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' });

import { createSummaryEmailService } from '../server/email/summaryService';
import { createEmailProvider } from '../server/email/emailProvider';

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN !== 'false';
  const forceResend = process.env.FORCE_RESEND === 'true';
  const periodDays = Number(process.env.PERIOD_DAYS) || 15;

  console.log('[sendSummaryEmails] Starting');
  console.log(`  dryRun     = ${dryRun}`);
  console.log(`  forceResend= ${forceResend}`);
  console.log(`  periodDays = ${periodDays}`);

  const emailProvider = dryRun ? null : createEmailProvider();
  const service = createSummaryEmailService(emailProvider);

  const results = await service.run({ dryRun, forceResend, periodDays });

  const failed = results.filter(r => r.status === 'failed');
  if (failed.length > 0) {
    console.error('[sendSummaryEmails] Failed deliveries:');
    for (const f of failed) {
      console.error(`  ${f.email}: ${f.reason}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[sendSummaryEmails] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

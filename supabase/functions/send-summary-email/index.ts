/**
 * Supabase Edge Function: send-summary-email
 *
 * Architecture:
 *   Business logic lives in ../_shared/email/ and is shared across all email
 *   functions (15-day summary, monthly summary, milestones, etc.).
 *
 * Local CLI usage (Node):
 *   npx tsx scripts/sendSummaryEmails.ts
 *
 * Future Deno/Edge Function deployment:
 *   supabase functions deploy send-summary-email
 *
 * Deno adaptation notes (for when this is wired up as a real Edge Function):
 *   - Replace import paths with npm: specifiers or esm.sh URLs
 *   - Replace process.env with Deno.env.get()
 *   - Wrap with Deno.serve() or the Supabase function handler
 *   - Example:
 *
 *     import { createClient } from 'npm:@supabase/supabase-js@2';
 *     import { SummaryEmailService } from '../_shared/email/summaryService.ts';
 *     import { ResendProvider } from '../_shared/email/emailProvider.ts';
 *
 *     Deno.serve(async (req) => {
 *       const body = await req.json().catch(() => ({}));
 *       const dryRun = body.dry_run !== false;
 *       const url = Deno.env.get('SUPABASE_URL')!;
 *       const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 *       const from = Deno.env.get('EMAIL_FROM_ADDRESS') ?? 'Japam App <noreply@japamapp.com>';
 *       const appUrl = Deno.env.get('APP_URL') ?? '';
 *       const supabase = createClient(url, key, { auth: { persistSession: false } });
 *       const provider = dryRun ? null : new ResendProvider(Deno.env.get('RESEND_API_KEY')!);
 *       const service = new SummaryEmailService(supabase, provider, from, appUrl);
 *       const results = await service.run({ dryRun, forceResend: body.force_resend ?? false });
 *       return Response.json({ results });
 *     });
 */

export {};

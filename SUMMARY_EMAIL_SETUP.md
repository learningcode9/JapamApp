# Japam App — 15-Day Summary Email Setup

## Architecture

Email logic lives in `supabase/functions/_shared/email/` — the standard Supabase location for
shared code between Edge Functions. This keeps all email features (15-day summary, monthly
summary, milestones, etc.) co-located with Supabase and ready for Edge Function deployment.

```
supabase/
  functions/
    _shared/
      email/
        types.ts          ← All shared TypeScript types
        calculator.ts     ← Pure stats calculation (no side effects)
        emailProvider.ts  ← EmailProvider interface + ResendProvider
        template.ts       ← HTML + plain-text email builders
        summaryService.ts ← Orchestration: fetch → deduplicate → send
      __tests__/
        calculator.test.ts
        summaryService.test.ts
    send-summary-email/
      index.ts            ← Future Supabase Edge Function entry point
  migrations/
    20260630_add_user_email_summaries.sql
scripts/
  sendSummaryEmails.ts    ← Local CLI runner
```

**Dry-run mode is the default.** No emails are sent unless `DRY_RUN=false` is set explicitly.

---

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | ✅ Yes | Supabase project URL (already used by the app) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Yes | Supabase service role key — gives admin access to `auth.users` |
| `RESEND_API_KEY` | Only for real sending | Resend API key from resend.com |
| `EMAIL_FROM_ADDRESS` | No | Sender address (default: `Japam App <noreply@japamapp.com>`) |
| `APP_URL` | No | URL shown in the "Continue your Japam" button (e.g. `https://mantra-japam.vercel.app`) |
| `DRY_RUN` | No | Set to `false` to enable real sending. Defaults to `true`. |
| `FORCE_RESEND` | No | Set to `true` to re-send even if a record already exists for the period. |
| `PERIOD_DAYS` | No | Number of days in the window (default: `15`). |

> ⚠️ Never commit `SUPABASE_SERVICE_ROLE_KEY` or `RESEND_API_KEY` to git.
> Put them in `.env.local` (already in `.gitignore`).

---

## Supabase SQL Migration

Before enabling real sending, run this migration in the Supabase SQL editor:

```
supabase/migrations/20260630_add_user_email_summaries.sql
```

Or paste directly into the Supabase dashboard → SQL Editor.

This creates the `user_email_summaries` table with:
- `UNIQUE(user_id, email_type, period_start)` — prevents duplicate sends
- Indexes for fast per-user and per-period queries
- RLS enabled (service role bypasses it automatically)

---

## Running Dry-Run Locally

```bash
# 1. Add credentials to .env.local (not committed):
echo "EXPO_PUBLIC_SUPABASE_URL=https://xxx.supabase.co" >> .env.local
echo "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi..." >> .env.local

# 2. Run dry-run (default — no emails sent):
DRY_RUN=true npx tsx scripts/sendSummaryEmails.ts
```

You will see per-user stats logged to stdout. Nothing is sent. A `dry_run` row is written
to `user_email_summaries` so you can verify the duplicate-prevention logic.

---

## Enabling Real Sending

```bash
# Add your Resend API key:
echo "RESEND_API_KEY=re_xxxxxxxxxxxx" >> .env.local
echo "APP_URL=https://mantra-japam.vercel.app" >> .env.local

# Send for real (DRY_RUN=false):
DRY_RUN=false npx tsx scripts/sendSummaryEmails.ts
```

The script exits with code 1 if any delivery fails, so it integrates cleanly with a CI/cron job.

---

## Running Tests

Tests are co-located with the source and run through the existing root jest config — no separate
test runner or config needed:

```bash
npm test
```

The 35 email tests run alongside the existing app tests in one pass.

---

## Swapping the Email Provider

The `EmailProvider` interface is in `supabase/functions/_shared/email/emailProvider.ts`:

```typescript
export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<SendEmailResult>;
}
```

To use a different provider (SendGrid, AWS SES, Postmark, etc.):

1. Create a class that implements `EmailProvider`
2. Return it from `createEmailProvider()`, or pass it directly to `new SummaryEmailService(...)`
3. No other files need to change

---

## Adding Future Email Types

The `_shared/email/` directory is designed to grow. To add a monthly summary or milestone email:

1. Add the new `email_type` string constant in `summaryService.ts` (or create a new service class)
2. Reuse `calculator.ts`, `template.ts`, and `emailProvider.ts` as-is
3. Create a new Edge Function folder: `supabase/functions/send-monthly-email/index.ts`
4. The `user_email_summaries` table already supports any `email_type` value

---

## Scheduling (Future)

Once validated, the script can be scheduled via:

- **Supabase Cron**: `SELECT cron.schedule('send-summary-emails', '0 6 */15 * *', $$...$$)`
- **Supabase Edge Functions**: Deploy `supabase/functions/send-summary-email/` — see `index.ts` for adaptation notes
- **GitHub Actions**: `schedule: cron: '0 6 * * *'` running `npx tsx scripts/sendSummaryEmails.ts`

Do not schedule until:
1. The SQL migration has been applied to production Supabase
2. At least one successful dry-run has been verified against real data
3. `RESEND_API_KEY` is stored securely (GitHub Actions secret / Vercel env var / Supabase secret)

---

## What the Email Contains

- Total Sessions (number of practice sessions)
- Total Malas (mala rounds completed)
- Days Practiced out of 15
- Longest Streak (consecutive active days)
- Best Day (date with highest total malas)
- Average Malas per Active Day
- Source Breakdown — Timer / Tap / Manual (only shown if `source` column exists in `japam_history`)
- Devotional encouragement message
- "Continue your Japam" button (if `APP_URL` is set)

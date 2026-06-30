# Japam App — 15-Day Summary Email Setup

## Overview

`server/email/` contains the backend logic for sending 15-day Japam progress summary emails.
The script reads from Supabase, calculates stats, and delivers via Resend (or any swappable provider).
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

# 2. Install server dependencies:
cd server && npm install && cd ..

# 3. Run dry-run (default — no emails sent):
DRY_RUN=true npx ts-node --project server/tsconfig.json scripts/sendSummaryEmails.ts
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
DRY_RUN=false npx ts-node --project server/tsconfig.json scripts/sendSummaryEmails.ts
```

The script exits with code 1 if any delivery fails, so it integrates cleanly with a CI/cron job.

---

## Swapping the Email Provider

The `EmailProvider` interface is in `server/email/emailProvider.ts`:

```typescript
export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<SendEmailResult>;
}
```

To use a different provider (SendGrid, AWS SES, Postmark, etc.):

1. Create a class that implements `EmailProvider`
2. Return it from `createEmailProvider()` (or pass it directly to `createSummaryEmailService()`)
3. No other files need to change

---

## Running Tests

```bash
# Server tests (calculator + service logic):
cd server && npm test

# Root app tests (must continue to pass unchanged):
cd .. && npm test
```

---

## Scheduling (Future)

Once validated, the script can be scheduled via:

- **GitHub Actions**: `schedule: cron: '0 6 * * *'` (runs daily; only sends if a 15-day period boundary is reached)
- **Vercel Cron Jobs**: Add a `/api/send-summary` serverless route calling the same service
- **Supabase Edge Functions**: Port `summaryService.ts` to Deno (types are compatible)

Do not schedule until:
1. The SQL migration has been applied to production Supabase
2. At least one successful dry-run has been verified against real data
3. `RESEND_API_KEY` is stored securely (GitHub Actions secret / Vercel env var)

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

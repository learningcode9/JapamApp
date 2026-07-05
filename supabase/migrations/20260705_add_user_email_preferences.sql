-- Migration: add user_email_preferences table
-- Purpose:   Tracks per-user email opt-out state so no send pipeline ever
--            emails someone who has unsubscribed. One row per user_id; a
--            NULL unsubscribed_at means the user has not opted out (the
--            default — most users will never have a row at all, and that
--            absence is correctly treated as "subscribed").
--
-- Deliberately its own table rather than a column on user_profiles:
-- user_profiles' existing RLS policies grant UPDATE/INSERT to `anon` and
-- `authenticated` with USING (true) WITH CHECK (true) — i.e. any client can
-- currently modify any OTHER user's row, not just their own. A compliance-
-- critical opt-out flag must not inherit that same over-permissive write
-- access. This table instead mirrors user_email_summaries's RLS posture
-- exactly: enabled, zero public policies, service-role-only.
--
-- Run this in the Supabase SQL editor or via the Supabase CLI before
-- enabling real (non-dry-run) campaign sending.

CREATE TABLE IF NOT EXISTS public.user_email_preferences (
  id              BIGSERIAL     PRIMARY KEY,
  user_id         TEXT          NOT NULL,
  unsubscribed_at TIMESTAMPTZ,
  reason          TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_user_email_preferences_user_id UNIQUE (user_id)
);

COMMENT ON TABLE  public.user_email_preferences IS
  'Per-user email opt-out state. One row per user_id. A NULL unsubscribed_at means the user has not opted out; most users will have no row at all, which is equivalent.';
COMMENT ON COLUMN public.user_email_preferences.unsubscribed_at IS
  'Timestamp the user opted out, or NULL if still subscribed to campaign emails.';
COMMENT ON COLUMN public.user_email_preferences.reason IS
  'Optional free-text reason captured at unsubscribe time (e.g. from an unsubscribe page form). Not required.';

CREATE INDEX IF NOT EXISTS idx_uep_user_id
  ON public.user_email_preferences (user_id);

-- Partial index — the send pipeline only ever queries for rows where
-- unsubscribed_at IS NOT NULL (see dataAccess.ts's getUnsubscribedUserIds).
CREATE INDEX IF NOT EXISTS idx_uep_unsubscribed
  ON public.user_email_preferences (user_id)
  WHERE unsubscribed_at IS NOT NULL;

-- RLS: enabled, no public policies. The service role (used by every email
-- script/service — see createCampaignService/createSummaryEmailService)
-- bypasses RLS automatically. No app/web unsubscribe page exists yet
-- (tracked separately); until one does, this table is written by
-- operators/service-role only, which is the safest possible posture for a
-- compliance-relevant flag.
ALTER TABLE public.user_email_preferences ENABLE ROW LEVEL SECURITY;

-- Migration: add user_email_summaries table
-- Purpose:   Tracks outbound summary emails to prevent duplicates and enable auditing.
-- Run this in the Supabase SQL editor or via the Supabase CLI before enabling email sending.

CREATE TABLE IF NOT EXISTS public.user_email_summaries (
  id                  BIGSERIAL     PRIMARY KEY,
  user_id             TEXT          NOT NULL,
  email_type          TEXT          NOT NULL DEFAULT '15day_summary',
  period_start        DATE          NOT NULL,
  period_end          DATE          NOT NULL,
  sent_at             TIMESTAMPTZ,
  status              TEXT          NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Prevents sending the same email type for the same user and period twice.
  CONSTRAINT uq_user_email_summary UNIQUE (user_id, email_type, period_start)
);

COMMENT ON TABLE  public.user_email_summaries IS
  'Tracks outbound summary emails. One row per (user, email_type, period_start).';
COMMENT ON COLUMN public.user_email_summaries.status IS
  'pending | sent | failed | dry_run';

-- Indexes for the two most common queries: by user and by period+type.
CREATE INDEX IF NOT EXISTS idx_ues_user_id
  ON public.user_email_summaries (user_id);

CREATE INDEX IF NOT EXISTS idx_ues_period
  ON public.user_email_summaries (period_start, email_type);

-- RLS: enable but grant no public policies.
-- The script uses the service role key which bypasses RLS automatically.
ALTER TABLE public.user_email_summaries ENABLE ROW LEVEL SECURITY;

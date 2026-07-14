-- Guarded RLS hotfix: public.japam_user_totals + public.japam_timer_state
--
-- Problem (confirmed LIVE against production today via a narrow, read-only anon-key REST probe —
-- HEAD + Prefer: count=exact, no row data returned, no writes attempted):
--   HEAD /rest/v1/japam_user_totals?select=user_id  -> HTTP 200, content-range: 0-41/42 (all rows visible to anon)
--   HEAD /rest/v1/japam_timer_state?select=user_id  -> HTTP 200, content-range: 0-49/50 (all rows visible to anon)
-- Corroborated by schema.sql (production) / schema_staging.sql (staging) — both environments carry
-- the IDENTICAL vulnerable baseline (same 6 policy names, same structure), confirmed by direct
-- comparison of the two dumps:
--   public.japam_user_totals — anon can SELECT/INSERT/UPDATE everything (USING/WITH CHECK true),
--                               policies "Allow anon read/insert/update totals".
--   public.japam_timer_state — anon can SELECT/INSERT/UPDATE everything (USING/WITH CHECK true),
--                               policies "Allow anon read/insert/update timer".
-- Neither table has ANY authenticated-role policy today — this migration creates them from
-- scratch (unlike the japam_history hotfix, there is nothing pre-existing to preserve here).
--
-- Fix: replace anon-open access with authenticated-only, ownership-scoped SELECT/INSERT/UPDATE.
-- No DELETE policy is added for either table (neither table has a client delete path today —
-- confirmed via repo-wide grep of app/(tabs)/index.tsx, app/(tabs)/tap-japam.tsx,
-- contexts/timer-context.tsx; adding DELETE would be a privilege the app doesn't use).
--
-- Client migration this depends on (companion change, tracked separately, NOT part of this SQL
-- file, must land in the same release as this migration or ship first):
--   Every current call to these two tables uses the anon key unconditionally, with no session-JWT
--   attempt at all — confirmed in current production code (main):
--     app/(tabs)/index.tsx        lines ~459, ~1033 (timer_state save), ~675 (user_totals save),
--                                  ~1097 (timer_state fetch)
--     app/(tabs)/tap-japam.tsx    saveUserTotalToSupabase, saveTimerStateToSupabase,
--                                  fetchTimerStateFromSupabase, the AppState-background save POST
--     contexts/timer-context.tsx  syncLifetimeTotalToSupabase (user_totals only; this file has no
--                                  timer_state calls)
--   Each call site's `Authorization: Bearer ${key}` (anon key) must become
--   `Authorization: Bearer ${sessionToken}` where sessionToken is
--   `(await supabase.auth.getSession()).data.session?.access_token`, mirroring the exact pattern
--   already used for japam_history in contexts/timer-context.tsx's syncPendingHistory (session
--   token preferred, request skipped/deferred if no session — NOT a silent fallback to the anon
--   key, since after this migration the anon key will no longer work for these tables at all).
--   Guest/anonymous-mode users (no session) simply skip these two syncs, same as history already
--   does for guests today.
--
-- DO NOT RUN until explicitly approved. NOT executed against any database yet (no staging, no
-- production). This SQL file is identical for both environments (staging's baseline was confirmed
-- byte-identical to production's for these two tables) — run it in STAGING FIRST as its own
-- transaction, confirm the app still functions end-to-end there (Tap Japam total sync, Timer
-- background-state save/restore) with the client migration above deployed to staging, THEN run
-- unchanged against production. Do not run against both environments in the same sitting without
-- that staging confirmation step in between.
-- Run in: Supabase SQL editor (or psql), against ONE environment at a time.
-- Paste and run this entire file as one script — it is one transaction (BEGIN..COMMIT). Any guard
-- failure RAISEs an EXCEPTION, aborting the whole transaction automatically (Postgres DDL is fully
-- transactional) — nothing above the failing point is kept.
-- Re-run safety: every DROP is `IF EXISTS` and every CREATE POLICY is preceded by its own
-- `DROP POLICY IF EXISTS`, so a second run after a successful first run is a no-op (the pre-apply
-- guard checks for the OLD vulnerable baseline and will correctly refuse to re-apply once fixed).

BEGIN;

-- ─── SECTION 1: PRE-APPLY GUARD (fail closed) ──────────────────────────────────
--
-- Refuses to proceed unless the live baseline is EXACTLY the confirmed-vulnerable state this
-- migration was written against, and that no authenticated-role policy already exists on either
-- table (this migration assumes a clean slate for `authenticated` — if one already exists, that's
-- an unknown state this script was not written to reconcile with).

DO $$
DECLARE
  vulnerable_policy_count int;
  existing_authenticated_policy_count int;
BEGIN
  -- 1a. The exact six vulnerable anon policies must all be present (three per table).
  SELECT count(*) INTO vulnerable_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('japam_user_totals', 'japam_timer_state')
    AND policyname IN (
      'Allow anon read totals', 'Allow anon insert totals', 'Allow anon update totals',
      'Allow anon read timer',  'Allow anon insert timer',  'Allow anon update timer'
    );

  IF vulnerable_policy_count <> 6 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected exactly 6 vulnerable anon policies across japam_user_totals/'
      'japam_timer_state, found %. Live baseline does not match what this migration was written '
      'against — refusing to apply. If this migration already ran successfully, this is expected '
      '(nothing left to fix).', vulnerable_policy_count;
  END IF;

  -- 1b. No authenticated-role policy already exists on either table — this migration only knows
  -- how to create from a clean slate, not reconcile with a pre-existing authenticated policy.
  SELECT count(*) INTO existing_authenticated_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('japam_user_totals', 'japam_timer_state')
    AND 'authenticated' = ANY(roles);

  IF existing_authenticated_policy_count <> 0 THEN
    RAISE EXCEPTION
      'GUARD FAILED: % authenticated-role polic(y/ies) already exist on japam_user_totals/'
      'japam_timer_state. This migration assumes none exist yet — refusing to apply into an '
      'unknown state.', existing_authenticated_policy_count;
  END IF;
END $$;


-- ─── SECTION 2: APPLY — public.japam_user_totals ───────────────────────────────

DROP POLICY IF EXISTS "Allow anon read totals"   ON public.japam_user_totals;
DROP POLICY IF EXISTS "Allow anon insert totals" ON public.japam_user_totals;
DROP POLICY IF EXISTS "Allow anon update totals" ON public.japam_user_totals;

DROP POLICY IF EXISTS "authenticated_select_own_totals" ON public.japam_user_totals;
CREATE POLICY "authenticated_select_own_totals"
  ON public.japam_user_totals
  FOR SELECT
  TO authenticated
  USING (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );

DROP POLICY IF EXISTS "authenticated_insert_own_totals" ON public.japam_user_totals;
CREATE POLICY "authenticated_insert_own_totals"
  ON public.japam_user_totals
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );

DROP POLICY IF EXISTS "authenticated_update_own_totals" ON public.japam_user_totals;
CREATE POLICY "authenticated_update_own_totals"
  ON public.japam_user_totals
  FOR UPDATE
  TO authenticated
  USING (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  )
  WITH CHECK (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );


-- ─── SECTION 3: APPLY — public.japam_timer_state ───────────────────────────────

DROP POLICY IF EXISTS "Allow anon read timer"   ON public.japam_timer_state;
DROP POLICY IF EXISTS "Allow anon insert timer" ON public.japam_timer_state;
DROP POLICY IF EXISTS "Allow anon update timer" ON public.japam_timer_state;

DROP POLICY IF EXISTS "authenticated_select_own_timer_state" ON public.japam_timer_state;
CREATE POLICY "authenticated_select_own_timer_state"
  ON public.japam_timer_state
  FOR SELECT
  TO authenticated
  USING (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );

DROP POLICY IF EXISTS "authenticated_insert_own_timer_state" ON public.japam_timer_state;
CREATE POLICY "authenticated_insert_own_timer_state"
  ON public.japam_timer_state
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );

DROP POLICY IF EXISTS "authenticated_update_own_timer_state" ON public.japam_timer_state;
CREATE POLICY "authenticated_update_own_timer_state"
  ON public.japam_timer_state
  FOR UPDATE
  TO authenticated
  USING (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  )
  WITH CHECK (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );


-- ─── SECTION 4: GRANTS ──────────────────────────────────────────────────────────
--
-- anon loses all table-level privileges on both tables (defense in depth — with zero anon
-- policies left, RLS already blocks anon entirely, but a bare grant with no policy is still an
-- unnecessary privilege). authenticated is scoped down to exactly SELECT/INSERT/UPDATE — no
-- DELETE (no client path deletes these rows), no TRUNCATE/REFERENCES/TRIGGER. service_role is
-- completely untouched (SECURITY DEFINER RPCs and any backend tooling run as this role and must
-- keep full access).

REVOKE ALL ON public.japam_user_totals FROM anon;
REVOKE ALL ON public.japam_timer_state FROM anon;

REVOKE ALL ON public.japam_user_totals FROM authenticated;
REVOKE ALL ON public.japam_timer_state FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.japam_user_totals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.japam_timer_state TO authenticated;


-- ─── SECTION 5: POST-APPLY GUARD (fail closed) ─────────────────────────────────

DO $$
DECLARE
  anon_policy_count int;
  anon_grant_count int;
  auth_policy_count int;
  auth_delete_grant_count int;
  service_role_grant_count int;
BEGIN
  -- 5a. anon has zero policies left on either table.
  SELECT count(*) INTO anon_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('japam_user_totals', 'japam_timer_state')
    AND 'anon' = ANY(roles);

  IF anon_policy_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % polic(y/ies) on japam_user_totals/japam_timer_state.',
      anon_policy_count;
  END IF;

  -- 5b. anon has zero table-level grants left on either table.
  SELECT count(*) INTO anon_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('japam_user_totals', 'japam_timer_state')
    AND grantee = 'anon';

  IF anon_grant_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % grant(s) on japam_user_totals/japam_timer_state.',
      anon_grant_count;
  END IF;

  -- 5c. authenticated has exactly the 6 new ownership policies (3 per table: SELECT/INSERT/UPDATE).
  SELECT count(*) INTO auth_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('japam_user_totals', 'japam_timer_state')
    AND policyname IN (
      'authenticated_select_own_totals', 'authenticated_insert_own_totals', 'authenticated_update_own_totals',
      'authenticated_select_own_timer_state', 'authenticated_insert_own_timer_state', 'authenticated_update_own_timer_state'
    )
    AND roles = ARRAY['authenticated']::name[];

  IF auth_policy_count <> 6 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: expected 6 new authenticated ownership policies across both tables, '
      'found %.', auth_policy_count;
  END IF;

  -- 5d. authenticated has no DELETE grant on either table (this migration never adds one).
  SELECT count(*) INTO auth_delete_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('japam_user_totals', 'japam_timer_state')
    AND grantee = 'authenticated'
    AND privilege_type = 'DELETE';

  IF auth_delete_grant_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: authenticated has a DELETE grant on japam_user_totals/'
      'japam_timer_state — this migration must not add one.';
  END IF;

  -- 5e. service_role privileges on both tables are unreduced (still has every privilege type).
  SELECT count(DISTINCT privilege_type) INTO service_role_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('japam_user_totals', 'japam_timer_state')
    AND grantee = 'service_role';

  IF service_role_grant_count < 4 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: service_role privileges on japam_user_totals/japam_timer_state look '
      'reduced (% distinct privilege types found) — this migration must not touch service_role.',
      service_role_grant_count;
  END IF;
END $$;

COMMIT;


-- ─── SECTION 6: ROLLBACK (post-commit only — NOT auto-run) ─────────────────────
--
-- The transaction above already fails closed: any guard mismatch aborts everything before COMMIT,
-- so there is nothing to undo for a guard failure. This section is only for the separate case
-- where the migration COMMITted successfully but a real problem is found afterward (e.g. the
-- client migration didn't ship in time and signed-in users' totals/timer-state stopped syncing).
-- Restores the exact pre-migration policies/grants. Run as its own transaction, manually, only
-- after confirming the problem — this re-opens the original vulnerability, so treat it as a
-- last-resort, time-boxed measure while the client migration is fixed forward, not a casual revert.

-- BEGIN;
--
-- DROP POLICY IF EXISTS "authenticated_select_own_totals" ON public.japam_user_totals;
-- DROP POLICY IF EXISTS "authenticated_insert_own_totals" ON public.japam_user_totals;
-- DROP POLICY IF EXISTS "authenticated_update_own_totals" ON public.japam_user_totals;
-- DROP POLICY IF EXISTS "authenticated_select_own_timer_state" ON public.japam_timer_state;
-- DROP POLICY IF EXISTS "authenticated_insert_own_timer_state" ON public.japam_timer_state;
-- DROP POLICY IF EXISTS "authenticated_update_own_timer_state" ON public.japam_timer_state;
--
-- CREATE POLICY "Allow anon read totals"   ON public.japam_user_totals FOR SELECT TO anon USING (true);
-- CREATE POLICY "Allow anon insert totals" ON public.japam_user_totals FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "Allow anon update totals" ON public.japam_user_totals FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY "Allow anon read timer"   ON public.japam_timer_state FOR SELECT TO anon USING (true);
-- CREATE POLICY "Allow anon insert timer" ON public.japam_timer_state FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "Allow anon update timer" ON public.japam_timer_state FOR UPDATE TO anon USING (true) WITH CHECK (true);
--
-- GRANT ALL ON public.japam_user_totals TO anon;
-- GRANT ALL ON public.japam_timer_state TO anon;
-- GRANT ALL ON public.japam_user_totals TO authenticated;
-- GRANT ALL ON public.japam_timer_state TO authenticated;
--
-- COMMIT;

-- Guarded staging-only RLS hotfix: public.deleted_completions
--
-- Scope note: this migration is deliberately narrower than
-- db/rls_hotfix_japam_history_deleted_completions.sql. That earlier migration's pre-apply guard
-- correctly refused to run on staging because staging's public.japam_history is ALREADY
-- authenticated-only and ownership-scoped (confirmed live via `supabase db query --linked` and
-- against schema_staging.sql) — under the same policy names ("allow_japam_history_select"/
-- "allow_japam_history_insert") that migration expected to find still wide open. This migration
-- does not touch public.japam_history, or any policy/grant/function on it, at all — by design,
-- not by omission. It exists solely to bring public.deleted_completions on staging in line with
-- the same ownership model japam_history already has there.
--
-- Problem (live staging, confirmed via `supabase db query --linked`):
--   public.deleted_completions — anon can SELECT/INSERT/UPDATE/DELETE unconditionally
--   ("anon manage deleted_completions", FOR ALL, USING true, WITH CHECK true). This is the
--   *only* policy on the table today.
--
-- Fix: replace it with an authenticated-only SELECT scoped to the caller's own user_id — the only
-- access the client tombstone fetch (contexts/timer-context.tsx) needs. Legitimate writes already
-- go through delete_history_completions(text[]), a reviewed SECURITY DEFINER RPC deriving
-- identity from auth.uid() internally, so no direct authenticated INSERT/UPDATE/DELETE policy is
-- added.
--
-- STATUS: Executed and verified — staging (this script is staging-only by design and does not
-- apply to production; see the scope note above). Originally marked "DO NOT RUN until explicitly
-- approved" pending review; that approval was granted and this script has since been run.
-- Run in: Supabase SQL editor (or `supabase db query --linked -f`), against STAGING
-- (nhacglvxdypevrbvvkhn) ONLY. Never run against production (rftlqybgnbixotnpanec) — production's
-- public.deleted_completions is covered by db/rls_hotfix_japam_history_deleted_completions.sql
-- instead, alongside its (still-vulnerable-on-production) public.japam_history fix.
-- Paste and run this entire file as one script — it is one transaction (BEGIN..COMMIT). Any
-- guard failure RAISEs an EXCEPTION, which aborts the whole transaction automatically: nothing
-- above the failing point is kept.
-- Re-run safety: every DROP is `IF EXISTS` and the CREATE POLICY is preceded by its own
-- `DROP POLICY IF EXISTS`, so a second run after a successful first run is a no-op — Section 1's
-- guard will simply no longer find the old vulnerable policy and will correctly refuse to re-run.

BEGIN;

-- ─── SECTION 1: PRE-APPLY GUARD (fail closed) ──────────────────────────────────
--
-- Refuses to proceed unless public.deleted_completions is EXACTLY the confirmed-vulnerable state
-- this migration was written against, AND public.japam_history is untouched-so-far in the shape
-- this migration relies on (already authenticated-only/ownership-scoped — proof, not assumption,
-- that this migration has nothing to do there). Also snapshots japam_history's full policy set
-- and the delete_history_completions() definition for the post-verify "nothing else changed"
-- comparison in Section 3.

DO $$
DECLARE
  deleted_completions_policy_count int;
  anon_policy_on_target int;
  japam_history_anon_policy_count int;
BEGIN
  -- 1a. deleted_completions must have exactly one policy: the vulnerable anon-ALL one.
  SELECT count(*) INTO deleted_completions_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deleted_completions';

  IF deleted_completions_policy_count <> 1 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected exactly 1 policy on public.deleted_completions (the vulnerable '
      'anon-ALL one), found %. Live baseline does not match what this migration was written '
      'against — refusing to apply. If this migration already ran successfully, this is '
      'expected (nothing left to fix).', deleted_completions_policy_count;
  END IF;

  SELECT count(*) INTO anon_policy_on_target
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deleted_completions'
    AND policyname = 'anon manage deleted_completions'
    AND cmd = 'ALL'
    AND roles = ARRAY['anon']::name[]
    AND qual::text = 'true'
    AND with_check::text = 'true';

  IF anon_policy_on_target <> 1 THEN
    RAISE EXCEPTION
      'GUARD FAILED: "anon manage deleted_completions" not found in the exact expected shape '
      '(FOR ALL, TO anon, USING true, WITH CHECK true). Refusing to apply.';
  END IF;

  -- 1b. japam_history must already have ZERO anon-role policies (i.e. it's already fixed there,
  -- confirming this migration truly has nothing to do on that table and is safe to leave alone).
  SELECT count(*) INTO japam_history_anon_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japam_history' AND 'anon' = ANY(roles);

  IF japam_history_anon_policy_count <> 0 THEN
    RAISE EXCEPTION
      'GUARD FAILED: public.japam_history still has % anon-role polic(y/ies) — this migration '
      'assumes japam_history is already authenticated-only and does not touch it. If '
      'japam_history is not actually fixed on this environment, use '
      'db/rls_hotfix_japam_history_deleted_completions.sql instead (with a baseline matching '
      'this environment), not this one.', japam_history_anon_policy_count;
  END IF;

  -- 1c. delete_history_completions(text[]) must exist and be SECURITY DEFINER (the RPC this
  -- migration relies on for deleted_completions writes).
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'delete_history_completions'
      AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'GUARD FAILED: public.delete_history_completions(text[]) not found, or not SECURITY '
      'DEFINER. Refusing to apply — deleted_completions would have no write path left.';
  END IF;
END $$;

-- Snapshots (session-scoped temp tables) — captured BEFORE any mutation, compared again in
-- Section 3 to prove japam_history and the RPC were not touched by this migration.
CREATE TEMP TABLE _rls_staging_hotfix_japam_history_pre AS
SELECT
  policyname,
  cmd,
  roles::text AS roles,
  qual::text AS using_expr,
  with_check::text AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'japam_history';

CREATE TEMP TABLE _rls_staging_hotfix_pre_function_def AS
SELECT pg_get_functiondef('public.delete_history_completions(text[])'::regprocedure) AS def;


-- ─── SECTION 2: APPLY — public.deleted_completions ONLY ────────────────────────

DROP POLICY IF EXISTS "anon manage deleted_completions" ON public.deleted_completions;

DROP POLICY IF EXISTS "authenticated_select_own_tombstones" ON public.deleted_completions;
CREATE POLICY "authenticated_select_own_tombstones"
  ON public.deleted_completions
  FOR SELECT
  TO authenticated
  USING (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );

-- anon loses all table-level privileges. authenticated is left as-is: it already has SELECT/
-- INSERT/UPDATE/DELETE grants from the original table setup, but with no authenticated write
-- policy present, RLS blocks every write regardless — only the SECURITY DEFINER RPC can write.
-- service_role is not referenced anywhere in this file.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.deleted_completions FROM anon;


-- ─── SECTION 3: POST-APPLY GUARD (fail closed) ─────────────────────────────────

DO $$
DECLARE
  anon_policy_count int;
  anon_grant_count int;
  auth_select_count int;
  write_policy_count int;
  changed_japam_history_policies int;
  post_japam_history_count int;
  pre_japam_history_count int;
  pre_func_def text;
  post_func_def text;
BEGIN
  -- 3a. anon has zero policies and zero grants left on deleted_completions.
  SELECT count(*) INTO anon_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deleted_completions' AND 'anon' = ANY(roles);

  IF anon_policy_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % polic(y/ies) on deleted_completions.',
      anon_policy_count;
  END IF;

  SELECT count(*) INTO anon_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'deleted_completions' AND grantee = 'anon';

  IF anon_grant_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % grant(s) on deleted_completions.', anon_grant_count;
  END IF;

  -- 3b. Exactly one authenticated SELECT ownership policy exists, and no write policy exists.
  SELECT count(*) INTO auth_select_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deleted_completions'
    AND policyname = 'authenticated_select_own_tombstones' AND cmd = 'SELECT'
    AND roles = ARRAY['authenticated']::name[];

  IF auth_select_count <> 1 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: expected authenticated_select_own_tombstones SELECT policy on '
      'deleted_completions (found %).', auth_select_count;
  END IF;

  SELECT count(*) INTO write_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deleted_completions'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');

  IF write_policy_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: deleted_completions has % direct write polic(y/ies) — none should '
      'exist; writes must go through delete_history_completions(text[]).', write_policy_count;
  END IF;

  -- 3c. public.japam_history is completely unchanged (same policy set, byte for byte, as the
  -- Section 1 snapshot) — proves this migration really did leave it alone.
  SELECT count(*) INTO pre_japam_history_count FROM _rls_staging_hotfix_japam_history_pre;

  SELECT count(*) INTO post_japam_history_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japam_history';

  IF post_japam_history_count <> pre_japam_history_count THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: public.japam_history policy count changed (was %, now %) — this '
      'migration must not touch japam_history.', pre_japam_history_count, post_japam_history_count;
  END IF;

  SELECT count(*) INTO changed_japam_history_policies
  FROM _rls_staging_hotfix_japam_history_pre pre
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies post
    WHERE post.schemaname = 'public'
      AND post.tablename = 'japam_history'
      AND post.policyname = pre.policyname
      AND post.cmd::text = pre.cmd::text
      AND post.roles::text = pre.roles
      AND coalesce(post.qual::text, '') = coalesce(pre.using_expr, '')
      AND coalesce(post.with_check::text, '') = coalesce(pre.with_check_expr, '')
  );

  IF changed_japam_history_policies <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: % polic(y/ies) on public.japam_history changed during this '
      'migration — it must be untouched.', changed_japam_history_policies;
  END IF;

  -- 3d. delete_history_completions(text[]) definition is byte-for-byte unchanged.
  SELECT def INTO pre_func_def FROM _rls_staging_hotfix_pre_function_def;
  SELECT pg_get_functiondef('public.delete_history_completions(text[])'::regprocedure)
    INTO post_func_def;

  IF pre_func_def IS DISTINCT FROM post_func_def THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: public.delete_history_completions(text[]) definition changed during '
      'this migration — it must be untouched.';
  END IF;

  -- 3e. service_role grants on deleted_completions are untouched.
  IF (
    SELECT count(DISTINCT privilege_type) FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'deleted_completions' AND grantee = 'service_role'
  ) < 4 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: service_role privileges on deleted_completions look reduced — this '
      'migration must not touch service_role.';
  END IF;
END $$;

DROP TABLE _rls_staging_hotfix_japam_history_pre;
DROP TABLE _rls_staging_hotfix_pre_function_def;

COMMIT;


-- ─── SECTION 4: ROLLBACK (post-commit only — NOT auto-run) ─────────────────────
--
-- The transaction above already fails closed: any guard mismatch aborts everything before
-- COMMIT. This section is only for the separate case where the migration COMMITted successfully
-- but a real problem is found afterward. Restores the exact pre-migration policy/grant. Run as
-- its own transaction, manually, only after confirming the problem.

-- BEGIN;
--
-- DROP POLICY IF EXISTS "authenticated_select_own_tombstones" ON public.deleted_completions;
-- CREATE POLICY "anon manage deleted_completions" ON public.deleted_completions
--   TO anon USING (true) WITH CHECK (true);
-- GRANT ALL ON public.deleted_completions TO anon;
--
-- COMMIT;

-- Guarded RLS hotfix: public.japam_history + public.deleted_completions
--
-- Phase 1 (client migration, already live) moved every client REST call touching these two
-- tables from the raw anon key to the signed-in user's session JWT — see
-- lib/__tests__/anonKeyRestAuth.test.ts and commit 31898616f97ba21a9de9ff742525ad6fdbd6b403.
-- No client path depends on the anon-key/broad-authenticated access this migration removes.
--
-- Problem (live production, confirmed via schema.sql / pg_policies):
--   public.japam_history      — anon can SELECT/INSERT everything (USING/WITH CHECK true);
--                                authenticated can SELECT/INSERT for ANY user_id, not just its own
--                                (policies "allow_japam_history_select"/"allow_japam_history_insert"
--                                grant TO authenticated, anon with no ownership check at all).
--   public.deleted_completions — anon can SELECT/INSERT/UPDATE/DELETE unconditionally
--                                ("anon manage deleted_completions", USING/WITH CHECK true).
--
-- Fix: replace the above with authenticated-only, ownership-scoped policies. Legitimate
-- deleted_completions writes already go through delete_history_completions(text[]) — a reviewed
-- SECURITY DEFINER RPC that derives identity from auth.uid() internally — so no direct
-- authenticated INSERT/UPDATE/DELETE policy is added there.
--
-- STATUS: Executed and verified — production (F15, production-verified). On staging, this script's
-- pre-apply guard correctly no-op'd: staging's public.japam_history baseline already matched the
-- target authenticated-only/ownership-scoped state, so no mutation was needed or performed there.
-- The remaining public.deleted_completions gap on staging was closed separately by
-- db/rls_staging_hotfix_deleted_completions.sql. Originally marked "DO NOT RUN until explicitly
-- approved" pending review; that approval was granted and this script has since been run.
-- Run in: Supabase SQL editor (or psql), against ONE environment at a time.
-- Paste and run this entire file as one script — it is one transaction (BEGIN..COMMIT). Any
-- guard failure RAISEs an EXCEPTION, which aborts the whole transaction automatically (Postgres
-- DDL is fully transactional): nothing above the failing point is kept. There is nothing extra
-- to "undo" after a guard failure — the failure itself is the rollback.
-- Re-run safety: every DROP is `IF EXISTS` and every CREATE POLICY is preceded by its own
-- `DROP POLICY IF EXISTS`, so a second run after a successful first run is a no-op (the guard
-- block will simply find the *new* baseline already in place and this script's SELECT-baseline
-- guard, which checks for the *old* vulnerable baseline, will then correctly refuse to re-apply
-- — see Section 1's comment on that).

BEGIN;

-- ─── SECTION 1: PRE-APPLY GUARD (fail closed) ──────────────────────────────────
--
-- Refuses to proceed unless the live baseline is EXACTLY the confirmed-vulnerable state this
-- migration was written against. Also snapshots the untouched UPDATE/DELETE ownership policies
-- and the delete_history_completions() function definition into session temp tables, so Section
-- 4 can prove — not assume — that this migration left them byte-for-byte unchanged.

DO $$
DECLARE
  vulnerable_policy_count int;
  tombstone_anon_policy_count int;
  update_delete_policy_count int;
BEGIN
  -- 1a. The exact four vulnerable japam_history policies must all be present.
  SELECT count(*) INTO vulnerable_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'japam_history'
    AND policyname IN (
      'Allow public history select test',
      'Allow public history insert test',
      'allow_japam_history_select',
      'allow_japam_history_insert'
    );

  IF vulnerable_policy_count <> 4 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected exactly 4 vulnerable policies on public.japam_history, found %. '
      'Live baseline does not match what this migration was written against — refusing to apply. '
      'If this migration already ran successfully, this is expected (nothing left to fix).',
      vulnerable_policy_count;
  END IF;

  -- 1b. The exact deleted_completions anon policy must be present.
  SELECT count(*) INTO tombstone_anon_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'deleted_completions'
    AND policyname = 'anon manage deleted_completions';

  IF tombstone_anon_policy_count <> 1 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected exactly 1 "anon manage deleted_completions" policy on '
      'public.deleted_completions, found %. Refusing to apply.', tombstone_anon_policy_count;
  END IF;

  -- 1c. The two ownership policies this migration must NOT touch must already exist exactly
  -- once each, with the expected command/role — fail closed if they're missing or duplicated,
  -- rather than silently proceeding into an unknown state.
  SELECT count(*) INTO update_delete_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'japam_history'
    AND policyname IN ('Users can update their own history', 'Users can delete their own history');

  IF update_delete_policy_count <> 2 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected both "Users can update their own history" and "Users can delete '
      'their own history" on public.japam_history (found % of 2). Refusing to apply.',
      update_delete_policy_count;
  END IF;

  -- 1d. delete_history_completions(text[]) must exist and be SECURITY DEFINER (sanity check that
  -- the RPC this migration relies on for deleted_completions writes is actually the reviewed one).
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

-- Snapshot (session-scoped, dropped automatically at end of session) — captured BEFORE any
-- mutation below, compared again in Section 4.
CREATE TEMP TABLE _rls_hotfix_pre_snapshot AS
SELECT
  policyname,
  cmd,
  roles::text AS roles,
  qual::text AS using_expr,
  with_check::text AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'japam_history'
  AND policyname IN ('Users can update their own history', 'Users can delete their own history');

CREATE TEMP TABLE _rls_hotfix_pre_function_def AS
SELECT pg_get_functiondef('public.delete_history_completions(text[])'::regprocedure) AS def;


-- ─── SECTION 2: APPLY — public.japam_history ───────────────────────────────────
--
-- Removes the four vulnerable policies; adds authenticated-only, ownership-scoped SELECT and
-- INSERT. Does not touch "Users can update their own history" / "Users can delete their own
-- history" (verified unchanged in Section 4).

DROP POLICY IF EXISTS "Allow public history select test" ON public.japam_history;
DROP POLICY IF EXISTS "Allow public history insert test" ON public.japam_history;
DROP POLICY IF EXISTS "allow_japam_history_select" ON public.japam_history;
DROP POLICY IF EXISTS "allow_japam_history_insert" ON public.japam_history;

DROP POLICY IF EXISTS "authenticated_select_own_history" ON public.japam_history;
CREATE POLICY "authenticated_select_own_history"
  ON public.japam_history
  FOR SELECT
  TO authenticated
  USING (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );

DROP POLICY IF EXISTS "authenticated_insert_own_history" ON public.japam_history;
CREATE POLICY "authenticated_insert_own_history"
  ON public.japam_history
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.uid())::text = user_id
    OR ((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id
  );


-- ─── SECTION 3: APPLY — public.deleted_completions ─────────────────────────────
--
-- Removes unconditional anon access. Adds ONLY the authenticated SELECT the client tombstone
-- fetch needs (contexts/timer-context.tsx's TOMBSTONE_FETCH). No authenticated INSERT/UPDATE/
-- DELETE policy is added — legitimate writes go through delete_history_completions(text[]).

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


-- ─── SECTION 4: GRANTS ──────────────────────────────────────────────────────────
--
-- anon loses all table-level privileges on both tables (RLS is now the wrong place to rely on
-- for anon since there will be no anon policy left at all, but revoking the grants too is
-- defense in depth — an RLS policy bug can't leak data to a role with no grant regardless).
-- authenticated keeps SELECT/INSERT/UPDATE/DELETE (needed by the policies above and by the
-- pre-existing UPDATE/DELETE ownership policies) but loses the unused DDL-adjacent privileges.
-- service_role is untouched (SECURITY DEFINER RPCs and any backend tooling run as this role).

REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.japam_history FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.deleted_completions FROM anon;

REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.japam_history FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.deleted_completions FROM authenticated;


-- ─── SECTION 5: POST-APPLY GUARD (fail closed) ─────────────────────────────────

DO $$
DECLARE
  anon_policy_count int;
  anon_grant_count int;
  auth_select_count int;
  auth_insert_count int;
  auth_write_policy_count int;
  post_update_delete_count int;
  changed_ownership_policies int;
  pre_func_def text;
  post_func_def text;
BEGIN
  -- 5a. anon has zero policies left on either table.
  SELECT count(*) INTO anon_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('japam_history', 'deleted_completions')
    AND 'anon' = ANY(roles);

  IF anon_policy_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % polic(y/ies) on japam_history/deleted_completions.',
      anon_policy_count;
  END IF;

  -- 5b. anon has zero table-level grants left on either table.
  SELECT count(*) INTO anon_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('japam_history', 'deleted_completions')
    AND grantee = 'anon';

  IF anon_grant_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % grant(s) on japam_history/deleted_completions.',
      anon_grant_count;
  END IF;

  -- 5c. authenticated has exactly the new SELECT + INSERT ownership policies on japam_history.
  SELECT count(*) INTO auth_select_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japam_history'
    AND policyname = 'authenticated_select_own_history' AND cmd = 'SELECT'
    AND roles = ARRAY['authenticated']::name[];

  SELECT count(*) INTO auth_insert_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japam_history'
    AND policyname = 'authenticated_insert_own_history' AND cmd = 'INSERT'
    AND roles = ARRAY['authenticated']::name[];

  IF auth_select_count <> 1 OR auth_insert_count <> 1 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: expected new authenticated SELECT+INSERT ownership policies on '
      'japam_history (found select=%, insert=%).', auth_select_count, auth_insert_count;
  END IF;

  -- 5d. deleted_completions has exactly one authenticated SELECT policy and NO authenticated
  -- INSERT/UPDATE/DELETE policy (writes must only be possible via the SECURITY DEFINER RPC).
  SELECT count(*) INTO auth_write_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deleted_completions'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');

  IF auth_write_policy_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: deleted_completions has % direct write polic(y/ies) — none should '
      'exist; writes must go through delete_history_completions(text[]).',
      auth_write_policy_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'deleted_completions'
      AND policyname = 'authenticated_select_own_tombstones' AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: authenticated_select_own_tombstones SELECT policy missing on '
      'deleted_completions.';
  END IF;

  -- 5e. The pre-existing UPDATE/DELETE ownership policies on japam_history are byte-for-byte
  -- unchanged from the Section 1 snapshot (name, cmd, roles, USING, WITH CHECK all identical).
  SELECT count(*) INTO post_update_delete_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japam_history'
    AND policyname IN ('Users can update their own history', 'Users can delete their own history');

  IF post_update_delete_count <> 2 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: expected both UPDATE and DELETE ownership policies still present on '
      'japam_history (found %).', post_update_delete_count;
  END IF;

  SELECT count(*) INTO changed_ownership_policies
  FROM _rls_hotfix_pre_snapshot pre
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

  IF changed_ownership_policies <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: % pre-existing UPDATE/DELETE ownership polic(y/ies) on japam_history '
      'changed during this migration — this migration must not modify them.',
      changed_ownership_policies;
  END IF;

  -- 5f. delete_history_completions(text[]) definition is byte-for-byte unchanged.
  SELECT def INTO pre_func_def FROM _rls_hotfix_pre_function_def;
  SELECT pg_get_functiondef('public.delete_history_completions(text[])'::regprocedure)
    INTO post_func_def;

  IF pre_func_def IS DISTINCT FROM post_func_def THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: public.delete_history_completions(text[]) definition changed during '
      'this migration — it must be untouched.';
  END IF;

  -- 5g. service_role grants on both tables are untouched (still has every privilege).
  IF (
    SELECT count(DISTINCT privilege_type) FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'japam_history' AND grantee = 'service_role'
  ) < 4 OR (
    SELECT count(DISTINCT privilege_type) FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'deleted_completions' AND grantee = 'service_role'
  ) < 4 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: service_role privileges on japam_history/deleted_completions look '
      'reduced — this migration must not touch service_role.';
  END IF;
END $$;

DROP TABLE _rls_hotfix_pre_snapshot;
DROP TABLE _rls_hotfix_pre_function_def;

COMMIT;


-- ─── SECTION 6: ROLLBACK (post-commit only — NOT auto-run) ─────────────────────
--
-- The transaction above already fails closed: any guard mismatch aborts everything before
-- COMMIT, so there is nothing to undo for a guard failure. This section is only for the separate
-- case where the migration COMMITted successfully but a real problem is found afterward (e.g. a
-- legitimate client path was missed). Restores the exact pre-migration policies/grants. Run as
-- its own transaction, manually, only after confirming the problem.

-- BEGIN;
--
-- DROP POLICY IF EXISTS "authenticated_select_own_history" ON public.japam_history;
-- DROP POLICY IF EXISTS "authenticated_insert_own_history" ON public.japam_history;
--
-- CREATE POLICY "Allow public history select test" ON public.japam_history
--   FOR SELECT TO anon USING (true);
-- CREATE POLICY "Allow public history insert test" ON public.japam_history
--   FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "allow_japam_history_select" ON public.japam_history
--   FOR SELECT TO authenticated, anon USING (true);
-- CREATE POLICY "allow_japam_history_insert" ON public.japam_history
--   FOR INSERT TO authenticated, anon WITH CHECK (true);
--
-- DROP POLICY IF EXISTS "authenticated_select_own_tombstones" ON public.deleted_completions;
-- CREATE POLICY "anon manage deleted_completions" ON public.deleted_completions
--   TO anon USING (true) WITH CHECK (true);
--
-- GRANT ALL ON public.japam_history TO anon;
-- GRANT ALL ON public.deleted_completions TO anon;
-- GRANT ALL ON public.japam_history TO authenticated;
-- GRANT ALL ON public.deleted_completions TO authenticated;
--
-- COMMIT;

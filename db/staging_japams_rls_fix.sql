-- Staging-only RLS fix: public.japams ownership-scoped policies
--
-- Root cause: db/add_japam_workspaces.sql was never applied to staging
-- (nhacglvxdypevrbvvkhn). The japams table exists (likely from an earlier
-- partial application attempt) but has no RLS policies and no authenticated
-- grants. This causes all Japam sync operations (INSERT/SELECT/UPDATE/DELETE)
-- from the app to fail with "code: 42501, permission denied for table japams".
--
-- This migration brings staging in line with the Section 2c/2d design from
-- db/add_japam_workspaces.sql: authenticated-only, ownership-scoped policies
-- using auth.uid() (with the same JWT user_metadata.sub fallback as every
-- other table in this app). anon has zero policies and zero grants (defense
-- in depth). No anon-centric policies are ever created — this app's current
-- Japam sync code (lib/japamsRepository.ts) always carries a valid
-- authenticated session JWT via supabase.auth.getSession().
--
-- Scope: public.japams ONLY. Does not touch japam_history,
-- deleted_completions, or any other table.
--
-- Run in: Supabase SQL editor against STAGING (nhacglvxdypevrbvvkhn) ONLY.
-- Run ONCE per target. Safe to re-run: every statement is idempotent
-- (DROP POLICY IF EXISTS / DROP POLICY IF EXISTS before CREATE POLICY,
--  REVOKE / GRANT which are idempotent operations).
-- Never run against production (rftlqybgnbixotnpanec).

BEGIN;

-- ─── SECTION 1: PRE-APPLY VERIFICATION ──────────────────────────────────
--
-- Verify the table exists (if not, this isn't the right migration).
DO $$
DECLARE
  table_exists int;
BEGIN
  SELECT count(*) INTO table_exists
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'japams';

  IF table_exists = 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT FAILED: public.japams does not exist on this database. '
      'Apply db/add_japam_workspaces.sql first (Sections 2a-2d), then re-run '
      'this migration.';
  END IF;
END $$;

-- ─── SECTION 2: APPLY RLS POLICIES ──────────────────────────────────────

-- Ensure RLS is enabled.
ALTER TABLE public.japams ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policies (from partial/earlier attempts) to ensure
-- a clean state before creating the canonical set.
DROP POLICY IF EXISTS "allow_japams_insert" ON public.japams;
DROP POLICY IF EXISTS "allow_japams_select" ON public.japams;
DROP POLICY IF EXISTS "Users can update their own japams" ON public.japams;
DROP POLICY IF EXISTS "Users can delete their own japams" ON public.japams;
DROP POLICY IF EXISTS "Users can manage own japams" ON public.japams;
DROP POLICY IF EXISTS "authenticated_insert_own_japams" ON public.japams;
DROP POLICY IF EXISTS "authenticated_select_own_japams" ON public.japams;
DROP POLICY IF EXISTS "authenticated_update_own_japams" ON public.japams;
DROP POLICY IF EXISTS "authenticated_delete_own_japams" ON public.japams;

-- INSERT: authenticated users can only insert rows with their own user_id.
CREATE POLICY "authenticated_insert_own_japams"
  ON public.japams
  FOR insert
  TO authenticated
  WITH CHECK (
    (auth.uid()::text = user_id)
    OR ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

-- SELECT: authenticated users can only read their own rows.
CREATE POLICY "authenticated_select_own_japams"
  ON public.japams
  FOR select
  TO authenticated
  USING (
    (auth.uid()::text = user_id)
    OR ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

-- UPDATE: authenticated users can only update their own rows.
CREATE POLICY "authenticated_update_own_japams"
  ON public.japams
  FOR update
  TO authenticated
  USING (
    (auth.uid()::text = user_id)
    OR ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  )
  WITH CHECK (
    (auth.uid()::text = user_id)
    OR ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

-- DELETE: authenticated users can only delete their own rows.
CREATE POLICY "authenticated_delete_own_japams"
  ON public.japams
  FOR delete
  TO authenticated
  USING (
    (auth.uid()::text = user_id)
    OR ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

-- ─── SECTION 3: APPLY GRANTS ───────────────────────────────────────────

-- anon: zero table-level privileges (RLS already blocks anon with zero
-- policies, but a bare grant is still an unnecessary privilege — defense
-- in depth, consistent with all RLS hotfixes in this repo).
REVOKE ALL ON public.japams FROM anon;

-- authenticated: exactly the four operations the policies above cover.
REVOKE ALL ON public.japams FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.japams TO authenticated;

-- ─── SECTION 4: POST-APPLY VERIFICATION ─────────────────────────────────

DO $$
DECLARE
  policy_count int;
  anon_policy_count int;
  anon_grant_count int;
  auth_grant_count int;
BEGIN
  -- 4a. Exactly 4 policies on japams, all to authenticated only.
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japams';

  IF policy_count <> 4 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: expected 4 policies on public.japams, found %.',
      policy_count;
  END IF;

  -- 4b. Zero policies include anon.
  SELECT count(*) INTO anon_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'japams'
    AND 'anon' = ANY(roles);

  IF anon_policy_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % polic(y/ies) on japams.',
      anon_policy_count;
  END IF;

  -- 4c. anon has zero table-level grants.
  SELECT count(*) INTO anon_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'japams' AND grantee = 'anon';

  IF anon_grant_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % grant(s) on japams.', anon_grant_count;
  END IF;

  -- 4d. authenticated has exactly SELECT, INSERT, UPDATE, DELETE.
  SELECT count(DISTINCT privilege_type) INTO auth_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'japams' AND grantee = 'authenticated';

  IF auth_grant_count <> 4 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: authenticated has % grant type(s) on japams (expected 4).',
      auth_grant_count;
  END IF;
END $$;

COMMIT;

-- ─── SECTION 5: POST-COMMIT POLICY SUMMARY ─────────────────────────────

-- Run after COMMIT to confirm the final state:
SELECT
  policyname,
  cmd,
  roles,
  qual::text AS using_expr,
  with_check::text AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'japams'
ORDER BY cmd, policyname;

-- Expected output (4 rows):
--   authenticated_insert_own_japams  | INSERT | {authenticated} | | (auth.uid()::text = user_id) OR ...
--   authenticated_select_own_japams  | SELECT | {authenticated} | (auth.uid()::text = user_id) OR ... |
--   authenticated_update_own_japams  | UPDATE | {authenticated} | (auth.uid()::text = user_id) OR ... | same
--   authenticated_delete_own_japams  | DELETE | {authenticated} | (auth.uid()::text = user_id) OR ... |

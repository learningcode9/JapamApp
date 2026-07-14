/**
 * Static content tests for db/rls_hotfix_japam_history_deleted_completions.sql.
 *
 * This migration is NOT executed anywhere yet (no staging, no production) — see the file's own
 * "DO NOT RUN until explicitly approved" header. There is no live database to test against in
 * CI, so — mirroring lib/__tests__/anonKeyRestAuth.test.ts's approach for the client-side half of
 * this same RLS hotfix — these are source-text assertions over the SQL file itself: they prove
 * the migration's *shape* (what it drops, what it creates, what it deliberately leaves alone,
 * that it's guarded and transactional) without requiring a database connection.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  'db',
  'rls_hotfix_japam_history_deleted_completions.sql'
);

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

const OWNERSHIP_EXPR_FRAGMENTS = [
  `(auth.uid())::text = user_id`,
  `((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id`,
];

describe('rls_hotfix_japam_history_deleted_completions.sql', () => {
  it('has not been marked as run (still says DO NOT RUN)', () => {
    expect(sql).toMatch(/DO NOT RUN until explicitly approved/);
  });

  it('is wrapped in exactly one transaction (BEGIN ... COMMIT)', () => {
    const beginCount = (sql.match(/^BEGIN;/gm) || []).length;
    const commitCount = (sql.match(/^COMMIT;/gm) || []).length;
    // The rollback section's own commented-out BEGIN/COMMIT must not count — those lines are
    // prefixed with "-- " in the file and so won't match the anchored, uncommented patterns above.
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
  });

  it('is guarded: contains pre-apply and post-apply RAISE EXCEPTION checks', () => {
    const raiseCount = (sql.match(/RAISE EXCEPTION/g) || []).length;
    expect(raiseCount).toBeGreaterThanOrEqual(6);
    expect(sql).toMatch(/PRE-APPLY GUARD/);
    expect(sql).toMatch(/POST-APPLY GUARD/);
    expect(sql).toMatch(/GUARD FAILED/);
    expect(sql).toMatch(/POST-VERIFY FAILED/);
  });

  describe('anon access removal', () => {
    it('drops all four vulnerable japam_history test/broad policies', () => {
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS "Allow public history select test" ON public\.japam_history/
      );
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS "Allow public history insert test" ON public\.japam_history/
      );
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS "allow_japam_history_select" ON public\.japam_history/
      );
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS "allow_japam_history_insert" ON public\.japam_history/
      );
    });

    it('drops the anon deleted_completions policy', () => {
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS "anon manage deleted_completions" ON public\.deleted_completions/
      );
    });

    it('revokes every table privilege from anon on both tables', () => {
      const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
      const revokeAnonJapamHistory = sql.match(
        /REVOKE ([\s\S]*?)\n\s*ON public\.japam_history FROM anon;/
      );
      const revokeAnonDeletedCompletions = sql.match(
        /REVOKE ([\s\S]*?)\n\s*ON public\.deleted_completions FROM anon;/
      );
      expect(revokeAnonJapamHistory).not.toBeNull();
      expect(revokeAnonDeletedCompletions).not.toBeNull();
      for (const priv of privileges) {
        expect(revokeAnonJapamHistory![1]).toContain(priv);
        expect(revokeAnonDeletedCompletions![1]).toContain(priv);
      }
    });

    it('post-verify guard asserts zero anon policies and zero anon grants remain', () => {
      expect(sql).toMatch(/anon still has % polic\(y\/ies\)/);
      expect(sql).toMatch(/anon still has % grant\(s\)/);
    });
  });

  describe('authenticated ownership-scoped policies', () => {
    it('creates an authenticated-only SELECT policy on japam_history with the ownership expression', () => {
      const match = sql.match(
        /CREATE POLICY "authenticated_select_own_history"\s+ON public\.japam_history\s+FOR SELECT\s+TO authenticated\s+USING \(([\s\S]*?)\);/
      );
      expect(match).not.toBeNull();
      for (const fragment of OWNERSHIP_EXPR_FRAGMENTS) {
        expect(match![1]).toContain(fragment);
      }
    });

    it('creates an authenticated-only INSERT policy on japam_history with the same ownership expression as WITH CHECK', () => {
      const match = sql.match(
        /CREATE POLICY "authenticated_insert_own_history"\s+ON public\.japam_history\s+FOR INSERT\s+TO authenticated\s+WITH CHECK \(([\s\S]*?)\);/
      );
      expect(match).not.toBeNull();
      for (const fragment of OWNERSHIP_EXPR_FRAGMENTS) {
        expect(match![1]).toContain(fragment);
      }
    });

    it('creates an authenticated-only SELECT policy on deleted_completions with the ownership expression', () => {
      const match = sql.match(
        /CREATE POLICY "authenticated_select_own_tombstones"\s+ON public\.deleted_completions\s+FOR SELECT\s+TO authenticated\s+USING \(([\s\S]*?)\);/
      );
      expect(match).not.toBeNull();
      for (const fragment of OWNERSHIP_EXPR_FRAGMENTS) {
        expect(match![1]).toContain(fragment);
      }
    });
  });

  describe('no direct tombstone write policy', () => {
    it('never creates an INSERT/UPDATE/DELETE policy on deleted_completions', () => {
      // Each CREATE POLICY statement, scoped individually (stops at its own semicolon so one
      // statement's match can never swallow a later, unrelated statement).
      const createPolicyBlocks = sql.match(/CREATE POLICY[^;]*?;/g) || [];
      const deletedCompletionsBlocks = createPolicyBlocks.filter((b) => b.includes('deleted_completions'));
      expect(deletedCompletionsBlocks.length).toBeGreaterThan(0);
      for (const block of deletedCompletionsBlocks) {
        expect(block).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/);
      }
    });

    it('documents that writes go through the SECURITY DEFINER RPC, not a direct policy', () => {
      expect(sql).toMatch(/delete_history_completions\(text\[\]\)/);
      expect(sql).toMatch(/SECURITY DEFINER/);
    });

    it('post-verify guard asserts zero write policies exist on deleted_completions', () => {
      expect(sql).toMatch(
        /cmd IN \('INSERT', 'UPDATE', 'DELETE'\)/
      );
      expect(sql).toMatch(/direct write polic\(y\/ies\)/);
    });
  });

  describe('preserved / untouched objects', () => {
    it('never drops or recreates the UPDATE/DELETE ownership policies on japam_history', () => {
      expect(sql).not.toMatch(
        /DROP POLICY[^\n]*"Users can update their own history"/
      );
      expect(sql).not.toMatch(
        /DROP POLICY[^\n]*"Users can delete their own history"/
      );
      // The rollback section (commented out, not executed) is allowed to reference recreating the
      // OLD vulnerable policies it replaces, but must never mention touching these two by name.
      expect(sql).not.toMatch(/CREATE POLICY "Users can update their own history"/);
      expect(sql).not.toMatch(/CREATE POLICY "Users can delete their own history"/);
    });

    it('snapshots and compares the UPDATE/DELETE ownership policies before vs. after', () => {
      expect(sql).toMatch(/_rls_hotfix_pre_snapshot/);
      expect(sql).toMatch(/changed_ownership_policies/);
    });

    it('snapshots and compares delete_history_completions() definition before vs. after', () => {
      expect(sql).toMatch(/_rls_hotfix_pre_function_def/);
      expect(sql).toMatch(/pg_get_functiondef\('public\.delete_history_completions\(text\[\]\)'::regprocedure\)/);
      expect(sql).toMatch(/pre_func_def IS DISTINCT FROM post_func_def/);
    });

    it('never modifies any function definition (no CREATE OR REPLACE FUNCTION / DROP FUNCTION anywhere)', () => {
      expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
      expect(sql).not.toMatch(/DROP FUNCTION/);
    });

    it('never mentions any table other than japam_history and deleted_completions', () => {
      const tableRefs = sql.match(/public\.[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
      const allowedTables = new Set(['public.japam_history', 'public.deleted_completions']);
      const allowedNonTableRefs = new Set(['public.delete_history_completions']);
      for (const ref of tableRefs) {
        const isAllowedTable = allowedTables.has(ref);
        const isAllowedFunctionRef = [...allowedNonTableRefs].some((f) => ref.startsWith(f));
        expect(isAllowedTable || isAllowedFunctionRef).toBe(true);
      }
    });

    it('leaves service_role untouched — no GRANT/REVOKE statement targets it', () => {
      // Each GRANT/REVOKE statement, scoped individually (stops at its own semicolon). Word
      // boundaries avoid matching "GRANTS" in the section-header comment.
      const grantRevokeStatements = sql.match(/\b(GRANT|REVOKE)\b[^;]*?;/g) || [];
      expect(grantRevokeStatements.length).toBeGreaterThan(0);
      for (const statement of grantRevokeStatements) {
        expect(statement).not.toMatch(/service_role/);
      }
    });

    it('post-verify guard explicitly asserts service_role privileges are unreduced', () => {
      expect(sql).toMatch(/service_role/);
      expect(sql).toMatch(/service_role privileges[\s\S]*?look/);
    });
  });

  describe('idempotency / re-run safety', () => {
    it('every CREATE POLICY is preceded by its own DROP POLICY IF EXISTS', () => {
      const createdPolicyNames = [...sql.matchAll(/CREATE POLICY "([^"]+)"/g)].map((m) => m[1]);
      expect(createdPolicyNames.length).toBeGreaterThan(0);
      for (const name of createdPolicyNames) {
        const dropPattern = new RegExp(`DROP POLICY IF EXISTS "${name}"`);
        expect(sql).toMatch(dropPattern);
      }
    });

    it('every DROP POLICY (outside the commented-out rollback section) uses IF EXISTS', () => {
      const activeSql = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      const bareDrops = activeSql.match(/DROP POLICY(?! IF EXISTS)/g) || [];
      expect(bareDrops).toHaveLength(0);
    });
  });
});

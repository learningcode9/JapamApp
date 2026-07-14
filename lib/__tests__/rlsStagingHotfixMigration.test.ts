/**
 * Static content tests for db/rls_staging_hotfix_deleted_completions.sql.
 *
 * Not executed anywhere yet (no staging, no production) — see the file's own "DO NOT RUN until
 * explicitly approved" header. No live database in CI, so — mirroring
 * lib/__tests__/rlsHotfixMigration.test.ts's approach for the broader production migration —
 * these are source-text assertions over the SQL file itself.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'db', 'rls_staging_hotfix_deleted_completions.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

const OWNERSHIP_EXPR_FRAGMENTS = [
  `(auth.uid())::text = user_id`,
  `((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text) = user_id`,
];

describe('rls_staging_hotfix_deleted_completions.sql', () => {
  it('has not been marked as run (still says DO NOT RUN)', () => {
    expect(sql).toMatch(/DO NOT RUN until explicitly approved/);
  });

  it('is scoped to staging only and warns against production', () => {
    expect(sql).toMatch(/nhacglvxdypevrbvvkhn/);
    expect(sql).toMatch(/STAGING/);
    expect(sql).toMatch(/Never run against production/);
  });

  it('is wrapped in exactly one transaction (BEGIN ... COMMIT)', () => {
    const beginCount = (sql.match(/^BEGIN;/gm) || []).length;
    const commitCount = (sql.match(/^COMMIT;/gm) || []).length;
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
  });

  it('is guarded: contains pre-apply and post-apply RAISE EXCEPTION checks', () => {
    const raiseCount = (sql.match(/RAISE EXCEPTION/g) || []).length;
    expect(raiseCount).toBeGreaterThanOrEqual(5);
    expect(sql).toMatch(/PRE-APPLY GUARD/);
    expect(sql).toMatch(/POST-APPLY GUARD/);
    expect(sql).toMatch(/GUARD FAILED/);
    expect(sql).toMatch(/POST-VERIFY FAILED/);
  });

  describe('deleted_completions changes', () => {
    it('drops the anon policy', () => {
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS "anon manage deleted_completions" ON public\.deleted_completions/
      );
    });

    it('creates an authenticated-only SELECT policy with the ownership expression', () => {
      const match = sql.match(
        /CREATE POLICY "authenticated_select_own_tombstones"\s+ON public\.deleted_completions\s+FOR SELECT\s+TO authenticated\s+USING \(([\s\S]*?)\);/
      );
      expect(match).not.toBeNull();
      for (const fragment of OWNERSHIP_EXPR_FRAGMENTS) {
        expect(match![1]).toContain(fragment);
      }
    });

    it('never creates an INSERT/UPDATE/DELETE policy on deleted_completions', () => {
      const createPolicyBlocks = sql.match(/CREATE POLICY[^;]*?;/g) || [];
      const deletedCompletionsBlocks = createPolicyBlocks.filter((b) => b.includes('deleted_completions'));
      expect(deletedCompletionsBlocks.length).toBeGreaterThan(0);
      for (const block of deletedCompletionsBlocks) {
        expect(block).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/);
      }
    });

    it('revokes every table privilege from anon on deleted_completions', () => {
      const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
      const revokeAnon = sql.match(/REVOKE ([\s\S]*?)\n\s*ON public\.deleted_completions FROM anon;/);
      expect(revokeAnon).not.toBeNull();
      for (const priv of privileges) {
        expect(revokeAnon![1]).toContain(priv);
      }
    });

    it('documents that writes go through the SECURITY DEFINER RPC, not a direct policy', () => {
      expect(sql).toMatch(/delete_history_completions\(text\[\]\)/);
      expect(sql).toMatch(/SECURITY DEFINER/);
    });
  });

  describe('japam_history is never touched', () => {
    it('contains no DROP POLICY, CREATE POLICY, GRANT, or REVOKE statement referencing japam_history', () => {
      const mutatingStatements = sql.match(/\b(DROP POLICY|CREATE POLICY|GRANT|REVOKE)\b[^;]*?;/g) || [];
      for (const statement of mutatingStatements) {
        expect(statement).not.toMatch(/japam_history/);
      }
    });

    it('guards that japam_history already has zero anon-role policies before proceeding', () => {
      expect(sql).toMatch(/japam_history_anon_policy_count/);
      expect(sql).toMatch(/already authenticated-only/);
    });

    it('snapshots and compares japam_history\'s full policy set before vs. after', () => {
      expect(sql).toMatch(/_rls_staging_hotfix_japam_history_pre/);
      expect(sql).toMatch(/changed_japam_history_policies/);
    });
  });

  describe('preserved objects', () => {
    it('snapshots and compares delete_history_completions() definition before vs. after', () => {
      expect(sql).toMatch(/_rls_staging_hotfix_pre_function_def/);
      expect(sql).toMatch(
        /pg_get_functiondef\('public\.delete_history_completions\(text\[\]\)'::regprocedure\)/
      );
      expect(sql).toMatch(/pre_func_def IS DISTINCT FROM post_func_def/);
    });

    it('never modifies any function definition (no CREATE OR REPLACE FUNCTION / DROP FUNCTION anywhere)', () => {
      expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
      expect(sql).not.toMatch(/DROP FUNCTION/);
    });

    it('never mentions any table other than deleted_completions (plus read-only refs to japam_history/the RPC for guarding)', () => {
      const tableRefs = sql.match(/public\.[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
      const allowed = ['public.deleted_completions', 'public.japam_history', 'public.delete_history_completions'];
      for (const ref of tableRefs) {
        expect(allowed.some((a) => ref.startsWith(a))).toBe(true);
      }
    });

    it('leaves service_role untouched — no GRANT/REVOKE statement targets it', () => {
      const grantRevokeStatements = sql.match(/\b(GRANT|REVOKE)\b[^;]*?;/g) || [];
      expect(grantRevokeStatements.length).toBeGreaterThan(0);
      for (const statement of grantRevokeStatements) {
        expect(statement).not.toMatch(/service_role/);
      }
    });

    it('post-verify guard explicitly asserts service_role privileges are unreduced', () => {
      expect(sql).toMatch(/service_role privileges[\s\S]*?look/);
    });
  });

  describe('idempotency / re-run safety', () => {
    it('every CREATE POLICY is preceded by its own DROP POLICY IF EXISTS', () => {
      const createdPolicyNames = [...sql.matchAll(/CREATE POLICY "([^"]+)"/g)].map((m) => m[1]);
      expect(createdPolicyNames.length).toBeGreaterThan(0);
      for (const name of createdPolicyNames) {
        expect(sql).toMatch(new RegExp(`DROP POLICY IF EXISTS "${name}"`));
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

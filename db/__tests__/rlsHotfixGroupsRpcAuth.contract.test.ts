/**
 * Contract test for db/rls_hotfix_groups_rpc_auth.sql (F14).
 *
 * This is a static structural check of the SQL FILE itself, not a database test -- it never
 * connects to or executes anything against a database. It exists so a future edit to this
 * migration (or a copy/paste mistake while adding a 9th RPC, or a rebase conflict) is caught by
 * `npm test` before anyone runs the file by hand, the same discipline
 * lib/__tests__/anonKeyRestAuth.test.ts already applies to the client-side half of these RLS
 * hotfixes.
 *
 * What it guards, mirroring the migration's own Section 1/4/5 in-SQL guards:
 *   - the file is one balanced transaction (single BEGIN/COMMIT, matched DO $$ blocks, balanced parens)
 *   - all 8 target RPCs are present exactly once in the APPLY section
 *   - every one of the 8 function bodies calls the identity-derivation helper (never trusts a
 *     legacy p_*_user_id parameter as the caller's own identity)
 *   - the two helper functions are defined
 *   - anon EXECUTE is revoked for all 8 functions, and no GRANT ... TO anon is (re)introduced
 *     anywhere in the apply section
 *   - a rollback section exists and mentions all 8 function names, so a real incident has a
 *     documented way back
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'rls_hotfix_groups_rpc_auth.sql');

const TARGET_RPCS = [
  'get_my_groups',
  'get_group_dashboard',
  'get_group_invite_code',
  'create_group',
  'rename_group',
  'remove_group_member',
  'leave_group',
  'delete_group',
];

const HELPER_FUNCTIONS = ['_groups_require_caller_id', '_groups_legacy_sub'];

/** Strips SQL line comments (`-- ...`) so counts below aren't inflated by prose that happens to
 * mention a function name or keyword (e.g. this test file's own docstring style used in the SQL
 * file's header, or the rollback section's commented-out CREATE statements). */
const stripSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('db/rls_hotfix_groups_rpc_auth.sql structural contract', () => {
  const raw = fs.readFileSync(SQL_PATH, 'utf8');
  const active = stripSqlComments(raw); // excludes the commented-out rollback section too

  it('is exactly one transaction with balanced DO blocks and parens', () => {
    const beginCount = (active.match(/^BEGIN;/gm) || []).length;
    const commitCount = (active.match(/^COMMIT;/gm) || []).length;
    const doOpenCount = (active.match(/^DO \$\$/gm) || []).length;
    const doCloseCount = (active.match(/^END \$\$;/gm) || []).length;
    const openParens = (active.match(/\(/g) || []).length;
    const closeParens = (active.match(/\)/g) || []).length;

    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
    expect(doOpenCount).toBe(2); // pre-apply guard + post-apply guard
    expect(doCloseCount).toBe(2);
    expect(openParens).toBe(closeParens);
  });

  it.each(TARGET_RPCS)(
    '%s has exactly one active CREATE OR REPLACE FUNCTION',
    (rpcName) => {
      const pattern = new RegExp(
        `^CREATE OR REPLACE FUNCTION public\\.${rpcName}\\(`,
        'gm'
      );
      const matches = active.match(pattern) || [];
      expect(matches).toHaveLength(1);
    }
  );

  it.each(TARGET_RPCS)(
    '%s\'s new body calls the identity-derivation helper, not a raw p_*_user_id parameter',
    (rpcName) => {
      const startPattern = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${rpcName}\\(`
      );
      const startIdx = active.search(startPattern);
      expect(startIdx).toBeGreaterThan(-1);

      // '$function$;' (with the trailing semicolon) is the unique closing marker for a function
      // body -- the opening tag is '$function$' followed by a newline, never a semicolon.
      const endIdx = active.indexOf('$function$;', startIdx);
      expect(endIdx).toBeGreaterThan(startIdx);

      const body = active.slice(startIdx, endIdx);
      expect(body).toContain('_groups_require_caller_id()');
    }
  );

  it.each(HELPER_FUNCTIONS)('helper function %s is defined', (helperName) => {
    const pattern = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${helperName}\\(`);
    expect(active).toMatch(pattern);
  });

  it('helper _groups_require_caller_id rejects a null auth.uid()', () => {
    const startIdx = active.search(/CREATE OR REPLACE FUNCTION public\._groups_require_caller_id\(/);
    const endIdx = active.indexOf('$function$;', startIdx);
    const body = active.slice(startIdx, endIdx);
    expect(body).toMatch(/auth\.uid\(\)/);
    expect(body).toMatch(/is null/i);
    expect(body).toMatch(/raise exception/i);
  });

  it.each(TARGET_RPCS)('%s has an active REVOKE of anon EXECUTE', (rpcName) => {
    const pattern = new RegExp(
      `REVOKE EXECUTE ON FUNCTION public\\.${rpcName}\\([^)]*\\) FROM anon;`
    );
    expect(active).toMatch(pattern);
  });

  it('no active statement re-grants anon EXECUTE on any target RPC', () => {
    // The only "GRANT ... TO anon" text allowed anywhere in the file is inside the commented-out
    // rollback section (already excluded by stripSqlComments), which exists specifically to
    // restore anon access during an incident, not to run by default.
    expect(active).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO anon/i);
  });

  it('authenticated is never revoked on any target RPC in the active apply section', () => {
    for (const rpcName of TARGET_RPCS) {
      const pattern = new RegExp(
        `REVOKE EXECUTE ON FUNCTION public\\.${rpcName}\\([^)]*\\) FROM authenticated;`
      );
      expect(active).not.toMatch(pattern);
    }
  });

  it('a rollback section exists and mentions every target RPC', () => {
    expect(raw).toMatch(/SECTION 6: ROLLBACK/);
    const rollbackStart = raw.indexOf('SECTION 6: ROLLBACK');
    const rollbackSection = raw.slice(rollbackStart);
    for (const rpcName of TARGET_RPCS) {
      expect(rollbackSection).toContain(`public.${rpcName}(`);
    }
  });

  it('pre-apply guard checks for the confirmed-vulnerable anon-grant baseline', () => {
    expect(active).toMatch(/GUARD FAILED/);
    expect(active).toMatch(/anon_grant_count/);
  });

  it('post-apply guard verifies zero anon grants remain', () => {
    expect(active).toMatch(/POST-VERIFY FAILED/);
    expect(active).toMatch(/anon_grant_count <> 0/);
  });
});

/**
 * Contract test for db/add_japam_workspaces.sql's RLS on public.japams.
 *
 * This is a static structural check of the SQL FILE itself, not a database test -- it never
 * connects to or executes anything against a database. It exists so a future edit to this
 * migration (a rebase conflict, a copy/paste mistake while adding a new policy, or someone
 * "simplifying" access back to `USING (true)` to unblock a debugging session) is caught by
 * `npm test` before anyone runs the file by hand -- the same discipline
 * lib/__tests__/anonKeyRestAuth.test.ts and lib/__tests__/rlsHotfixMigration.test.ts already
 * apply to the client-side and japam_history halves of the F15/F7 remediations.
 *
 * public.japams was hardened to close the exact vulnerability class F15 (japam_history /
 * deleted_completions), F7 (japam_user_totals / japam_timer_state), and F14 (Groups RPCs) all
 * eliminated: anon-open access and/or missing ownership checks. This test guards that fix.
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'add_japam_workspaces.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

const OWNERSHIP_EXPR_FRAGMENTS = [
  `(auth.uid()::text = user_id)`,
  `((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)`,
];

const POLICY_NAMES = {
  select: 'authenticated_select_own_japams',
  insert: 'authenticated_insert_own_japams',
  update: 'authenticated_update_own_japams',
  delete: 'authenticated_delete_own_japams',
};

describe('db/add_japam_workspaces.sql RLS contract for public.japams', () => {
  it('enables row level security on public.japams', () => {
    expect(sql).toMatch(/alter table public\.japams enable row level security;/);
  });

  it('never grants any policy on japams to anon', () => {
    // Every CREATE POLICY statement on japams, scoped individually (stops at its own semicolon)
    // so one statement's match can never swallow a later, unrelated statement.
    const createPolicyBlocks = sql.match(/create policy[^;]*?;/g) || [];
    const japamsPolicyBlocks = createPolicyBlocks.filter((b) => /on\s+public\.japams/.test(b));
    expect(japamsPolicyBlocks.length).toBe(4);
    for (const block of japamsPolicyBlocks) {
      expect(block).not.toMatch(/\banon\b/);
      expect(block).toMatch(/to authenticated/);
    }
  });

  it('never uses an unconditional USING (true) / WITH CHECK (true) on any japams policy', () => {
    const createPolicyBlocks = sql.match(/create policy[^;]*?;/g) || [];
    const japamsPolicyBlocks = createPolicyBlocks.filter((b) => /on\s+public\.japams/.test(b));
    expect(japamsPolicyBlocks.length).toBeGreaterThan(0);
    for (const block of japamsPolicyBlocks) {
      expect(block).not.toMatch(/using\s*\(\s*true\s*\)/i);
      expect(block).not.toMatch(/with check\s*\(\s*true\s*\)/i);
    }
  });

  describe.each(Object.entries(POLICY_NAMES))('%s policy (%s)', (_cmd, policyName) => {
    it(`${policyName} exists, is dropped-before-created (idempotent), and is authenticated-only`, () => {
      expect(sql).toMatch(new RegExp(`drop policy if exists "${policyName}" on public\\.japams;`));
      const createPattern = new RegExp(
        `create policy "${policyName}"\\s+on public\\.japams\\s+for \\w+\\s+to authenticated\\b`
      );
      expect(sql).toMatch(createPattern);
    });

    it(`${policyName}'s ownership expression matches the F15/F7/F14 auth.uid() + legacy-sub pattern`, () => {
      const startIdx = sql.indexOf(`create policy "${policyName}"`);
      expect(startIdx).toBeGreaterThan(-1);
      const endIdx = sql.indexOf(';', startIdx);
      expect(endIdx).toBeGreaterThan(startIdx);
      const block = sql.slice(startIdx, endIdx);
      for (const fragment of OWNERSHIP_EXPR_FRAGMENTS) {
        expect(block).toContain(fragment);
      }
    });
  });

  it('revokes all anon access to japams and never re-grants it', () => {
    expect(sql).toMatch(/revoke all on public\.japams from anon;/);

    // No GRANT statement anywhere in the file may target anon on japams.
    const grantStatements = sql.match(/\bgrant\b[^;]*?;/gi) || [];
    for (const statement of grantStatements) {
      if (/on public\.japams/i.test(statement)) {
        expect(statement).not.toMatch(/\banon\b/i);
      }
    }
  });

  it('scopes authenticated to exactly select/insert/update/delete on japams (no truncate/references/trigger)', () => {
    expect(sql).toMatch(
      /grant select, insert, update, delete on public\.japams to authenticated;/
    );
    expect(sql).not.toMatch(/grant all on public\.japams to authenticated/i);
  });

  it('post-apply verification queries assert anon has zero policies and zero grants on japams', () => {
    expect(sql).toMatch(/and\s+'anon'\s*=\s*any\(roles\);/);
    expect(sql).toMatch(/grantee = 'anon';/);
  });

  it('leaves service_role/postgres untouched -- no REVOKE/GRANT statement on japams targets them', () => {
    const grantRevokeStatements = sql.match(/\b(grant|revoke)\b[^;]*?on public\.japams[^;]*?;/gi) || [];
    expect(grantRevokeStatements.length).toBeGreaterThan(0);
    for (const statement of grantRevokeStatements) {
      expect(statement).not.toMatch(/service_role/i);
      expect(statement).not.toMatch(/\bpostgres\b/i);
    }
  });

  it('the japams table itself is owned by postgres, matching the rest of this schema', () => {
    expect(sql).toMatch(/alter table public\.japams owner to postgres;/);
  });

  it('defines no SECURITY DEFINER function and no trigger on japams (plain RLS-only table)', () => {
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).not.toMatch(/create trigger/i);
  });
});

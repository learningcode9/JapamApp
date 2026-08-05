/**
 * Contract test for db/groups_workspace_isolation.sql (Issue 3).
 *
 * This is a static structural check of the SQL FILE itself, not a database test -- it never
 * connects to or executes anything against a database. It exists so a future edit to this
 * migration (a rebase conflict, a copy/paste mistake while adding an 11th RPC, someone
 * "simplifying" the backfill into a first-Japam/name-based heuristic, or an accidental
 * grant-to-anon) is caught by `npm test` before anyone runs the file by hand -- the same
 * discipline db/__tests__/rlsHotfixGroupsRpcAuth.contract.test.ts applies to the F14 hotfix
 * and db/__tests__/addJapamWorkspacesMigration.contract.test.ts applies to japams RLS.
 *
 * What it guards (mirroring the migration's own in-SQL section comments):
 *   - the file is one balanced script (balanced parens; no DO blocks)
 *   - the authoritative workspace link is group_members.japam_id with `on delete set null`
 *     (never groups.japam_id, never cascade delete)
 *   - both workspace indexes are created; the existing unique (group_id, user_id) constraint is
 *     preserved untouched (nothing drops it)
 *   - the two helpers are defined and fully revoked from PUBLIC/anon/authenticated
 *   - the backfill is conservative: joins only the member's own active Japams, binds only when
 *     exactly one exists (having count = 1), never infers from name/history, never touches a
 *     membership that is already assigned, and returns the required report columns
 *   - all 10 RPC signatures exist exactly once (6 authoritative + 4 legacy wrappers)
 *   - every authoritative RPC body derives the caller identity from auth.uid() via
 *     _groups_require_caller_id(); create/join legacy wrappers auto-bind via
 *     _groups_sole_active_japam_id(); legacy get_my_groups and dashboard wrappers resolve from the
 *     caller's own memberships and only use the sole-active fallback when needed
 *   - the dashboard aggregates per-member by h.user_id = gm.user_id AND h.japam_id = gm.japam_id,
 *     ignores unassigned memberships, never counts null-japam_id legacy history, and never sums by
 *     user_id alone
 *   - anon is never granted EXECUTE anywhere in the active apply section; authenticated and
 *     service_role are explicitly granted for every signature
 *   - a rollback section exists and names every drop this migration added
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'groups_workspace_isolation.sql');

const AUTHORITATIVE_RPCS = [
  ['create_group', ['text', 'text', 'text', 'uuid']],
  ['join_group_by_invite_code', ['text', 'text', 'uuid']],
  ['get_my_groups', ['text', 'uuid']],
  ['get_my_unassigned_groups', []],
  ['attach_group_membership_to_japam', ['uuid', 'uuid']],
  ['get_group_dashboard', ['uuid', 'text', 'timestamptz', 'timestamptz', 'uuid']],
] as const;

const LEGACY_SOLE_BIND_WRAPPER_RPCS = [
  ['create_group', ['text', 'text', 'text']],
  ['join_group_by_invite_code', ['text', 'text']],
] as const;

const LEGACY_MEMBERSHIP_WRAPPER_RPCS = [
  ['get_my_groups', ['text']],
  ['get_group_dashboard', ['uuid', 'text', 'timestamptz', 'timestamptz']],
] as const;

const ALL_LEGACY_RPCS = [...LEGACY_SOLE_BIND_WRAPPER_RPCS, ...LEGACY_MEMBERSHIP_WRAPPER_RPCS] as const;
const ALL_RPCS = [...AUTHORITATIVE_RPCS, ...ALL_LEGACY_RPCS] as const;

const HELPER_FUNCTIONS = ['_groups_sole_active_japam_id', '_groups_backfill_unassigned_memberships'];

/** Strips SQL line comments so counts below aren't inflated by the commented-out rollback
 *  section or prose that happens to mention a function name. */
const stripSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/** Extracts every `CREATE OR REPLACE FUNCTION public.<name>(` header (the text from the CREATE
 *  keyword up to its `returns` clause — i.e. the declaration of the parameter list). Each
 *  overload of a name yields one header. */
function functionHeaders(sql: string, rpcName: string): string[] {
  const headers: string[] = [];
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpcName}\\(`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const end = sql.indexOf('returns ', m.index);
    expect(end).toBeGreaterThan(m.index);
    headers.push(sql.slice(m.index, end));
  }
  return headers;
}

/** The type tokens in a function header, in declaration order — e.g. (text, text, uuid). */
const headerTypeTokens = (header: string): string[] =>
  (header.match(/\b(text|uuid|timestamptz|boolean|bigint|integer)\b/g) || []);

/** The full definition (header + SECURITY DEFINER body up to the closing `$$;`) of the ONE
 *  overload whose parameter list matches the expected type sequence. */
function functionBody(sql: string, rpcName: string, expectedTypes: readonly string[]): string {
  const header = functionHeaders(sql, rpcName).find(
    (h) => JSON.stringify(headerTypeTokens(h)) === JSON.stringify(expectedTypes)
  );
  expect(header).toBeDefined();
  const startIdx = sql.indexOf(header as string);
  expect(startIdx).toBeGreaterThan(-1);
  // Each body opens with `as $$` and closes with a line containing exactly `$$;`.
  const openIdx = sql.indexOf('as $$', startIdx);
  expect(openIdx).toBeGreaterThan(startIdx);
  const endIdx = sql.indexOf('\n$$;', openIdx);
  expect(endIdx).toBeGreaterThan(openIdx);
  return sql.slice(startIdx, endIdx);
}

describe('db/groups_workspace_isolation.sql structural contract', () => {
  const raw = fs.readFileSync(SQL_PATH, 'utf8');
  const active = stripSqlComments(raw);

  it('is one balanced script with no DO blocks', () => {
    expect(active.match(/^BEGIN;/gm) || []).toHaveLength(0);
    expect(active.match(/^COMMIT;/gm) || []).toHaveLength(0);
    expect(active.match(/^DO \$\$/gm) || []).toHaveLength(0);
    const openParens = (active.match(/\(/g) || []).length;
    const closeParens = (active.match(/\)/g) || []).length;
    expect(openParens).toBe(closeParens);
  });

  describe('schema', () => {
    it('adds group_members.japam_id as a nullable FK to japams with ON DELETE SET NULL', () => {
      expect(active).toMatch(
        /add column if not exists japam_id uuid references public\.japams\(id\) on delete set null;/
      );
    });

    it('never adds a japam_id column to groups (the link is per-membership, not per-group)', () => {
      expect(active).not.toMatch(/alter table public\.groups\s+add column/i);
    });

    it('creates both workspace indexes', () => {
      expect(active).toMatch(
        /create index if not exists group_members_user_id_japam_id_idx\s+on public\.group_members \(user_id, japam_id\);/
      );
      expect(active).toMatch(
        /create index if not exists group_members_group_id_japam_id_idx\s+on public\.group_members \(group_id, japam_id\);/
      );
    });

    it('never drops the unique (group_id, user_id) constraint or the tables', () => {
      expect(active).not.toMatch(/drop constraint/i);
      expect(active).not.toMatch(/drop table/i);
      expect(active).not.toMatch(/drop column/i);
      expect(raw).toMatch(/unique \(group_id, user_id\) constraint is preserved untouched/);
    });
  });

  describe('helpers', () => {
    it.each(HELPER_FUNCTIONS)('helper function %s is defined', (helperName) => {
      expect(active).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${helperName}\\(`, 'i'));
    });

    it.each(HELPER_FUNCTIONS)(
      'helper function %s has active REVOKEs from PUBLIC, anon, and authenticated',
      (helperName) => {
        for (const grantee of ['PUBLIC', 'anon', 'authenticated']) {
          const pattern = new RegExp(
            `revoke all on function public\\.${helperName}\\(\\) from ${grantee};`,
            'i'
          );
          expect(active).toMatch(pattern);
        }
      }
    );

    it('no active statement grants PUBLIC, anon, or authenticated EXECUTE on either helper', () => {
      for (const helperName of HELPER_FUNCTIONS) {
        const pattern = new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${helperName}\\(\\) TO (PUBLIC|anon|authenticated)`,
          'i'
        );
        expect(active).not.toMatch(pattern);
      }
    });
  });

  describe('backfill', () => {
    const backfillStart = active.indexOf(
      'create or replace function public._groups_backfill_unassigned_memberships('
    );
    const backfillEnd = active.indexOf(
      'revoke all on function public._groups_sole_active_japam_id() from public;',
      backfillStart
    );
    expect(backfillStart).toBeGreaterThan(-1);
    const backfillSection = active.slice(backfillStart, backfillEnd);

    it('binds a membership only when the member owns exactly one active Japam', () => {
      expect(backfillSection).toMatch(/having count\(j\.id\) = 1/);
      expect(backfillSection).toMatch(/j\.archived_at is null/);
    });

    it("joins Japams by the member's own user_id (never by group name or history)", () => {
      expect(backfillSection).toMatch(/join public\.japams j\s+on j\.user_id = m\.user_id/);
      expect(backfillSection).not.toMatch(/lower\(/);
      expect(backfillSection).not.toMatch(/japam_history/);
    });

    it('is idempotent — only touches memberships whose japam_id is still null', () => {
      expect(backfillSection).toMatch(/gm\.japam_id is null/);
    });

    it('returns the required report columns', () => {
      for (const col of ['backfilled', 'ambiguous', 'no_active_japam', 'still_unassigned']) {
        expect(backfillSection).toMatch(new RegExp(`\\bas ${col}\\b`));
      }
    });

    it('reports counts for both ambiguous and no-active-Japam members', () => {
      expect(backfillSection).toMatch(/active_count > 1/);
      expect(backfillSection).toMatch(/active_count = 0/);
    });
  });

  it.each(AUTHORITATIVE_RPCS)(
    '%s%s exists exactly once with the authoritative signature',
    (rpcName, types) => {
      const matching = functionHeaders(active, rpcName).filter(
        (h) => JSON.stringify(headerTypeTokens(h)) === JSON.stringify(types)
      );
      expect(matching).toHaveLength(1);
    }
  );

  it.each(ALL_LEGACY_RPCS)(
    '%s%s exists exactly once as the legacy wrapper signature',
    (rpcName, types) => {
      const matching = functionHeaders(active, rpcName).filter(
        (h) => JSON.stringify(headerTypeTokens(h)) === JSON.stringify(types)
      );
      expect(matching).toHaveLength(1);
    }
  );

  it.each(AUTHORITATIVE_RPCS)(
    '%s%s derives the caller identity from auth.uid() — never trusts a p_*_user_id parameter',
    (rpcName, types) => {
      const body = functionBody(active, rpcName, [...types]);
      if (rpcName === 'join_group_by_invite_code') {
        // join is the one RPC that never accepted a p_*_user_id — it authenticates directly.
        expect(body).toMatch(/auth\.uid\(\)::text/);
        expect(body).toMatch(/is null then/);
      } else {
        expect(body).toMatch(/_groups_require_caller_id\(\)/);
      }
    }
  );

  it.each(LEGACY_SOLE_BIND_WRAPPER_RPCS)(
    '%s%s is a thin wrapper that auto-binds via _groups_sole_active_japam_id()',
    (rpcName, types) => {
      const body = functionBody(active, rpcName, [...types]);
      expect(body).toMatch(/_groups_sole_active_japam_id\(\)/);
      expect(body).toMatch(/select \* from public\./);
    }
  );

  describe('legacy membership-aware wrappers', () => {
    it('legacy get_group_dashboard resolves the membership Japam first and fails on unassigned memberships', () => {
      const body = functionBody(active, 'get_group_dashboard', ['uuid', 'text', 'timestamptz', 'timestamptz']);
      expect(body).toMatch(/_groups_require_caller_id\(\)/);
      expect(body).toMatch(/_groups_legacy_sub\(\)/);
      expect(body).toMatch(/select gm\.japam_id\s+into v_japam/);
      expect(body).toMatch(/if not found then/);
      expect(body).toMatch(/if v_japam is null then/);
      expect(body).not.toMatch(/_groups_sole_active_japam_id\(\)/);
      expect(body).toMatch(/this legacy group membership is not assigned to a Japam/);
      expect(body).toMatch(/not a member of this group/);
    });
  });

  describe('workspace-scoped reads never leak across workspaces', () => {
    it("get_my_groups filters INSIDE the RPC by the caller's own memberships with japam_id = p_japam_id", () => {
      const body = functionBody(active, 'get_my_groups', ['text', 'uuid']);
      expect(body).toMatch(/gm\.japam_id = p_japam_id/);
      expect(body).toMatch(/selected Japam does not belong to your account or is not active/);
    });

    it('get_my_unassigned_groups returns only japam_id IS NULL memberships', () => {
      const body = functionBody(active, 'get_my_unassigned_groups', []);
      expect(body).toMatch(/gm\.japam_id is null/);
    });

    it('legacy get_my_groups(text) preserves caller-scoped active memberships', () => {
      const body = functionBody(active, 'get_my_groups', ['text']);
      expect(body).toMatch(/_groups_require_caller_id\(\)/);
      expect(body).toMatch(/_groups_legacy_sub\(\)/);
      expect(body).toMatch(/caller_memberships/);
      expect(body).toMatch(/g\.is_active/);
      expect(body).toMatch(/order by g\.name, g\.id/i);
      expect(body).not.toMatch(/workspace-scoped clients must call get_my_groups\(text, uuid\)/i);
      expect(body).not.toMatch(/_groups_sole_active_japam_id\(\)/);
    });

    it("attach_group_membership_to_japam accepts the current or legacy identity and touches only its unassigned row", () => {
      const body = functionBody(active, 'attach_group_membership_to_japam', ['uuid', 'uuid']);
      expect(body).toMatch(/v_legacy_sub text := public\._groups_legacy_sub\(\)/);
      expect(body).toMatch(/gm\.user_id = v_caller or \(v_legacy_sub is not null and gm\.user_id = v_legacy_sub\)/);
      expect(body).toMatch(/gm\.japam_id is null/);
      expect(body).toMatch(/already attached to a Japam/);
    });

    it('join_group_by_invite_code attaches null legacy membership and rejects another workspace', () => {
      const body = functionBody(active, 'join_group_by_invite_code', ['text', 'text', 'uuid']);
      expect(body).toMatch(/v_legacy_sub\s+text := public\._groups_legacy_sub\(\)/);
      expect(body).toMatch(/v_existing_user\s+text/);
      expect(body).toMatch(/v_existing_japam\s+uuid/);
      expect(body).toMatch(/gm\.user_id = v_user_id or \(v_legacy_sub is not null and gm\.user_id = v_legacy_sub\)/);
      expect(body).toMatch(/set japam_id = p_japam_id/);
      expect(body).toMatch(/already a member of this group under a different Japam/);
    });
  });

  describe('dashboard aggregation is per-member workspace-scoped', () => {
    const body = functionBody(active, 'get_group_dashboard', [
      'uuid',
      'text',
      'timestamptz',
      'timestamptz',
      'uuid',
    ]);

    it('joins history to memberships by user_id AND japam_id (never sums by user_id alone)', () => {
      const joinOccurrences = (body.match(/gm_mapped\.japam_id = h\.japam_id/g) || []).length;
      expect(joinOccurrences).toBeGreaterThanOrEqual(2); // lifetime + today subqueries
      expect(body).toMatch(/gm_mapped\.user_id = h\.user_id/);
    });

    it('ignores unassigned memberships and never counts japam_id IS NULL legacy history', () => {
      expect(body).toMatch(/gm\.japam_id is not null/);
      expect(body).toMatch(/join public\.group_members gm_mapped/);
    });

    it("verifies the viewer's own membership is attached to the requested workspace", () => {
      expect(body).toMatch(/gm_check\.japam_id = p_japam_id/);
      expect(body).toMatch(/selected workspace does not match this group membership/);
      expect(body).toMatch(/not a member of this group/);
    });

    it('preserves tombstone/deleted-completion exclusions', () => {
      expect(body).toMatch(/deleted_completions/);
      expect(body).toMatch(/dc\.completion_id = h\.completion_id/);
    });
  });

  it('never grants EXECUTE to anon anywhere in the active apply section', () => {
    expect(active).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO anon/i);
    expect(active).not.toMatch(/GRANT ALL ON FUNCTION[\s\S]*?TO anon/i);
  });

  it.each(ALL_RPCS)(
    '%s%s explicitly revokes anon EXECUTE',
    (rpcName, types) => {
      const typesJoined = [...types].join(', ');
      expect(active).toMatch(
        new RegExp(`revoke all on function public\\.${rpcName}\\(${typesJoined}\\) from anon;`, 'i')
      );
    }
  );

  it.each(ALL_RPCS)(
    '%s%s is revoked from PUBLIC and granted to authenticated + service_role',
    (rpcName, types) => {
      const header = functionHeaders(active, rpcName).find(
        (h) => JSON.stringify(headerTypeTokens(h)) === JSON.stringify(types)
      );
      expect(header).toBeDefined();

      // Normalize each header to its bare `name(type, type, ...)` signature so the GRANT/REVOKE
      // regex below can match the single-line grant statements.
      const typesJoined = [...types].join(', ');
      expect(active).toMatch(
        new RegExp(`revoke all on function public\\.${rpcName}\\(${typesJoined}\\) from public;`, 'i')
      );
      expect(active).toMatch(
        new RegExp(`grant execute on function public\\.${rpcName}\\(${typesJoined}\\) to authenticated;`, 'i')
      );
      expect(active).toMatch(
        new RegExp(`grant execute on function public\\.${rpcName}\\(${typesJoined}\\) to service_role;`, 'i')
      );
    }
  );

  it('post-apply verification queries check the column, indexes, unique constraint, and RPCs', () => {
    expect(active).toMatch(/group_members_user_id_japam_id_idx/);
    expect(active).toMatch(/group_members_group_id_japam_id_idx/);
    expect(active).toMatch(/group_members_group_id_user_id_key/);
    expect(active).toMatch(/pg_get_function_arguments/);
  });

  it('a rollback section exists and names every drop this migration added', () => {
    expect(raw).toMatch(/SECTION 8: ROLLBACK/);
    const rollbackStart = raw.indexOf('SECTION 8: ROLLBACK');
    const rollbackSection = raw.slice(rollbackStart);
    for (const statement of [
      'drop column if exists japam_id',
      'drop function if exists public.get_group_dashboard(uuid, text, timestamptz, timestamptz, uuid)',
      'drop function if exists public.get_my_groups(text, uuid)',
      'drop function if exists public.join_group_by_invite_code(text, text, uuid)',
      'drop function if exists public.create_group(text, text, text, uuid)',
      'drop function if exists public.attach_group_membership_to_japam(uuid, uuid)',
      'drop function if exists public.get_my_unassigned_groups()',
      'drop function if exists public._groups_sole_active_japam_id()',
      'drop function if exists public._groups_backfill_unassigned_memberships()',
    ]) {
      expect(rollbackSection).toContain(statement);
    }
  });
});

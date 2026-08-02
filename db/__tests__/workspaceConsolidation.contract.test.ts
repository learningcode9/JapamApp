/**
 * Contract test for the Family workspace-consolidation migration package:
 *   db/workspace_consolidation.sql           (apply, one transaction)
 *   db/workspace_consolidation_rollback.sql  (restores the migration; refuses on drift)
 *   db/workspace_consolidation_cleanup.sql   (removes backup artifacts after approval)
 *   db/staging_family_consolidation_fixture.sql (staging-only, rollback-only fixture)
 *
 * Like the other db/__tests__/*.contract.test.ts files, this is a STATIC structural check
 * of the SQL FILE itself — it never connects to a database. It guards the hardening
 * requirements of the migration review:
 *   - the apply is a single balanced transaction (BEGIN at the top, COMMIT at the end) so
 *     COMMIT only ever executes after every assertion passes;
 *   - the apply carries an EXPLICIT expected mapping: exact family group id, exact five
 *     user_ids, exact canonical/duplicate/pre-archived/created Japam ids, and exact
 *     membership links — and aborts on any shape mismatch (SECTION 1);
 *   - all parity validation (P1..P7) runs INSIDE the apply transaction (SECTION 6);
 *   - backups go into a private migration_backup schema with access revoked from
 *     PUBLIC/anon/authenticated/service_role, using migration-specific names, and a
 *     manifest records row counts + md5 checksums;
 *   - the apply locks the exact affected rows (SELECT ... FOR UPDATE);
 *   - the apply installs two stale-client write-guard triggers (block history to archived
 *     Japams; block re-activating an archived Japam);
 *   - rollback is separate from cleanup: rollback restores and REFUSES on post-migration
 *     writes and never drops the backup schema; cleanup removes backup artifacts only and
 *     refuses while the consolidated invariants are broken;
 *   - the staging fixture uses the real production ids and OVERRIDING SYSTEM VALUE, and
 *     its teardown re-creates the staging-only unique index with its exact definition.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

const applyFile = fs.readFileSync(path.join(ROOT, 'workspace_consolidation.sql'), 'utf8');
const rollbackFile = fs.readFileSync(path.join(ROOT, 'workspace_consolidation_rollback.sql'), 'utf8');
const cleanupFile = fs.readFileSync(path.join(ROOT, 'workspace_consolidation_cleanup.sql'), 'utf8');
const fixtureFile = fs.readFileSync(path.join(ROOT, 'staging_family_consolidation_fixture.sql'), 'utf8');

const FAMILY_GROUP = 'c469d784-1ce9-4094-aa97-b26ed2865acb';
const USER_IDS = [
  '3c313835-e391-4607-853f-e23a108d9c2b',
  '6829d5ea-285c-458c-9577-7bce4422c45c',
  'd25472a6-741a-48ee-8c6e-fcb8ea8394f5',
  'f1887c24-5728-4246-9912-699de2ea2f05',
  '87f50692-bdf2-49ad-97cf-0e79da8788fa',
];
const CANONICAL_IDS = [
  'cd811356-5954-4b75-aed3-f9e9cf5b3ffd',
  '82876810-f2e3-4943-82ac-d9be0e3309d9',
  'b91c31a4-9c36-45a1-a2ce-53b5b3cbbb14',
  '51356d77-5981-4b45-9bc9-0ae657a5fa2b',
  'a1b78928-6d21-5dca-8fed-b023e97edfa2',
];
const DUPLICATE_IDS = [
  '19748f34-124d-4b78-8580-321bf82a1063',
  '0c4773b3-d9d0-431e-bbff-6a0774573636',
  'fdc2961b-4512-4308-afc9-9da36522d10b',
  '69ebd607-d755-4272-aabc-09041c1f94c3',
  '69c01af2-578b-4a7c-85ef-4a839277d8cd',
  '64b10996-e692-43e0-9706-6006c2c21e62',
];
const PRE_ARCHIVED_IDS = ['2f58d18b-f4ce-44f8-963b-257277df5f99'];
const MEMBERSHIP_LINKS = [
  ['2c6b36f5-c16e-41b4-9c5b-7345006852b7', USER_IDS[0], null],
  ['f5acc279-3815-460b-bc2d-8bb8fa2962ea', USER_IDS[1], CANONICAL_IDS[1]],
  ['d36e4ff8-d2e6-4cbe-a269-714d35bfeebc', USER_IDS[2], null],
  ['12e65d86-c2cf-46af-8cd8-f86a838179f1', USER_IDS[3], null],
  ['041645f7-e49f-4212-8a73-2aefef087575', USER_IDS[4], CANONICAL_IDS[3]],
] as const;

/** Strips SQL line comments so counts aren't inflated by prose that mentions a name. */
const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('db/workspace_consolidation.sql structural contract (apply)', () => {
  const active = stripComments(applyFile);

  it('is a single balanced transaction: exactly one top-level begin; and one commit;', () => {
    expect(active.match(/^begin;/gm) || []).toHaveLength(1);
    expect(active.match(/^commit;/gm) || []).toHaveLength(1);
    expect(active.match(/^rollback;/gm) || []).toHaveLength(0);
  });

  it('keeps the whole apply (assertions included) inside the transaction', () => {
    const beginIdx = active.search(/^begin;/m);
    const commitIdx = active.search(/^commit;/m);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    // Both the expected-mapping temp tables and the parity assertions sit between them.
    expect(active.indexOf('_ws_expected_japams', beginIdx)).toBeGreaterThan(beginIdx);
    expect(active.indexOf('_ws_expected_japams', beginIdx)).toBeLessThan(commitIdx);
    expect(active.indexOf('WS_PARITY_FAILURE', beginIdx)).toBeLessThan(commitIdx);
    expect(active.indexOf('WS_PARITY_FAILURE')).toBeGreaterThan(-1);
  });

  it('A: hardcodes the exact family group id', () => {
    expect(active).toMatch(new RegExp(FAMILY_GROUP));
  });

  it('A: hardcodes the exact five user_ids', () => {
    for (const uid of USER_IDS) expect(active).toMatch(new RegExp(uid));
  });

  it('A: hardcodes every expected canonical, duplicate and pre-archived Japam id', () => {
    for (const id of [...CANONICAL_IDS, ...DUPLICATE_IDS, ...PRE_ARCHIVED_IDS]) {
      expect(active).toMatch(new RegExp(id));
    }
  });

  it('A: hardcodes the expected membership links', () => {
    for (const [, uid, japamId] of MEMBERSHIP_LINKS) {
      const needle = japamId ? `${uid}.*${japamId}` : `${uid}.*null::uuid`;
      expect(active).toMatch(new RegExp(needle, 's'));
    }
  });

  it('A: aborts (raises) on any shape mismatch via the SECTION 1 assertion', () => {
    expect(active).toMatch(/WS_SHAPE_MISMATCH \(SECTION 1\)/);
    expect(active).toMatch(/raise exception 'WS_SHAPE_MISMATCH/);
  });

  it('B: runs the parity validation inside the transaction and COMMITs only when all pass', () => {
    for (const marker of ['WS_PARITY_FAILURE', 'P1 ', 'P2 ', 'P3 ', 'P4 ', 'P5 ', 'P6 ', 'P7 ']) {
      expect(active).toMatch(new RegExp(marker));
    }
    // The failure DO block comes before COMMIT.
    const failIdx = active.indexOf('WS_PARITY_FAILURE');
    const commitIdx = active.search(/^commit;/m);
    expect(failIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeLessThan(commitIdx);
  });

  it('C: backs up into a private migration_backup schema, not public _ws_backup_* tables', () => {
    expect(active).toMatch(/create schema if not exists migration_backup;/);
    expect(active).not.toMatch(/create table\s+public\._ws_backup_/i);
    expect(active).not.toMatch(/create table\s+_ws_backup_/);
  });

  it('C: revokes migration_backup access from PUBLIC, anon, authenticated and service_role', () => {
    expect(active).toMatch(/revoke all on schema migration_backup from public;/);
    expect(active).toMatch(/revoke all on schema migration_backup from anon;/);
    expect(active).toMatch(/revoke all on schema migration_backup from authenticated;/);
    expect(active).toMatch(/revoke all on schema migration_backup from service_role;/);
    expect(active).toMatch(
      /revoke all on all tables in schema migration_backup from public, anon, authenticated, service_role;/
    );
  });

  it('C: uses migration-specific backup table names and records checksums + row counts', () => {
    for (const name of ['ws1_japam_history', 'ws1_group_members', 'ws1_japams', 'ws1_manifest']) {
      expect(active).toMatch(new RegExp(name));
    }
    expect(active).toMatch(/md5\(coalesce\(string_agg\(md5\(row_to_json/);
    expect(active).toMatch(/pre_row_count/);
    expect(active).toMatch(/post_row_count/);
  });

  it('E: locks the exact affected rows with SELECT ... FOR UPDATE', () => {
    expect(active).toMatch(/from public\.japams\s+[\s\S]*?for update;/);
    expect(active).toMatch(/from public\.group_members\s+[\s\S]*?for update;/);
    expect(active).toMatch(/from public\.japam_history\s+[\s\S]*?for update;/);
  });

  it('E: installs both stale-client write-guard triggers', () => {
    expect(active).toMatch(/create or replace function public\._ws_guard_history_archived_japam\(\)/);
    expect(active).toMatch(/create trigger _ws_no_history_to_archived_japam/);
    expect(active).toMatch(/JAPAM_ARCHIVED_WRITE_BLOCKED/);
    expect(active).toMatch(/create or replace function public\._ws_guard_no_unarchive\(\)/);
    expect(active).toMatch(/create trigger _ws_no_unarchive/);
    expect(active).toMatch(/JAPAM_UNARCHIVE_BLOCKED/);
  });

  it('D: never describes the apply as cleanup/rollback', () => {
    expect(active).not.toMatch(/^rollback;/m);
    expect(active).not.toMatch(/drop schema migration_backup/);
  });

  it('cross-checks the deterministic bellam id against the app uuidV5 (abort on mismatch)', () => {
    expect(active).toMatch(/extensions\.digest/);
    expect(active).toMatch(/WS_UUIDV5_MISMATCH/);
  });

  it('never grants EXECUTE on the guard functions to anon/authenticated', () => {
    expect(active).not.toMatch(/grant .* on function public\._ws_guard_/i);
  });
});

describe('db/workspace_consolidation_rollback.sql structural contract', () => {
  const active = stripComments(rollbackFile);

  it('is one transaction and drops the restore guards after the manifest check', () => {
    expect(active.match(/^begin;/gm) || []).toHaveLength(1);
    expect(active.match(/^commit;/gm) || []).toHaveLength(1);
    expect(active).not.toMatch(/set_config\('ws\.bypass_guards', 'on', true\)/);
    expect(active).toMatch(/WS_ROLLBACK_REFUSED/);
    expect(active).toMatch(/drop trigger if exists _ws_no_history_to_archived_japam/);
    expect(active).toMatch(/drop trigger if exists _ws_no_unarchive/);
  });

  it('refuses when unexpected post-migration writes exist (compares against the manifest)', () => {
    expect(active).toMatch(/WS_ROLLBACK_REFUSED/);
    expect(active).toMatch(/post_checksum/);
    expect(active).toMatch(/post_row_count/);
  });

  it('restores the migration: history japam_id, memberships, japams, and deletes the created Japam', () => {
    expect(active).toMatch(/update public\.japam_history h\s+set japam_id = b\.japam_id\s+from migration_backup\.ws1_japam_history b/);
    expect(active).toMatch(/update public\.group_members gm\s+set japam_id = b\.japam_id/);
    expect(active).toMatch(/update public\.japams j\s+set name = b\.name/);
    expect(active).toMatch(/delete from public\.japams j\s+[\s\S]*?not exists \(select 1 from migration_backup\.ws1_japams b where b\.id = j\.id\)/);
  });

  it('is NOT cleanup: it keeps the backup schema and drops only the guard triggers it added', () => {
    expect(active).not.toMatch(/drop schema migration_backup/);
    expect(active).toMatch(/drop trigger if exists _ws_no_history_to_archived_japam/);
    expect(active).toMatch(/drop trigger if exists _ws_no_unarchive/);
    expect(active).toMatch(/backup artifacts intentionally kept/);
  });
});

describe('db/workspace_consolidation_cleanup.sql structural contract', () => {
  const active = stripComments(cleanupFile);

  it('removes backup artifacts only, never restores the migration', () => {
    expect(active).toMatch(/drop schema if exists migration_backup cascade;/);
    expect(active).not.toMatch(/update public\.japam_history/);
    expect(active).not.toMatch(/delete from public\.japams/);
  });

  it('refuses to drop the backup schema while the consolidated invariants are broken', () => {
    expect(active).toMatch(/WS_CLEANUP_REFUSED/);
    expect(active).toMatch(/exactly one active Japam/);
  });

  it('is NOT rollback: it is only safe after final approval', () => {
    expect(active).not.toMatch(/set_config\('ws\.bypass_guards'/);
    expect(cleanupFile).toMatch(/AFTER FINAL[\s\S]*?APPROVAL/i);
    expect(active).not.toMatch(/^rollback;/m);
  });
});

describe('db/staging_family_consolidation_fixture.sql structural contract', () => {
  const active = stripComments(fixtureFile);

  it('uses the real production ids for the group, memberships and Japams', () => {
    expect(active).toMatch(new RegExp(FAMILY_GROUP));
    expect(active).toMatch(/2c6b36f5-c16e-41b4-9c5b-7345006852b7/);
    expect(active).toMatch(/2f58d18b-f4ce-44f8-963b-257277df5f99/);
  });

  it('inserts history with OVERRIDING SYSTEM VALUE (japam_history.id is identity GENERATED ALWAYS)', () => {
    expect(active).toMatch(/overriding system value/gi);
  });

  it('is wrapped in one transaction', () => {
    expect(active.match(/^begin;/gm) || []).toHaveLength(1);
    expect(active.match(/^commit;/gm) || []).toHaveLength(1);
  });

  it('teardown removes every fixture row and re-creates the staging-only index exactly', () => {
    // Teardown is deliberately a COMMENTED section (operator un-comments to run it), so
    // these assertions inspect the RAW file where the `-- `-prefixed statements survive.
    expect(fixtureFile).toMatch(/--\s*delete from public\.japam_history where completion_id like 'fixture-%'/);
    expect(fixtureFile).toMatch(/--\s*delete from public\.groups where id = 'c469d784-1ce9-4094-aa97-b26ed2865acb'/);
    // The index re-creation spans two commented lines, so match its parts separately.
    expect(fixtureFile).toMatch(/--\s*create unique index if not exists japams_user_id_normalized_name_key/);
    expect(fixtureFile).toMatch(/--\s*on public\.japams \(user_id, lower\(btrim\(regexp_replace\(name, '\\s\+', ' ', 'g'\)\)\)\);?/);
  });

  it('teardown is never run by the fixture apply (guarded, commented-out section)', () => {
    // The apply section runs in its own begin/commit; the teardown lives in a commented
    // SECTION 4 block so a careless copy-paste cannot delete staging data automatically.
    const applyEnd = fixtureFile.indexOf('SECTION 3: POST-LOAD');
    expect(applyEnd).toBeGreaterThan(-1);
    expect(fixtureFile.slice(0, applyEnd)).not.toMatch(/^delete from public\.japam_history/m);
  });
});

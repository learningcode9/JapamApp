/**
 * Contract test for db/delete_owned_japam_rpc.sql.
 *
 * Static SQL shape check only. It does not execute the migration; it guards the permanent-delete
 * RPC against regressions in auth gating, search_path pinning, tombstone insertion, and grant scope.
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'delete_owned_japam_rpc.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

describe('db/delete_owned_japam_rpc.sql contract', () => {
  it('defines an authenticated SECURITY DEFINER RPC with fixed search_path', () => {
    expect(sql).toMatch(/create or replace function public\.delete_owned_japam\(\s*p_japam_id uuid\s*\)/i);
    expect(sql).toMatch(/returns table \(\s*deleted_japam_id uuid,\s*scoped_history_deleted bigint,\s*legacy_history_deleted bigint,\s*tombstones_written bigint,\s*ambiguous_legacy_count bigint\s*\)/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
    expect(sql).toMatch(/auth\.uid\(\)::text/);
    expect(sql).toMatch(/auth\.jwt\(\)->'user_metadata'->>'sub'/i);
    expect(sql).toMatch(/where id = p_japam_id\s+and \(user_id = v_uid or user_id = v_legacy_uid\)/i);
    expect(sql).toMatch(/insert into public\.deleted_japams/i);
    expect(sql).toMatch(/on conflict \(japam_id\) do nothing/i);
    expect(sql).toMatch(/select id, user_id into v_deleted_id, v_deleted_owner_id/i);
    expect(sql).toMatch(/get diagnostics v_row_count = row_count/i);
    expect(sql).toMatch(/raise exception 'delete_owned_japam failed to delete exactly one owned Japam'/i);
  });

  it('grants execute only to authenticated and revokes other roles', () => {
    expect(sql).toMatch(/revoke all on function public\.delete_owned_japam\(uuid\) from public;/i);
    expect(sql).toMatch(/revoke all on function public\.delete_owned_japam\(uuid\) from anon;/i);
    expect(sql).toMatch(/revoke all on function public\.delete_owned_japam\(uuid\) from authenticated;/i);
    expect(sql).toMatch(/grant execute on function public\.delete_owned_japam\(uuid\) to authenticated;/i);
  });
});

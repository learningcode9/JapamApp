/**
 * Contract test for db/get_owned_japam_usage_rpc.sql.
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'get_owned_japam_usage_rpc.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

describe('db/get_owned_japam_usage_rpc.sql contract', () => {
  it('exposes exact ownership-scoped usage counts', () => {
    expect(sql).toMatch(/create or replace function public\.get_owned_japam_usage\(\s*p_japam_id uuid\s*\)/i);
    expect(sql).toMatch(/returns table \(\s*japam_id uuid,\s*name text,\s*archived_at timestamptz,\s*history_count bigint,\s*group_ref_count bigint\s*\)/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
    expect(sql).toMatch(/auth\.uid\(\)::text/i);
    expect(sql).toMatch(/auth\.jwt\(\)->'user_metadata'->>'sub'/i);
    expect(sql).toMatch(/from public\.japam_history h where h\.user_id = j\.user_id and h\.japam_id = j\.id/i);
    expect(sql).toMatch(/from public\.group_members gm where gm\.user_id = j\.user_id and gm\.japam_id = j\.id/i);
  });

  it('grants execute only to authenticated and revokes other roles', () => {
    expect(sql).toMatch(/revoke all on function public\.get_owned_japam_usage\(uuid\) from public;/i);
    expect(sql).toMatch(/revoke all on function public\.get_owned_japam_usage\(uuid\) from anon;/i);
    expect(sql).toMatch(/revoke all on function public\.get_owned_japam_usage\(uuid\) from authenticated;/i);
    expect(sql).toMatch(/grant execute on function public\.get_owned_japam_usage\(uuid\) to authenticated;/i);
  });
});

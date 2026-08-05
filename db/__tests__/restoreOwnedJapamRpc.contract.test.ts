/**
 * Contract test for db/restore_owned_japam_rpc.sql.
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'restore_owned_japam_rpc.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

describe('db/restore_owned_japam_rpc.sql contract', () => {
  it('restores atomically, validates ownership, and retires only empty conflicts', () => {
    expect(sql).toMatch(/create or replace function public\.restore_owned_japam\(\s*p_japam_id uuid\s*\)/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
    expect(sql).toMatch(/auth\.uid\(\)::text/i);
    expect(sql).toMatch(/auth\.jwt\(\)->'user_metadata'->>'sub'/i);
    expect(sql).toMatch(/select j\.name into v_target_name/i);
    expect(sql).toMatch(/multiple active normalized My Japam conflicts exist/i);
    expect(sql).toMatch(/conflicting active My Japam has History or group membership/i);
    expect(sql).toMatch(/insert into public\.deleted_japams \(japam_id, user_id, deleted_at\)/i);
    expect(sql).toMatch(/update public\.japams\s+set archived_at = now\(\),/i);
    expect(sql).toMatch(/update public\.japams\s+set archived_at = null,/i);
    expect(sql).toMatch(/delete from public\.deleted_japams/i);
  });

  it('grants execute only to authenticated and revokes other roles', () => {
    expect(sql).toMatch(/revoke all on function public\.restore_owned_japam\(uuid\) from public;/i);
    expect(sql).toMatch(/revoke all on function public\.restore_owned_japam\(uuid\) from anon;/i);
    expect(sql).toMatch(/revoke all on function public\.restore_owned_japam\(uuid\) from authenticated;/i);
    expect(sql).toMatch(/grant execute on function public\.restore_owned_japam\(uuid\) to authenticated;/i);
  });
});

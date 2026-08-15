import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'supabase', 'migrations', '20260814010000_android_update_available.sql'),
  'utf8',
);

describe('Android update config migration', () => {
  it('seeds the released build and exposes only a read-only RPC', () => {
    expect(sql).toMatch(/latest_version_code integer not null/);
    expect(sql).toMatch(/values \(true, 15\)/);
    expect(sql).toMatch(/create or replace function public\.get_android_latest_version_code\(\)/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/grant execute on function public\.get_android_latest_version_code\(\) to anon, authenticated/);
    expect(sql).toMatch(/revoke all on table public\.android_app_update_config from public, anon, authenticated/);
  });
});

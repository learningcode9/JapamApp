import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260814000000_rotate_group_invite_code.sql'),
  'utf8',
);

describe('rotate_group_invite_code local migration', () => {
  it('requires a verified authenticated admin session', () => {
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/auth\.uid\(\)/i);
    expect(migration).toMatch(/gm\.role\s*=\s*'admin'/i);
    expect(migration).toMatch(/raise exception 'not a group admin'/i);
    expect(migration).toMatch(/grant execute on function public\.rotate_group_invite_code\(uuid, text\) to authenticated;/i);
    expect(migration).toMatch(/revoke all on function public\.rotate_group_invite_code\(uuid, text\) from public;/i);
  });

  it('generates a different unique code and updates only groups.invite_code', () => {
    expect(migration).toMatch(/v_new_code\s*=\s*v_old_code/i);
    expect(migration).toMatch(/md5\(random\(\)::text \|\| clock_timestamp\(\)::text\)/i);
    expect(migration).toMatch(/when unique_violation/i);
    expect(migration).toMatch(/update public\.groups[\s\S]*set invite_code = v_new_code/i);
    expect(migration).not.toMatch(/update public\.group_members/i);
    expect(migration).not.toMatch(/delete from public\.(groups|group_members)/i);
  });
});

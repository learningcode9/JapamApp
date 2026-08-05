import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.resolve(__dirname, '..', 'ensure_default_japam.sql'),
  'utf8',
);
const executableSql = sql.replace(/--[^\n]*/g, '');

describe('ensure_default_japam SQL contract', () => {
  it('uses a transaction advisory lock keyed by user', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('default-japam:' \|\| p_user_id, 0\)\)/);
    expect(sql).toMatch(/create trigger prevent_duplicate_default_japam/);
  });

  it('returns an existing active exact-name default before inserting', () => {
    expect(sql).toMatch(/name = 'My Japam'/);
    expect(sql).toMatch(/archived_at is null/);
    expect(sql).toMatch(/order by created_at asc, id asc/);
    expect(sql).toMatch(/insert into public\.japams \(user_id, name\)/);
  });

  it('is authenticated-only and validates ownership', () => {
    expect(sql).toMatch(/security invoker/);
    expect(sql).toMatch(/auth\.uid\(\)::text = p_user_id/);
    expect(sql).toMatch(/grant execute on function public\.ensure_default_japam\(text\) to authenticated;/);
    expect(sql).toMatch(/revoke all on function public\.ensure_default_japam\(text\) from public;/);
  });

  it('does not delete or merge existing records', () => {
    expect(executableSql).not.toMatch(/\b(delete|truncate)\b/i);
    expect(executableSql).not.toMatch(/update\s+public\.japams/i);
  });
});

/**
 * Contract test for db/deleted_japams_migration.sql.
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'deleted_japams_migration.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

describe('db/deleted_japams_migration.sql contract', () => {
  it('creates a tombstone table with authenticated select access only', () => {
    expect(sql).toMatch(/create table if not exists public\.deleted_japams/i);
    expect(sql).toMatch(/japam_id\s+uuid primary key/i);
    expect(sql).toMatch(/user_id\s+text not null/i);
    expect(sql).toMatch(/deleted_at\s+timestamptz not null default now\(\)/i);
    expect(sql).toMatch(/alter table public\.deleted_japams enable row level security/i);
    expect(sql).toMatch(/authenticated_select_own_deleted_japams/i);
    expect(sql).toMatch(/grant select on table public\.deleted_japams to authenticated/i);
  });
});

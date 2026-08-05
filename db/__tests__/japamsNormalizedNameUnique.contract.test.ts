/**
 * Contract test for db/japams_normalized_name_unique.sql.
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'japams_normalized_name_unique.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

describe('db/japams_normalized_name_unique.sql contract', () => {
  it('upgrades the old index or creates the partial index and blocks unknown conflicts', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX japams_user_id_normalized_name_key ON public\.japams USING btree/i);
    expect(sql).toMatch(/WHERE \(archived_at IS NULL\)/i);
    expect(sql).toMatch(/regexp_replace\(name/i);
    expect(sql).toMatch(/unsupported normalized-name index definition/i);
    expect(sql).toMatch(/drop index if exists public\.%I/i);
  });
});

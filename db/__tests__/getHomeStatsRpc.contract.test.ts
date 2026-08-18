import * as fs from 'fs';
import * as path from 'path';

const migrationPath = path.resolve(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20260818084834_home_stats_rpc.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const executableSql = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('get_home_stats migration contract', () => {
  it('keeps the verified alias map private and does not use auth.identities', () => {
    expect(sql).toMatch(/create schema if not exists private/i);
    expect(sql).toMatch(/private\.legacy_user_id_map/i);
    expect(sql).toMatch(/references auth\.users\(id\)/i);
    expect(sql).toMatch(/revoke all on private\.legacy_user_id_map from public, anon, authenticated/i);
    expect(executableSql).not.toMatch(/auth\.identities/i);
  });

  it('exposes only the authenticated, non-null-workspace summary RPC', () => {
    expect(sql).toMatch(/create or replace function public\.get_home_stats\(\s*p_japam_id uuid,\s*p_today_start timestamptz,\s*p_today_end timestamptz,\s*p_device_timezone text/i);
    expect(sql).toMatch(/returns table \(\s*today_count bigint,\s*today_malas bigint,\s*day_streak integer/i);
    expect(sql).toMatch(/security invoker/i);
    expect(sql).toMatch(/grant execute on function public\.get_home_stats\(uuid, timestamptz, timestamptz, text\) to authenticated/i);
    expect(sql).toMatch(/revoke all on function public\.get_home_stats\(uuid, timestamptz, timestamptz, text\) from public, anon/i);
    expect(sql).toMatch(/p_japam_id is null/i);
    expect(sql).toMatch(/j\.archived_at is null/i);
    expect(sql).toMatch(/j\.user_id = any\(v_owner_ids\)/i);
  });

  it('validates the device timezone and consecutive local-midnight bounds', () => {
    expect(sql).toMatch(/from pg_timezone_names/i);
    expect(sql).toMatch(/p_today_start at time zone p_device_timezone/i);
    expect(sql).toMatch(/p_today_end at time zone p_device_timezone/i);
    expect(sql).toMatch(/consecutive local midnights/i);
    expect(sql).toMatch(/v_today_date \+ 1/i);
  });

  it('mirrors legacy attribution, effective counts, tombstones, and deterministic dedupe', () => {
    expect(sql).toMatch(/dh\.japam_id = sj\.id/i);
    expect(sql).toMatch(/sj\.name_count = 1/i);
    expect(sql).toMatch(/sj\.is_first/i);
    expect(sql).toMatch(/j\.display_order nulls last, j\.created_at asc, j\.id asc/i);
    expect(sql).toMatch(/dc\.completion_id = h\.completion_id/i);
    expect(sql).toMatch(/coalesce\(h\.completion_id, '\*\*row\*\*:' \|\| h\.id::text\)/i);
    expect(sql).toMatch(/partition by hc\.completion_key\s+order by hc\.created_at desc, hc\.id desc/i);
    expect(sql).toMatch(/when coalesce\(dh\.count, 0\) > 0 then dh\.count::bigint/i);
    expect(sql).toMatch(/when coalesce\(dh\.malas, 0\) > 0 then dh\.malas::bigint \* 108/i);
    expect(sql).toMatch(/where sh\.effective_count > 0/i);
  });

  it('returns one summary row and computes a server-side streak without raw history', () => {
    expect(sql).toMatch(/with recursive/i);
    expect(sql).toMatch(/from summary s;/i);
    expect(sql).not.toMatch(/returns setof public\.japam_history/i);
    expect(sql).toMatch(/floor\(s\.today_count::numeric \/ 108\)::bigint/i);
    expect(sql).toMatch(/coalesce\(\(select count\(\*\)::integer from streak_days\), 0\)/i);
  });
});

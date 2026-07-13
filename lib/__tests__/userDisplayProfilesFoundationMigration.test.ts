import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../db/user_display_profiles_foundation.sql'
);

describe('user display profiles foundation migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('is a single transactional SQL Editor script with distinct procedural delimiters', () => {
    expect(sql).toMatch(/begin;[\s\S]*commit;/i);
    expect(sql).toContain('do $display_profile_preflight$');
    expect(sql).toContain('$display_profile_preflight$;');
    expect(sql).toContain('as $upsert_my_display_profile$');
    expect(sql).toContain('$upsert_my_display_profile$;');
    expect(sql).toContain('as $reset_my_display_profile_to_provider$');
    expect(sql).toContain('$reset_my_display_profile_to_provider$;');
    expect(sql).not.toMatch(/\$\$/);
    expect(sql).not.toMatch(/^\\(?:i|set|connect|gset)\b/m);
  });

  it('creates only the additive UUID-keyed profile foundation and no profile rows', () => {
    expect(sql).toContain('create table public.user_display_profiles');
    expect(sql).toContain('user_id uuid primary key references auth.users(id) on delete cascade');
    expect(sql).toContain("check (name_source in ('provider', 'manual'))");
    expect(sql).toContain('char_length(btrim(display_name)) between 1 and 80');
    expect(sql).not.toMatch(/\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.(?!user_display_profiles)/i);
    expect(sql).toContain('profile_rows_after_foundation');
  });

  it('keeps direct writes blocked and restricts self-scoped RPC execution', () => {
    expect(sql).toContain('alter table public.user_display_profiles enable row level security');
    expect(sql).toContain('revoke all on table public.user_display_profiles from anon, authenticated');
    expect(sql).toContain('grant select on table public.user_display_profiles to authenticated');
    expect(sql).toContain('using (auth.uid() = user_id)');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public, pg_temp');
    expect(sql).toContain('revoke all on function public.upsert_my_display_profile(text, text) from public');
    expect(sql).toContain('revoke execute on function public.upsert_my_display_profile(text, text) from anon');
    expect(sql).toContain('grant execute on function public.upsert_my_display_profile(text, text) to authenticated');
    expect(sql).toContain('revoke all on function public.reset_my_display_profile_to_provider(text) from public');
    expect(sql).toContain('revoke execute on function public.reset_my_display_profile_to_provider(text) from anon');
    expect(sql).toContain('grant execute on function public.reset_my_display_profile_to_provider(text) to authenticated');
  });

  it('preserves provider/manual precedence and never accepts a caller-supplied user id', () => {
    expect(sql).toContain("when profile.name_source = 'manual' and excluded.name_source = 'provider'");
    expect(sql).toContain('v_user_id uuid := auth.uid()');
    expect(sql).toContain("raise exception 'authentication required to update display profile'");
    expect(sql).toContain('reset_my_display_profile_to_provider(');
    expect(sql).not.toMatch(/\bp_user_id\b/i);
  });
});

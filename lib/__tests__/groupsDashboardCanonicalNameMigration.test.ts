import fs from 'fs';
import path from 'path';

const migrationPath = path.resolve(
  __dirname,
  '../../db/update_group_dashboard_canonical_display_name.sql'
);

describe('live-derived get_group_dashboard canonical-name migration', () => {
  it('is pinned to the approved live staging function fingerprint', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('db73738e4181cd13edf70abec2a14ca6');
    expect(sql).toContain("'public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure");
  });

  it('changes only member display-name resolution and adds one safe profile join', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain("coalesce(udp.display_name, gm.user_name, 'Unknown') as user_name");
    expect(sql).toContain('left join public.user_display_profiles udp');
    expect(sql).toContain('on udp.user_id::text = gm.user_id');
    expect(sql).not.toMatch(/gm\.user_id\s*::\s*uuid/i);
    expect(sql).not.toMatch(/(?:insert|update|delete)\s+(?:from\s+)?public\.group_members/i);
  });

  it('preserves the live authorization gate and exact aggregate shape', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const replacementBody = sql.match(/as \$function\$\n([\s\S]*?)\n\$function\$;/)?.[1] ?? '';

    expect(replacementBody).toContain("raise exception 'not a member of this group'");
    expect(replacementBody).toContain('sum(h.malas) as total_malas');
    expect(replacementBody).toContain('sum(h.count) as total_count');
    expect(replacementBody).toContain('max(h.created_at) as last_completed_at');
    expect(replacementBody).toContain('h.created_at >= p_today_start');
    expect(replacementBody).toContain('h.created_at < p_today_end');
    expect(replacementBody).not.toContain('deleted_completions');
  });
});

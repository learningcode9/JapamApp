import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const localUrl = process.env.SUPABASE_LOCAL_URL ?? '';
const anonKey = process.env.SUPABASE_LOCAL_ANON_KEY ?? '';
const serviceRoleKey = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? '';
const isLocalSupabaseConfigured =
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(localUrl)
  && anonKey.length > 0
  && serviceRoleKey.length > 0;

const describeLocalSupabase = isLocalSupabaseConfigured ? describe : describe.skip;

describeLocalSupabase('group invite-code rotation local Supabase integration', () => {
  jest.setTimeout(30_000);

  let admin: SupabaseClient;
  let adminClient: SupabaseClient;
  let memberClient: SupabaseClient;
  let adminUserId: string | null = null;
  let memberUserId: string | null = null;
  let groupId: string | null = null;
  let adminJapamId: string | null = null;
  let memberJapamId: string | null = null;
  const originalWebSocket = globalThis.WebSocket;

  const createAuthenticatedClient = async (email: string, password: string) => {
    const client = createClient(localUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  };

  beforeAll(() => {
    if (!globalThis.WebSocket) {
      globalThis.WebSocket = class {} as unknown as typeof WebSocket;
    }
    admin = createClient(localUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  });

  afterAll(async () => {
    if (groupId) await admin.from('groups').delete().eq('id', groupId);
    if (adminJapamId) await admin.from('japams').delete().eq('id', adminJapamId);
    if (memberJapamId) await admin.from('japams').delete().eq('id', memberJapamId);
    if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
    if (memberUserId) await admin.auth.admin.deleteUser(memberUserId);
    if (originalWebSocket) globalThis.WebSocket = originalWebSocket;
    else delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  });

  it('rotates atomically: old code fails, new code joins, and group state is preserved', async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const password = `Local-${stamp}-password!`;
    const createUser = async (label: string) => {
      const result = await admin.auth.admin.createUser({
        email: `group-rotation-${label}-${stamp}@local.test`,
        password,
        email_confirm: true,
      });
      if (result.error) throw result.error;
      if (!result.data.user) throw new Error(`Local Supabase did not create ${label}`);
      return result.data.user.id;
    };

    adminUserId = await createUser('admin');
    memberUserId = await createUser('member');
    adminClient = await createAuthenticatedClient(`group-rotation-admin-${stamp}@local.test`, password);
    memberClient = await createAuthenticatedClient(`group-rotation-member-${stamp}@local.test`, password);

    const { data: adminJapam, error: adminJapamError } = await adminClient.rpc('ensure_default_japam', {
      p_user_id: adminUserId,
    });
    if (adminJapamError) throw adminJapamError;
    const adminJapamRow = Array.isArray(adminJapam) ? adminJapam[0] : adminJapam;
    adminJapamId = adminJapamRow?.id;

    const { data: memberJapam, error: memberJapamError } = await memberClient.rpc('ensure_default_japam', {
      p_user_id: memberUserId,
    });
    if (memberJapamError) throw memberJapamError;
    const memberJapamRow = Array.isArray(memberJapam) ? memberJapam[0] : memberJapam;
    memberJapamId = memberJapamRow?.id;
    if (!adminJapamId || !memberJapamId) throw new Error('Local Supabase did not create test Japams');

    const { data: created, error: createError } = await adminClient.rpc('create_group', {
      p_name: `Rotation Group ${stamp}`,
      p_created_by: adminUserId,
      p_user_name: 'Rotation Admin',
      p_japam_id: adminJapamId,
    });
    if (createError) throw createError;
    const createdRow = Array.isArray(created) ? created[0] : created;
    groupId = createdRow?.group_id;
    const oldCode = createdRow?.invite_code;
    if (!groupId || !oldCode) throw new Error('Local Supabase did not create the rotation group');

    const { data: beforeGroup, error: beforeGroupError } = await admin
      .from('groups')
      .select('id, name, created_by, is_active')
      .eq('id', groupId)
      .single();
    if (beforeGroupError) throw beforeGroupError;

    const { error: historyError } = await admin.from('japam_history').insert({
      created_at: '2026-08-14T12:00:00.000Z',
      user_name: 'Rotation Admin',
      malas: 2,
      count: 216,
      user_id: adminUserId,
      completion_id: `rotation-${stamp}`,
      japam_name: 'Rotation Admin Japam',
      japam_id: adminJapamId,
    });
    if (historyError) throw historyError;

    const { data: beforeMembers, error: beforeMembersError } = await admin
      .from('group_members')
      .select('user_id, role, japam_id')
      .eq('group_id', groupId)
      .order('user_id');
    if (beforeMembersError) throw beforeMembersError;
    const adminMemberBefore = beforeMembers?.find((member) => member.user_id === adminUserId);

    const { data: beforeDashboard, error: beforeDashboardError } = await adminClient.rpc('get_group_dashboard', {
      p_group_id: groupId,
      p_current_user_id: adminUserId,
      p_today_start: '2026-08-14T00:00:00.000Z',
      p_today_end: '2026-08-15T00:00:00.000Z',
      p_japam_id: adminJapamId,
    });
    if (beforeDashboardError) throw beforeDashboardError;

    const { data: rotated, error: rotateError } = await adminClient.rpc('rotate_group_invite_code', {
      p_group_id: groupId,
      p_acting_admin_user_id: adminUserId,
    });
    if (rotateError) throw rotateError;
    const newCode = Array.isArray(rotated) ? rotated[0]?.invite_code : rotated?.invite_code;
    expect(newCode).toBeTruthy();
    expect(newCode).not.toBe(oldCode);

    const { data: oldJoin, error: oldJoinError } = await memberClient.rpc('join_group_by_invite_code', {
      p_invite_code: oldCode,
      p_user_name: 'Rotation Member',
      p_japam_id: memberJapamId,
    });
    if (oldJoinError) throw oldJoinError;
    expect(oldJoin).toEqual([]);

    const { data: newJoin, error: newJoinError } = await memberClient.rpc('join_group_by_invite_code', {
      p_invite_code: newCode,
      p_user_name: 'Rotation Member',
      p_japam_id: memberJapamId,
    });
    if (newJoinError) throw newJoinError;
    expect(newJoin).toHaveLength(1);
    expect(newJoin?.[0]).toMatchObject({ id: groupId, is_active: true });

    const { data: afterMembers, error: afterMembersError } = await admin
      .from('group_members')
      .select('user_id, role, japam_id')
      .eq('group_id', groupId)
      .order('user_id');
    if (afterMembersError) throw afterMembersError;
    expect(afterMembers?.find((member) => member.user_id === adminUserId)).toEqual(adminMemberBefore);
    expect(afterMembers?.find((member) => member.user_id === adminUserId)?.role).toBe('admin');
    expect(afterMembers?.find((member) => member.user_id === memberUserId)).toMatchObject({
      role: 'member',
      japam_id: memberJapamId,
    });

    const { data: afterGroup, error: afterGroupError } = await admin
      .from('groups')
      .select('id, name, created_by, is_active')
      .eq('id', groupId)
      .single();
    if (afterGroupError) throw afterGroupError;
    expect(afterGroup).toEqual(beforeGroup);

    const { data: afterDashboard, error: afterDashboardError } = await adminClient.rpc('get_group_dashboard', {
      p_group_id: groupId,
      p_current_user_id: adminUserId,
      p_today_start: '2026-08-14T00:00:00.000Z',
      p_today_end: '2026-08-15T00:00:00.000Z',
      p_japam_id: adminJapamId,
    });
    if (afterDashboardError) throw afterDashboardError;
    expect(afterDashboard?.find((row: { user_id: string }) => row.user_id === adminUserId)).toEqual(
      beforeDashboard?.find((row: { user_id: string }) => row.user_id === adminUserId),
    );

    const rotatedCodes = [newCode];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data: repeatedRotation, error: repeatedRotationError } = await adminClient.rpc('rotate_group_invite_code', {
        p_group_id: groupId,
        p_acting_admin_user_id: adminUserId,
      });
      if (repeatedRotationError) throw repeatedRotationError;
      const repeatedCode = Array.isArray(repeatedRotation)
        ? repeatedRotation[0]?.invite_code
        : repeatedRotation?.invite_code;
      expect(repeatedCode).toBeTruthy();
      expect(repeatedCode).not.toBe(rotatedCodes.at(-1));
      rotatedCodes.push(repeatedCode);
    }
    expect(new Set(rotatedCodes).size).toBe(rotatedCodes.length);
  });

  it('rejects rotation for a non-admin session', async () => {
    if (!groupId || !memberClient || !memberUserId) throw new Error('rotation fixture was not created');
    const { error } = await memberClient.rpc('rotate_group_invite_code', {
      p_group_id: groupId,
      p_acting_admin_user_id: memberUserId,
    });
    expect(error?.message).toMatch(/not a group admin/i);
  });
});

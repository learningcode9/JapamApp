/**
 * Unit tests for lib/groupsRepository.ts's workspace-scoped RPC calls (Issue 3).
 *
 * These pin the WORKSPACE ISOLATION contract on the client side: every create/join/list/attach/
 * dashboard call must pass the caller's current japamId to the server RPC (the server enforces
 * the scope; the client must never omit it or send a wrong workspace). They also pin that the
 * Join flow goes through the new atomic join_group_by_invite_code RPC rather than the old
 * find_group_by_invite_code + direct group_members insert, and that snake_case RPC rows map to
 * the camelCase shapes the UI consumes.
 */
import { supabase } from '../supabase';

const mockSupabase = supabase as unknown as { from: jest.Mock; rpc: jest.Mock };
const mockRpc = mockSupabase.rpc;
const mockFrom = mockSupabase.from;

jest.mock('../supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn(),
  },
}));

/* eslint-disable import/first -- jest.mock() must precede imports; Jest hoists mock calls above import lines */
import {
  attachGroupMembershipToJapam,
  createGroup,
  getGroupDashboard,
  getMyGroups,
  getMyUnassignedGroups,
  joinGroupByInviteCode,
} from '../groupsRepository';
/* eslint-enable import/first */

const USER_ID = 'user-123';
const JAPAM_ID = '550e8400-e29b-41d4-a716-446655440001';
const GROUP_ID = '660e8400-e29b-41d4-a716-446655440002';
const OTHER_JAPAM_ID = '550e8400-e29b-41d4-a716-446655440099';

const rpcResult = (fn: jest.Mock, data: unknown, error: unknown = null) =>
  fn.mockResolvedValueOnce({ data, error });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getMyGroups', () => {
  it('calls get_my_groups RPC with the caller user_id AND the selected japamId', async () => {
    rpcResult(mockRpc, [{ group_id: GROUP_ID, name: 'Family', role: 'admin', is_active: true, joined_at: '2026-01-01T00:00:00Z' }]);
    const groups = await getMyGroups(USER_ID, JAPAM_ID);
    expect(mockRpc).toHaveBeenCalledWith('get_my_groups', { p_user_id: USER_ID, p_japam_id: JAPAM_ID });
    expect(groups).toEqual([
      { groupId: GROUP_ID, name: 'Family', role: 'admin', isActive: true, joinedAt: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('rejects (throws) when the RPC errors, without returning partial data', async () => {
    rpcResult(mockRpc, null, new Error('not a member'));
    await expect(getMyGroups(USER_ID, JAPAM_ID)).rejects.toThrow('not a member');
  });
});

describe('getMyUnassignedGroups', () => {
  it('calls get_my_unassigned_groups RPC with no args and maps rows', async () => {
    rpcResult(mockRpc, [{ group_id: GROUP_ID, name: 'Legacy Group', role: 'member', is_active: true, joined_at: '2026-01-01T00:00:00Z' }]);
    const groups = await getMyUnassignedGroups();
    expect(mockRpc).toHaveBeenCalledWith('get_my_unassigned_groups', {});
    expect(groups).toEqual([
      { groupId: GROUP_ID, name: 'Legacy Group', role: 'member', isActive: true, joinedAt: '2026-01-01T00:00:00Z' },
    ]);
  });
});

describe('createGroup', () => {
  it('passes p_japam_id to the create_group RPC and maps the created group', async () => {
    rpcResult(mockRpc, [{ group_id: GROUP_ID, group_name: 'Family', invite_code: 'ABCDEFG' }]);
    const result = await createGroup('Family', USER_ID, 'Ram', JAPAM_ID);
    expect(mockRpc).toHaveBeenCalledWith('create_group', {
      p_name: 'Family',
      p_created_by: USER_ID,
      p_user_name: 'Ram',
      p_japam_id: JAPAM_ID,
    });
    expect(result).toEqual({ groupId: GROUP_ID, groupName: 'Family', inviteCode: 'ABCDEFG' });
  });
});

describe('joinGroupByInviteCode', () => {
  it('joins through the atomic RPC with the caller japamId — never find+insert', async () => {
    rpcResult(mockRpc, [{ id: GROUP_ID, name: 'Family', is_active: true, already_member: false }]);
    const outcome = await joinGroupByInviteCode('ABCDEFG', USER_ID, 'Ram', JAPAM_ID);
    expect(mockRpc).toHaveBeenCalledWith('join_group_by_invite_code', {
      p_invite_code: 'ABCDEFG',
      p_user_name: 'Ram',
      p_japam_id: JAPAM_ID,
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'joined', groupId: GROUP_ID, groupName: 'Family' });
  });

  it('returns joined when the RPC reports the caller was already a member (idempotent)', async () => {
    rpcResult(mockRpc, [{ id: GROUP_ID, name: 'Family', is_active: true, already_member: true }]);
    const outcome = await joinGroupByInviteCode('ABCDEFG', USER_ID, 'Ram', JAPAM_ID);
    expect(outcome).toEqual({ kind: 'joined', groupId: GROUP_ID, groupName: 'Family' });
  });

  it('returns notFound when the RPC returns no rows', async () => {
    rpcResult(mockRpc, []);
    const outcome = await joinGroupByInviteCode('NOPE', USER_ID, 'Ram', JAPAM_ID);
    expect(outcome).toEqual({ kind: 'notFound' });
  });

  it('returns inactive when the group is inactive', async () => {
    rpcResult(mockRpc, [{ id: GROUP_ID, name: 'Family', is_active: false, already_member: false }]);
    const outcome = await joinGroupByInviteCode('ABCDEFG', USER_ID, 'Ram', JAPAM_ID);
    expect(outcome).toEqual({ kind: 'inactive' });
  });

  it('returns error with the server message when the RPC fails', async () => {
    rpcResult(mockRpc, null, new Error('selected Japam does not belong to your account or is not active'));
    const outcome = await joinGroupByInviteCode('ABCDEFG', USER_ID, 'Ram', JAPAM_ID);
    expect(outcome).toEqual({ kind: 'error', message: 'selected Japam does not belong to your account or is not active' });
  });

  it('does not report success when the server rejects a different workspace membership', async () => {
    rpcResult(mockRpc, null, new Error('already a member of this group under a different Japam'));
    const outcome = await joinGroupByInviteCode('ABCDEFG', USER_ID, 'Ram', JAPAM_ID);
    expect(outcome).toEqual({
      kind: 'error',
      message: 'already a member of this group under a different Japam',
    });
  });
});

describe('attachGroupMembershipToJapam', () => {
  it('calls attach_group_membership_to_japam with the group + japamId and returns success', async () => {
    rpcResult(mockRpc, true);
    const outcome = await attachGroupMembershipToJapam(GROUP_ID, JAPAM_ID);
    expect(mockRpc).toHaveBeenCalledWith('attach_group_membership_to_japam', {
      p_group_id: GROUP_ID,
      p_japam_id: JAPAM_ID,
    });
    expect(outcome).toEqual({ kind: 'success' });
  });

  it('maps the already-attached rejection', async () => {
    rpcResult(mockRpc, null, new Error('membership is already attached to a Japam'));
    const outcome = await attachGroupMembershipToJapam(GROUP_ID, JAPAM_ID);
    expect(outcome).toEqual({ kind: 'alreadyAttached' });
  });

  it('surfaces other server errors', async () => {
    rpcResult(mockRpc, null, new Error('not a member of this group'));
    const outcome = await attachGroupMembershipToJapam(GROUP_ID, JAPAM_ID);
    expect(outcome).toEqual({ kind: 'error', message: 'not a member of this group' });
  });
});

describe('getGroupDashboard', () => {
  const todayStart = '2026-07-31T00:00:00.000Z';
  const todayEnd = '2026-08-01T00:00:00.000Z';

  it('passes p_japam_id to get_group_dashboard and maps rows', async () => {
    rpcResult(mockRpc, [
      {
        user_id: USER_ID,
        user_name: 'Ram',
        role: 'admin',
        joined_at: '2026-01-01T00:00:00Z',
        today_malas: 3,
        today_count: 2,
        total_malas: 12,
        total_count: 8,
        last_updated: '2026-07-31T05:00:00.000Z',
      },
    ]);
    const rows = await getGroupDashboard(GROUP_ID, USER_ID, todayStart, todayEnd, JAPAM_ID);
    expect(mockRpc).toHaveBeenCalledWith('get_group_dashboard', {
      p_group_id: GROUP_ID,
      p_current_user_id: USER_ID,
      p_today_start: todayStart,
      p_today_end: todayEnd,
      p_japam_id: JAPAM_ID,
    });
    expect(rows).toEqual([
      {
        userId: USER_ID,
        userName: 'Ram',
        role: 'admin',
        joinedAt: '2026-01-01T00:00:00Z',
        todayMalas: 3,
        todayCount: 2,
        totalMalas: 12,
        totalCount: 8,
        lastUpdated: '2026-07-31T05:00:00.000Z',
      },
    ]);
  });

  it('passes whatever japamId the caller supplies (never silently defaults)', async () => {
    rpcResult(mockRpc, []);
    await getGroupDashboard(GROUP_ID, USER_ID, todayStart, todayEnd, OTHER_JAPAM_ID);
    expect(mockRpc).toHaveBeenCalledWith(
      'get_group_dashboard',
      expect.objectContaining({ p_japam_id: OTHER_JAPAM_ID })
    );
  });
});

jest.mock('../supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    rpc: jest.fn(),
  },
}));

import { supabase } from '../supabase';
import { getGroupDashboard, joinGroupByInviteCode } from '../groupsRepository';

const mockedSupabase = supabase as unknown as {
  auth: { getSession: jest.Mock };
  rpc: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('joinGroupByInviteCode', () => {
  it('requires an authenticated Supabase session before invoking the RPC', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await expect(joinGroupByInviteCode('JOIN123', 'Dev User')).resolves.toEqual({
      kind: 'error',
      message: 'Please sign in before joining a group.',
    });
    expect(mockedSupabase.rpc).not.toHaveBeenCalled();
  });

  it('joins through the RPC without passing a client user ID', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'session-uuid' } } },
      error: null,
    });
    mockedSupabase.rpc.mockResolvedValue({
      data: [{ id: 'group-uuid', name: 'Family', is_active: true, already_member: false }],
      error: null,
    });

    await expect(joinGroupByInviteCode('JOIN123', 'Dev User')).resolves.toEqual({
      kind: 'joined',
      groupId: 'group-uuid',
      groupName: 'Family',
    });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith('join_group_by_invite_code', {
      p_invite_code: 'JOIN123',
      p_user_name: 'Dev User',
    });
  });

  it('treats an already-member RPC result as a successful idempotent join', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'session-uuid' } } },
      error: null,
    });
    mockedSupabase.rpc.mockResolvedValue({
      data: [{ id: 'group-uuid', name: 'Family', is_active: true, already_member: true }],
      error: null,
    });

    await expect(joinGroupByInviteCode('JOIN123', 'Dev User')).resolves.toMatchObject({
      kind: 'joined',
      groupId: 'group-uuid',
    });
  });

  it('handles invalid and inactive invite-code results safely', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'session-uuid' } } },
      error: null,
    });
    mockedSupabase.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(joinGroupByInviteCode('BAD', 'Dev User')).resolves.toEqual({ kind: 'notFound' });

    mockedSupabase.rpc.mockResolvedValueOnce({
      data: [{ id: 'group-uuid', name: 'Inactive', is_active: false, already_member: false }],
      error: null,
    });
    await expect(joinGroupByInviteCode('OFF', 'Dev User')).resolves.toEqual({ kind: 'inactive' });
  });
});

describe('getGroupDashboard display-name contract', () => {
  it('keeps the canonical server-resolved name, role, member count, and totals intact', async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        {
          user_id: '63782858-afab-4b60-96bf-34a525d96719',
          user_name: 'Subbarao',
          role: 'member',
          joined_at: '2026-07-12T00:00:00Z',
          today_malas: 2,
          today_count: 216,
          total_malas: 31,
          total_count: 3348,
          last_updated: '2026-07-12T12:00:00Z',
        },
      ],
      error: null,
    });

    const rows = await getGroupDashboard('group-id', 'viewer-id', 'today-start', 'today-end');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: '63782858-afab-4b60-96bf-34a525d96719',
      userName: 'Subbarao',
      role: 'member',
      todayMalas: 2,
      todayCount: 216,
      totalMalas: 31,
      totalCount: 3348,
    });
  });

  it('keeps snapshot fallback names for missing profiles and legacy non-UUID member IDs', async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        {
          user_id: '104462459725571711632',
          user_name: 'Bellam',
          role: 'member',
          joined_at: '2026-07-12T00:00:00Z',
          today_malas: 0,
          today_count: 0,
          total_malas: 0,
          total_count: 0,
          last_updated: null,
        },
        {
          user_id: 'legacy@example.invalid',
          user_name: 'Unknown',
          role: 'member',
          joined_at: '2026-07-12T00:00:00Z',
          today_malas: 0,
          today_count: 0,
          total_malas: 0,
          total_count: 0,
          last_updated: null,
        },
      ],
      error: null,
    });

    const rows = await getGroupDashboard('group-id', 'viewer-id', 'today-start', 'today-end');

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: '104462459725571711632', userName: 'Bellam' }),
        expect.objectContaining({ userId: 'legacy@example.invalid', userName: 'Unknown' }),
      ])
    );
  });
});

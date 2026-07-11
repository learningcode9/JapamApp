jest.mock('../supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    rpc: jest.fn(),
  },
}));

import { supabase } from '../supabase';
import { joinGroupByInviteCode } from '../groupsRepository';

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

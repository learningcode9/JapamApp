const mockRpc = jest.fn();
const mockResolveAuthenticatedSession = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: jest.fn(),
  },
}));

jest.mock('../authLifecycle', () => ({
  resolveAuthenticatedSession: (...args: unknown[]) => mockResolveAuthenticatedSession(...args),
}));

import { getMyGroups } from '../groupsRepository';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getMyGroups authentication guard', () => {
  it('invokes the protected RPC when a session exists', async () => {
    mockResolveAuthenticatedSession.mockResolvedValue({
      kind: 'AUTHENTICATED',
      session: { access_token: 'session-token' },
    });
    mockRpc.mockResolvedValue({
      data: [{
        group_id: 'group-1',
        name: 'Family',
        role: 'admin',
        is_active: true,
        joined_at: '2026-07-20T00:00:00Z',
      }],
      error: null,
    });

    const result = await getMyGroups('user-123');

    expect(mockRpc).toHaveBeenCalledWith('get_my_groups', { p_user_id: 'user-123' });
    expect(result).toEqual({
      kind: 'SUCCESS',
      groups: [{
        groupId: 'group-1',
        name: 'Family',
        role: 'admin',
        isActive: true,
        joinedAt: '2026-07-20T00:00:00Z',
      }],
    });
  });

  it('returns AUTH_REQUIRED locally and never invokes the RPC when the session is missing', async () => {
    mockResolveAuthenticatedSession.mockResolvedValue({ kind: 'AUTH_REQUIRED' });

    const result = await getMyGroups('cached-user-uuid');

    expect(result).toEqual({ kind: 'AUTH_REQUIRED' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

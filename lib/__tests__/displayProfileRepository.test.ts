jest.mock('../supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    rpc: jest.fn(),
  },
}));

import { supabase } from '../supabase';
import {
  resetMyDisplayProfileToProvider,
  upsertMyDisplayProfile,
} from '../displayProfileRepository';

const mockedSupabase = supabase as unknown as {
  auth: { getSession: jest.Mock };
  rpc: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('upsertMyDisplayProfile', () => {
  it('requires an authenticated session before calling the RPC', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await expect(upsertMyDisplayProfile('Bellam', 'manual')).resolves.toEqual({
      kind: 'error',
      message: 'Please sign in before updating your display name.',
    });
    expect(mockedSupabase.rpc).not.toHaveBeenCalled();
  });

  it('calls the self-scoped RPC without accepting or sending a user id', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'session-uuid' } } },
      error: null,
    });
    mockedSupabase.rpc.mockResolvedValue({
      data: [{ user_id: 'session-uuid', display_name: 'Subbarao', name_source: 'manual', updated_at: '2026-07-12T00:00:00Z' }],
      error: null,
    });

    await expect(upsertMyDisplayProfile('Subbarao', 'manual')).resolves.toMatchObject({
      kind: 'updated',
      profile: { userId: 'session-uuid', displayName: 'Subbarao', nameSource: 'manual' },
    });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith('upsert_my_display_profile', {
      p_display_name: 'Subbarao',
      p_name_source: 'manual',
    });
  });

  it('returns controlled RPC errors without a fallback direct table write', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'session-uuid' } } },
      error: null,
    });
    mockedSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'display name must not be empty' } });

    await expect(upsertMyDisplayProfile('', 'provider')).resolves.toEqual({
      kind: 'error',
      message: 'display name must not be empty',
    });
  });

  it('uses a separate self-scoped RPC for an explicit reset to provider ownership', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'session-uuid' } } },
      error: null,
    });
    mockedSupabase.rpc.mockResolvedValue({
      data: [{ user_id: 'session-uuid', display_name: 'Provider Name', name_source: 'provider', updated_at: '2026-07-12T00:00:00Z' }],
      error: null,
    });

    await expect(resetMyDisplayProfileToProvider('Provider Name')).resolves.toMatchObject({
      kind: 'updated',
      profile: { userId: 'session-uuid', displayName: 'Provider Name', nameSource: 'provider' },
    });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith('reset_my_display_profile_to_provider', {
      p_display_name: 'Provider Name',
    });
  });
});

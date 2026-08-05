import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const localUrl = process.env.SUPABASE_LOCAL_URL ?? '';
const anonKey = process.env.SUPABASE_LOCAL_ANON_KEY ?? '';
const serviceRoleKey = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? '';
const isLocalSupabaseConfigured =
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(localUrl)
  && anonKey.length > 0
  && serviceRoleKey.length > 0;

const describeLocalSupabase = isLocalSupabaseConfigured ? describe : describe.skip;

describeLocalSupabase('ensure_default_japam local Supabase integration', () => {
  jest.setTimeout(30_000);

  let admin: SupabaseClient;
  let userId: string | null = null;
  const originalWebSocket = globalThis.WebSocket;

  beforeAll(() => {
    if (!globalThis.WebSocket) {
      globalThis.WebSocket = class {} as unknown as typeof WebSocket;
    }
    admin = createClient(localUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  });

  afterAll(async () => {
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
    if (originalWebSocket) globalThis.WebSocket = originalWebSocket;
    else delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  });

  it('returns one canonical default for two concurrent authenticated RPC calls', async () => {
    const email = `default-japam-${Date.now()}@local.test`;
    const password = `Local-${Date.now()}-password!`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError) throw createError;
    if (!created.user) throw new Error('Local Supabase did not return the test user');
    userId = created.user.id;

    const makeAuthenticatedClient = async () => {
      const client = createClient(localUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return client;
    };

    const [clientA, clientB] = await Promise.all([
      makeAuthenticatedClient(),
      makeAuthenticatedClient(),
    ]);
    const [first, second] = await Promise.all([
      clientA.rpc('ensure_default_japam', { p_user_id: userId }),
      clientB.rpc('ensure_default_japam', { p_user_id: userId }),
    ]);

    if (first.error) throw first.error;
    if (second.error) throw second.error;
    const firstRow = Array.isArray(first.data) ? first.data[0] : first.data;
    const secondRow = Array.isArray(second.data) ? second.data[0] : second.data;
    expect(firstRow?.id).toBeTruthy();
    expect(secondRow?.id).toBe(firstRow?.id);

    const { data: defaults, error: queryError } = await clientA
      .from('japams')
      .select('id,name,archived_at')
      .eq('user_id', userId)
      .eq('name', 'My Japam')
      .is('archived_at', null);
    if (queryError) throw queryError;

    expect(defaults).toHaveLength(1);
    expect(defaults?.[0]?.id).toBe(firstRow?.id);
  });
});

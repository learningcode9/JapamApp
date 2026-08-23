import {
  assertRealSendAuthorized,
  getRealSendAuthorization,
  parseAllowlist,
  parseExcludedEmails,
  isAlwaysExcludedCampaignEmail,
  validateProductionEnv,
  assertProductionReady,
} from '../email/config';

describe('parseAllowlist', () => {
  it('returns null when unset', () => {
    expect(parseAllowlist(undefined)).toBeNull();
  });

  it('returns null for an empty/whitespace string', () => {
    expect(parseAllowlist('')).toBeNull();
    expect(parseAllowlist('   ')).toBeNull();
  });

  it('parses a single address', () => {
    const result = parseAllowlist('user@example.com');
    expect(result?.has('user@example.com')).toBe(true);
  });

  it('parses multiple comma-separated addresses and lowercases them', () => {
    const result = parseAllowlist('User@Example.com, Other@Example.com');
    expect(result?.has('user@example.com')).toBe(true);
    expect(result?.has('other@example.com')).toBe(true);
    expect(result?.size).toBe(2);
  });

  // Fails closed: the var is set (showing intent to restrict) but contains
  // no valid addresses, so falling back to "no restriction" would silently
  // send to everyone — the exact failure mode this feature exists to avoid.
  it('throws when set to only a delimiter', () => {
    expect(() => parseAllowlist(',')).toThrow(/EMAIL_ALLOWLIST/);
  });

  it('throws when set to only delimiters and whitespace', () => {
    expect(() => parseAllowlist(' , , ')).toThrow(/EMAIL_ALLOWLIST/);
  });

  it('still returns null for a genuinely empty/whitespace-only value (not a throw)', () => {
    expect(parseAllowlist('')).toBeNull();
    expect(parseAllowlist('   ')).toBeNull();
  });

  it('ignores stray empty entries as long as at least one valid address remains', () => {
    const result = parseAllowlist('valid@example.com,,  ,');
    expect(result?.size).toBe(1);
    expect(result?.has('valid@example.com')).toBe(true);
  });
});

describe('validateProductionEnv / assertProductionReady', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function setValidEnv() {
    delete process.env.SUPABASE_URL;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM_ADDRESS = 'Japam App <noreply@realdomain.example>';
    process.env.EMAIL_UNSUBSCRIBE_URL = 'https://example.com/unsubscribe';
    process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  }

  it('reports no problems when everything required is set correctly', () => {
    setValidEnv();
    expect(validateProductionEnv()).toEqual([]);
    expect(() => assertProductionReady()).not.toThrow();
  });

  it('accepts Gmail provider credentials without requiring Resend configuration', () => {
    setValidEnv();
    process.env.EMAIL_PROVIDER = 'gmail';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
    process.env.GMAIL_CLIENT_ID = 'client-id-test';
    process.env.GMAIL_CLIENT_SECRET = 'client-secret-test';
    process.env.GMAIL_REFRESH_TOKEN = 'refresh-token-test';
    process.env.GMAIL_SENDER_EMAIL = 'mantrajapamapp@gmail.com';

    expect(validateProductionEnv()).toEqual([]);
  });

  it('flags a missing RESEND_API_KEY', () => {
    setValidEnv();
    delete process.env.RESEND_API_KEY;
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('RESEND_API_KEY'))).toBe(true);
  });

  it('flags a missing EMAIL_FROM_ADDRESS', () => {
    setValidEnv();
    delete process.env.EMAIL_FROM_ADDRESS;
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('EMAIL_FROM_ADDRESS is not set'))).toBe(true);
  });

  it('flags EMAIL_FROM_ADDRESS still pointing at the confirmed-NXDOMAIN default', () => {
    setValidEnv();
    process.env.EMAIL_FROM_ADDRESS = 'Japam App <noreply@japamapp.com>';
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('japamapp.com'))).toBe(true);
  });

  it('flags a missing EMAIL_UNSUBSCRIBE_URL', () => {
    setValidEnv();
    delete process.env.EMAIL_UNSUBSCRIBE_URL;
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('EMAIL_UNSUBSCRIBE_URL'))).toBe(true);
  });

  it('flags a missing EMAIL_UNSUBSCRIBE_SECRET', () => {
    setValidEnv();
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('EMAIL_UNSUBSCRIBE_SECRET'))).toBe(true);
  });

  it('flags missing Supabase credentials', () => {
    setValidEnv();
    process.env.EXPO_PUBLIC_SUPABASE_URL = '';
    process.env.SUPABASE_URL = '';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('SUPABASE_URL'))).toBe(true);
    expect(problems.some(p => p.includes('SUPABASE_SERVICE_ROLE_KEY'))).toBe(true);
  });

  it('assertProductionReady throws with every problem listed, not just the first', () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
    delete process.env.EMAIL_UNSUBSCRIBE_URL;
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => assertProductionReady()).toThrow(/RESEND_API_KEY[\s\S]*EMAIL_FROM_ADDRESS/);
  });
});

describe('parseExcludedEmails', () => {
  it('returns an empty set when unset or whitespace-only', () => {
    expect(parseExcludedEmails(undefined).size).toBe(0);
    expect(parseExcludedEmails(' ,  , ')).toEqual(new Set());
  });

  it('trims and matches excluded addresses case-insensitively', () => {
    const result = parseExcludedEmails(' Reviewer@Example.com, internal@example.com ');
    expect(result).toEqual(new Set(['reviewer@example.com', 'internal@example.com']));
  });

  it('uses exact addresses and does not exclude unrelated recipients', () => {
    const result = parseExcludedEmails('reviewer@example.com');
    expect(result.has('reviewer@example.com')).toBe(true);
    expect(result.has('reviewer+other@example.com')).toBe(false);
    expect(result.has('other@example.com')).toBe(false);
  });
});

describe('permanent campaign domain exclusion', () => {
  it('matches only the exact cloudtestlabaccounts.com domain', () => {
    expect(isAlwaysExcludedCampaignEmail('tester@cloudtestlabaccounts.com')).toBe(true);
    expect(isAlwaysExcludedCampaignEmail('tester@CLOUDTESTLABACCOUNTS.COM')).toBe(true);
    expect(isAlwaysExcludedCampaignEmail('tester@cloudtestlabaccounts.com.example')).toBe(false);
    expect(isAlwaysExcludedCampaignEmail('tester@example.com')).toBe(false);
  });
});

describe('shared real-send authorization', () => {
  function env(values: Record<string, string | undefined>) {
    return (name: string) => values[name];
  }

  const base = {
    EMAIL_ALLOWLIST: 'learningcode9@gmail.com',
    EMAIL_CONTROLLED_RECIPIENT: 'learningcode9@gmail.com',
  };

  it('authorizes the existing controlled mode only for the hashed recipient', async () => {
    const result = await getRealSendAuthorization(env({ ...base, EMAIL_SEND_MODE: 'controlled' }));

    expect(result).toMatchObject({ mode: 'controlled', authorized: true });
    expect(result.allowlist).toEqual(new Set(['learningcode9@gmail.com']));
  });

  it('authorizes production mode only with the exact confirmation', async () => {
    const result = await getRealSendAuthorization(env({
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
    }));

    expect(result).toMatchObject({ mode: 'production', authorized: true, allowlist: null });
  });

  it('allows production mode to narrow delivery with a valid allowlist', async () => {
    const result = await getRealSendAuthorization(env({
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
      EMAIL_ALLOWLIST: 'Narrow@Example.com',
    }));

    expect(result.authorized).toBe(true);
    expect(result.allowlist).toEqual(new Set(['narrow@example.com']));
  });

  it('fails closed for a missing or invalid send mode', async () => {
    await expect(getRealSendAuthorization(env(base))).resolves.toMatchObject({
      mode: null,
      authorized: false,
    });
    await expect(getRealSendAuthorization(env({ ...base, EMAIL_SEND_MODE: 'all' }))).resolves.toMatchObject({
      mode: null,
      authorized: false,
    });
  });

  it('fails closed when production confirmation is missing or not exact', async () => {
    const values = { EMAIL_SEND_MODE: 'production' };
    await expect(getRealSendAuthorization(env(values))).resolves.toMatchObject({
      mode: 'production',
      authorized: false,
    });
    await expect(getRealSendAuthorization(env({
      ...values,
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS ',
    }))).resolves.toMatchObject({ authorized: false });
  });

  it('fails closed for malformed or invalid allowlist entries', async () => {
    await expect(getRealSendAuthorization(env({
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
      EMAIL_ALLOWLIST: 'not-an-email',
    }))).resolves.toMatchObject({ authorized: false });
    await expect(getRealSendAuthorization(env({
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
      EMAIL_ALLOWLIST: ',',
    }))).resolves.toMatchObject({ authorized: false });
    await expect(getRealSendAuthorization(env({
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
      EMAIL_ALLOWLIST: '   ',
    }))).resolves.toMatchObject({ authorized: false });
  });

  it('does not treat duplicate controlled entries as exactly one recipient', async () => {
    await expect(getRealSendAuthorization(env({
      ...base,
      EMAIL_SEND_MODE: 'controlled',
      EMAIL_ALLOWLIST: 'learningcode9@gmail.com,learningcode9@gmail.com',
    }))).resolves.toMatchObject({ authorized: false });
  });

  it('uses the same fail-closed guard for CLI real sends', async () => {
    await expect(assertRealSendAuthorized(env({
      EMAIL_SEND_MODE: 'production',
    }))).rejects.toThrow(/EMAIL_PRODUCTION_CONFIRMATION/);
    await expect(assertRealSendAuthorized(env({
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
    }))).resolves.toBeUndefined();
  });
});

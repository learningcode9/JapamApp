import { parseAllowlist, validateProductionEnv, assertProductionReady } from '../email/config';

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
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM_ADDRESS = 'Japam App <noreply@realdomain.example>';
    process.env.EMAIL_UNSUBSCRIBE_URL = 'https://example.com/unsubscribe';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  }

  it('reports no problems when everything required is set correctly', () => {
    setValidEnv();
    expect(validateProductionEnv()).toEqual([]);
    expect(() => assertProductionReady()).not.toThrow();
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

  it('flags missing Supabase credentials', () => {
    setValidEnv();
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const problems = validateProductionEnv();
    expect(problems.some(p => p.includes('SUPABASE_URL'))).toBe(true);
    expect(problems.some(p => p.includes('SUPABASE_SERVICE_ROLE_KEY'))).toBe(true);
  });

  it('assertProductionReady throws with every problem listed, not just the first', () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
    delete process.env.EMAIL_UNSUBSCRIBE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => assertProductionReady()).toThrow(/RESEND_API_KEY[\s\S]*EMAIL_FROM_ADDRESS/);
  });
});

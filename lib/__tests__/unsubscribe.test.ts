import { buildUnsubscribeEndpoint } from '../unsubscribe';

describe('buildUnsubscribeEndpoint', () => {
  it('uses the Supabase function while preserving the signed token', () => {
    expect(buildUnsubscribeEndpoint('https://project.supabase.co/', 'signed.token')).toBe(
      'https://project.supabase.co/functions/v1/unsubscribe-email?token=signed.token',
    );
  });

  it('URL-encodes tokens safely', () => {
    expect(buildUnsubscribeEndpoint('https://project.supabase.co', 'signed token')).toContain(
      'token=signed+token',
    );
  });
});

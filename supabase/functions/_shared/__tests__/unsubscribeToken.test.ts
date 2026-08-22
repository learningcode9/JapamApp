import {
  buildUnsubscribeUrl,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../email/unsubscribeToken';

describe('unsubscribe tokens', () => {
  const USER_ID = 'user-123';
  const SECRET = 'local-only-test-secret';
  const NOW = Date.parse('2026-08-16T00:00:00.000Z');

  it('round-trips a signed token and wires it into the URL', async () => {
    const token = await createUnsubscribeToken(USER_ID, SECRET, NOW, 3600);
    expect(await verifyUnsubscribeToken(token, SECRET, NOW)).toBe(USER_ID);

    const url = await buildUnsubscribeUrl(
      'http://127.0.0.1:54321/functions/v1/unsubscribe-email?source=campaign',
      USER_ID,
      SECRET,
      NOW,
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/functions/v1/unsubscribe-email');
    expect(parsed.searchParams.get('source')).toBe('campaign');
    expect(await verifyUnsubscribeToken(parsed.searchParams.get('token')!, SECRET, NOW)).toBe(USER_ID);
  });

  it('rejects tampered, expired, and wrong-secret tokens', async () => {
    const token = await createUnsubscribeToken(USER_ID, SECRET, NOW, 60);
    const [payload, signature] = token.split('.');
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(await verifyUnsubscribeToken(tampered, SECRET, NOW)).toBeNull();
    expect(await verifyUnsubscribeToken(token, SECRET, NOW + 61_000)).toBeNull();
    expect(await verifyUnsubscribeToken(token, 'wrong-secret', NOW)).toBeNull();
  });
});

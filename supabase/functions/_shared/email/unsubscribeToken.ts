const TOKEN_VERSION = 'v1';
export const DEFAULT_UNSUBSCRIBE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer as ArrayBuffer;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('EMAIL_UNSUBSCRIBE_SECRET is required');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function payloadFor(userId: string, expiresAt: number): string {
  if (!userId || userId.includes('|')) throw new Error('userId must be non-empty and contain no pipe characters');
  return `${TOKEN_VERSION}|${userId}|${expiresAt}`;
}

/** Creates a signed, expiring token. The secret never appears in the token. */
export async function createUnsubscribeToken(
  userId: string,
  secret: string,
  now = Date.now(),
  ttlSeconds = DEFAULT_UNSUBSCRIBE_TOKEN_TTL_SECONDS,
): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive integer');
  }

  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const payload = payloadFor(userId, expiresAt);
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${encodeBase64Url(new TextEncoder().encode(payload))}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Returns the authenticated user ID, or null for an invalid/expired token. */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  try {
    const [encodedPayload, encodedSignature] = token.split('.');
    if (!encodedPayload || !encodedSignature || token.split('.').length !== 2) return null;

    const payload = new TextDecoder().decode(decodeBase64Url(encodedPayload));
    const [version, userId, expiresAtText] = payload.split('|');
    const expiresAt = Number(expiresAtText);
    if (
      version !== TOKEN_VERSION ||
      !userId ||
      userId.includes('|') ||
      !Number.isInteger(expiresAt) ||
      expiresAt < Math.floor(now / 1000)
    ) {
      return null;
    }

    const key = await importSigningKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(payload),
    );
    return valid ? userId : null;
  } catch {
    return null;
  }
}

export async function buildUnsubscribeUrl(
  baseUrl: string,
  userId: string,
  secret: string,
  now?: number,
): Promise<string> {
  if (!baseUrl) throw new Error('EMAIL_UNSUBSCRIBE_URL is required');
  const url = new URL(baseUrl);
  url.searchParams.set('token', await createUnsubscribeToken(userId, secret, now));
  return url.toString();
}

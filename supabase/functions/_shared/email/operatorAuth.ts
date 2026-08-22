/**
 * Supabase's verify_jwt=true gateway verifies the JWT signature. This helper
 * adds the operator-only role check without logging or returning claims.
 */
export function isOperatorAuthorization(request: Request): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization) return false;

  const match = authorization.match(/^Bearer ([^\s]+)$/);
  if (!match) return false;

  const tokenParts = match[1].split('.');
  if (tokenParts.length !== 3 || !tokenParts[1]) return false;

  try {
    const encodedPayload = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (encodedPayload.length % 4)) % 4);
    const payload = JSON.parse(atob(encodedPayload + padding)) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

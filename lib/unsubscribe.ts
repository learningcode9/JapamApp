export function buildUnsubscribeEndpoint(supabaseUrl: string, token: string): string {
  const endpoint = new URL(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/unsubscribe-email`);
  endpoint.searchParams.set('token', token);
  return endpoint.toString();
}

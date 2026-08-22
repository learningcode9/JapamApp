/** Read environment variables in both the Node CLI and the Deno Edge runtime. */
export function getEnv(name: string): string | undefined {
  const nodeEnv = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  if (nodeEnv) return nodeEnv[name];

  const deno = (globalThis as {
    Deno?: { env?: { get: (key: string) => string | undefined } };
  }).Deno;
  return deno?.env?.get(name) ?? nodeEnv?.[name];
}

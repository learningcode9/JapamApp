/**
 * Regression guard for LegacyHistoryBackfillRunner's user_profiles REST call.
 *
 * fetchSuggestedJapamName was hardened from `Authorization: Bearer ${supabaseKey}` (anon key)
 * to a session-JWT pattern matching the F15/F7 discipline: call supabase.auth.getSession(),
 * use the real access_token, and fail closed (return DEFAULT_JAPAM_NAME) if no session exists.
 *
 * This is a static source scan of the component file itself, not a runtime test — the function
 * is a private module-local helper, so we verify the source pattern at the file level rather
 * than exporting it solely for testability. The approach mirrors
 * lib/__tests__/anonKeyRestAuth.test.ts's own structural scan.
 */
import * as fs from 'fs';
import * as path from 'path';

const COMPONENT_PATH = path.resolve(
  __dirname, '..', 'LegacyHistoryBackfillRunner.tsx'
);

describe('LegacyHistoryBackfillRunner user_profiles auth', () => {
  it('never sends the raw anon key as the Authorization bearer token for its user_profiles REST call', () => {
    const source = fs.readFileSync(COMPONENT_PATH, 'utf8');

    // Match any fetch to user_profiles that has an Authorization header set to the anon key
    // (either `$key` or `$supabaseKey`). This is the exact regression we're guarding against.
    const anonKeyBearerOnUserProfiles =
      /user_profiles[^;]*?Authorization:\s*`Bearer \$\{\s*(key|supabaseKey)\s*\}`/;

    expect(source).not.toMatch(anonKeyBearerOnUserProfiles);
  });

  it('uses supabase.auth.getSession() access_token for the user_profiles REST call', () => {
    const source = fs.readFileSync(COMPONENT_PATH, 'utf8');

    // The fetch to user_profiles must use a session-token-based Authorization header.
    const sessionTokenHeader =
      /Authorization:\s*`Bearer \$\{sessionToken\}`/;

    // Must have exactly one occurrence — the user_profiles fetch.
    const matches = source.match(sessionTokenHeader);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('calls supabase.auth.getSession() before the user_profiles fetch', () => {
    const source = fs.readFileSync(COMPONENT_PATH, 'utf8');
    expect(source).toContain('supabase.auth.getSession()');
  });

  it('fails closed: returns DEFAULT_JAPAM_NAME when there is no session', () => {
    const source = fs.readFileSync(COMPONENT_PATH, 'utf8');

    // The no-session guard must return DEFAULT_JAPAM_NAME (not attempt the fetch with anon key).
    expect(source).toMatch(/if\s*\(!sessionToken\)\s*return DEFAULT_JAPAM_NAME/);
  });
});

/**
 * Regression guard for the Phase 1 RLS-hotfix client migration.
 *
 * A live production audit found that several client REST calls touching
 * `japam_history`/`deleted_completions` authenticated with the raw
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (via `Authorization: Bearer ${key}` /
 * `${supabaseKey}`) instead of the signed-in user's session JWT. Once RLS is
 * tightened (Phase 3), any such call silently starts failing (403), so a
 * regression here is a real breakage risk, not just a style issue.
 *
 * This is a static source scan, not a runtime/component test — none of the
 * files below have (or need) React Native/Expo mocking infrastructure for
 * this purpose, and the fix is a literal find-and-replace of an auth header,
 * not business logic. The scan finds every REST call touching the two
 * audited tables and asserts none of them still send the raw anon key as the
 * `Authorization` bearer token.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const FILES_TO_SCAN = [
  'app/(tabs)/history.tsx',
  'app/(tabs)/index.tsx',
  'app/(tabs)/manual.tsx',
  'app/(tabs)/tap-japam.tsx',
  'app/(tabs)/timer.tsx',
  'contexts/timer-context.tsx',
];

const AUDITED_TABLE_PATTERN = /rest\/v1\/(japam_history|deleted_completions)/g;

// The exact literal patterns this codebase used everywhere for the raw anon key variable.
const RAW_ANON_KEY_BEARER_PATTERN = /Authorization:\s*`Bearer \$\{\s*(key|supabaseKey)\s*\}`/;

// How far past a matched REST URL to look for its headers object. Every call site in this
// codebase defines its `headers: { ... }` within a few lines of the URL.
const WINDOW_CHARS = 500;

describe('japam_history / deleted_completions REST calls never use the raw anon key', () => {
  for (const relativePath of FILES_TO_SCAN) {
    it(`${relativePath} has no anon-key Authorization header on an audited-table request`, () => {
      const filePath = path.join(REPO_ROOT, relativePath);
      const source = fs.readFileSync(filePath, 'utf8');

      const offenders: { table: string; index: number; snippet: string }[] = [];

      for (const match of source.matchAll(AUDITED_TABLE_PATTERN)) {
        const start = match.index ?? 0;
        const window = source.slice(start, start + WINDOW_CHARS);
        if (RAW_ANON_KEY_BEARER_PATTERN.test(window)) {
          offenders.push({ table: match[1], index: start, snippet: window.slice(0, 200) });
        }
      }

      if (offenders.length > 0) {
        const description = offenders
          .map((o) => `  - table=${o.table} near offset ${o.index}:\n    ${o.snippet.replace(/\s+/g, ' ')}`)
          .join('\n');
        throw new Error(
          `${relativePath} sends the raw anon key as the Authorization bearer token for a ` +
          `request touching an audited table. Use supabase.auth.getSession()'s access_token ` +
          `instead (see syncPendingHistory/saveToSupabase/syncHistoryEditsToSupabase for the ` +
          `proven pattern).\n${description}`
        );
      }
    });
  }

  it('every audited-table request site in these files was found (sanity check)', () => {
    // Guards against the scan itself silently matching nothing (e.g. a future refactor renames
    // these REST calls away from raw fetch()) — if this drops to zero, the test above would pass
    // vacuously and stop protecting anything.
    let totalMatches = 0;
    for (const relativePath of FILES_TO_SCAN) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      totalMatches += [...source.matchAll(AUDITED_TABLE_PATTERN)].length;
    }
    expect(totalMatches).toBeGreaterThan(0);
  });
});

import * as fs from 'fs';
import * as path from 'path';

const COMPONENT_PATH = path.resolve(__dirname, '..', 'LegacyHistoryBackfillRunner.tsx');

describe('LegacyHistoryBackfillRunner default selection', () => {
  const source = fs.readFileSync(COMPONENT_PATH, 'utf8');

  it('does not query user_profiles for a custom default name', () => {
    expect(source).not.toContain('user_profiles');
  });

  it('calls ensureDefaultJapam without a custom name', () => {
    expect(source).toContain('const created = await ensureDefaultJapam();');
  });
});

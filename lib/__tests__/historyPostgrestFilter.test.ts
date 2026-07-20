import fs from 'fs';
import path from 'path';

const historySource = fs.readFileSync(
  path.join(__dirname, '../../app/(tabs)/history.tsx'),
  'utf8'
);

describe('History PostgREST fetch filter', () => {
  it('does not enable fetch cache busting on the remote history query', () => {
    const fetchRemoteSessions = historySource.slice(
      historySource.indexOf('const fetchRemoteSessions'),
      historySource.indexOf('const saveToSupabase')
    );

    expect(fetchRemoteSessions).not.toMatch(/cache:\s*['"](?:no-store|no-cache)['"]/);
  });
});

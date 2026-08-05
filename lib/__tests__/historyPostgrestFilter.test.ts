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

  it('does not request user_email from japam_history', () => {
    const sources = [
      historySource,
      fs.readFileSync(path.join(__dirname, '../../app/(tabs)/timer.tsx'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../../app/(tabs)/tap-japam.tsx'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../../app/(tabs)/index.tsx'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).not.toMatch(/(?:rest\/v1\/japam_history[^\n]*|select:\s*['"][^'"]*)user_email/);
    }
  });
});

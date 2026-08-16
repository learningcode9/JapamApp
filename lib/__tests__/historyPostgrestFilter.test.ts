import fs from 'fs';
import path from 'path';

const historySource = fs.readFileSync(
  path.join(__dirname, '../../app/(tabs)/history.tsx'),
  'utf8'
);
const indexSource = fs.readFileSync(
  path.join(__dirname, '../../app/(tabs)/index.tsx'),
  'utf8'
);
const tapSource = fs.readFileSync(
  path.join(__dirname, '../../app/(tabs)/tap-japam.tsx'),
  'utf8'
);
const historyRepositorySource = fs.readFileSync(
  path.join(__dirname, '../historyRepository.ts'),
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

  it('requests user_email only where the restore mapper consumes it', () => {
    const restoreProjection = 'created_at,malas,count,user_name,user_email,completion_id,japam_id,japam_name';
    expect(indexSource).toContain(`select: '${restoreProjection}'`);
    expect(tapSource).toContain(`select: '${restoreProjection}'`);

    const sources = [
      historySource,
      fs.readFileSync(path.join(__dirname, '../../app/(tabs)/timer.tsx'), 'utf8'),
      historyRepositorySource,
    ];

    for (const source of sources) {
      expect(source).not.toMatch(/(?:rest\/v1\/japam_history[^\n]*|select:\s*['"][^'"]*)user_email/);
    }
  });
});

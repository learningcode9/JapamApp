import fs from 'fs';
import path from 'path';

const historySource = fs.readFileSync(
  path.join(__dirname, '../../app/(tabs)/history.tsx'),
  'utf8'
);
const historyRepositorySource = fs.readFileSync(
  path.join(__dirname, '../historyRepository.ts'),
  'utf8'
);

describe('History PostgREST fetch filter', () => {
  it('disables browser caching on the remote history query', () => {
    expect(historyRepositorySource).toMatch(
      /rest\/v1\/japam_history[\s\S]{0,800}cache:\s*['"]no-store['"]/,
    );
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

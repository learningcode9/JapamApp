import fs from 'node:fs';
import path from 'node:path';

const repoFile = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const screens = [
  'app/(tabs)/index.tsx',
  'app/(tabs)/timer.tsx',
  'app/(tabs)/tap-japam.tsx',
];

describe('web Google nonce flow usage', () => {
  it('all three web flows use the shared nonce helper', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toContain("from '../../lib/webGoogleNonce'");
      expect(source).toContain('savePendingWebGoogleNonce');
      expect(source).toContain('readPendingWebGoogleNonce');
      expect(source).toContain('clearPendingWebGoogleNonce');
    });
  });

  it('persists the raw nonce before promptAsync on every web flow', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/savePendingWebGoogleNonce\(rawNonceRef\.current\)[\s\S]*promptAsync\(\{ showInRecents: true \}\)/);
    });
  });

  it('uses the persisted nonce in signInWithIdToken instead of the in-memory nonce', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toContain('const persistedNonce = await readPendingWebGoogleNonce();');
      expect(source).toContain('nonce: persistedNonce,');
      expect(source).not.toContain('nonce: rawNonceRef.current,');
    });
  });

  it('rejects missing persisted nonce and never silently falls back to a new nonce', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/if \(!persistedNonce\) \{[\s\S]*showGoogleSignInRequiredAlert\(\);[\s\S]*return;/);
      const missingNonceBlock = source.match(/if \(!persistedNonce\) \{([\s\S]*?)\n\s*\}/);
      expect(missingNonceBlock?.[1]).toBeTruthy();
      expect(missingNonceBlock?.[1]).not.toContain('rawNonceRef.current');
    });
  });

  it('clears the persisted nonce after success and on terminal failures', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      const clearCount = (source.match(/clearPendingWebGoogleNonce\(/g) || []).length;
      expect(clearCount).toBeGreaterThanOrEqual(3);
      expect(source).toMatch(/web session established[\s\S]*clearPendingWebGoogleNonce\(\)/);
    });
  });

  it('initializes nonceReady as true on non-web platforms', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toContain('useState(Platform.OS !== \'web\')');
    });
  });

  it('guards responseType with nonceReady to prevent IdToken request before nonce exists', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/responseType: Platform\.OS === 'web' && nonceReady \? ResponseType\.IdToken : undefined/);
    });
  });

  it('guards extraParams.nonce with nonceReady so Google never receives a missing/wrong nonce', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/extraParams: Platform\.OS === 'web' && nonceReady \? \{ nonce: hashedNonce \} : undefined/);
    });
  });

  it('Google receives hashed nonce (not raw nonce) in extraParams', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      const extraMatch = source.match(/extraParams:.*nonce: hashedNonce/);
      expect(extraMatch).toBeTruthy();
      expect(source).not.toMatch(/extraParams:.*nonce: rawNonce/);
    });
  });

  it('Supabase receives raw nonce (not hashed nonce) in signInWithIdToken', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/nonce: persistedNonce,/);
      expect(source).not.toMatch(/nonce: hashedNonce,/);
    });
  });

  it('disables sign-in button until nonceReady and request are available', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/disabled=\{Platform\.OS === 'web' && \(!request \|\| !nonceReady\)\}/);
    });
  });

  it('sets nonceReady to true after SHA-256 hash computation completes', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toMatch(/setNonceReady\(true\);/);
      expect(source).toMatch(/setHashedNonce\(hashed\);\s*\n\s*setNonceReady\(true\);/);
    });
  });
});

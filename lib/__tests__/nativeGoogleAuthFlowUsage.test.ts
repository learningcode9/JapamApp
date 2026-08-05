import fs from 'node:fs';
import path from 'node:path';

const repoFile = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const screens = [
  'app/(tabs)/index.tsx',
  'app/(tabs)/timer.tsx',
  'app/(tabs)/tap-japam.tsx',
];

describe('native Google auth flow usage', () => {
  it('all native Google flows use the shared strict session helper', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).toContain("from '../../lib/nativeGoogleAuth'");
      expect(source).toContain('signInWithGoogleIdTokenAndStoreIdentity');
    });
  });

  it('no native Google flow falls back to the provider Google user id for USER_ID_KEY', () => {
    screens.forEach((screen) => {
      const source = repoFile(screen);
      expect(source).not.toContain('supabaseUuid ?? googleUserId');
      expect(source).not.toContain('session?.user?.id ?? googleUserId');
    });
  });
});

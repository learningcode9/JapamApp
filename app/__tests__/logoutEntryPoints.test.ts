import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('logout entry point wiring', () => {
  it('Settings logout and Exit Guest Mode use the shared logout flow', () => {
    const source = read('app/(tabs)/settings.tsx');

    expect(source).toContain("import { runSharedLogoutFlow } from '../../lib/sharedLogout';");
    expect(source).toMatch(/const logout = async \(\) => \{[\s\S]*await runSharedLogoutFlow\(/);
    expect(source).toMatch(/const clearGuestData = \(\) => \{[\s\S]*await runSharedLogoutFlow\(/);
  });

  it('Home logout uses the shared logout flow', () => {
    const source = read('app/(tabs)/index.tsx');

    expect(source).toContain("import { runSharedLogoutFlow } from '../../lib/sharedLogout';");
    expect(source).toMatch(/const performLogout = async \(\) => \{[\s\S]*await runSharedLogoutFlow\(/);
  });

  it('Tap Japam logout uses the shared logout flow', () => {
    const source = read('app/(tabs)/tap-japam.tsx');

    expect(source).toContain("import { runSharedLogoutFlow } from '../../lib/sharedLogout';");
    expect(source).toMatch(/const performLogout = async \(\) => \{[\s\S]*await runSharedLogoutFlow\(/);
  });

  it('Timer does not own a visible logout path and routes signed-in users to Settings', () => {
    const source = read('app/(tabs)/timer.tsx');

    expect(source).not.toContain('const performLogout');
    expect(source).not.toContain('const handleLogout');
    expect(source).toMatch(/const handleAccountPress = \(\) => \{[\s\S]*router\.push\('\/settings' as never\);[\s\S]*\};/);
  });
});

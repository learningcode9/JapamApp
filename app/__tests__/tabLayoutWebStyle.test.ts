import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../(tabs)/_layout.tsx'), 'utf8');
const webStyleBlock = source.slice(source.indexOf('const webTabBarStyle'), source.indexOf('const tabLabel'));
const nativeStyleBlock = source.slice(source.indexOf('const nativeTabBarStyle'), source.indexOf('const tabBarStyle'));

describe('web tab bar layout', () => {
  it('keeps the web tab bar fixed, centered, and above screen content', () => {
    expect(webStyleBlock).toMatch(/position: 'fixed'/);
    expect(webStyleBlock).toMatch(/bottom: 'calc\(12px \+ env\(safe-area-inset-bottom\)\)'/);
    expect(webStyleBlock).toMatch(/left: '50%'/);
    expect(webStyleBlock).toMatch(/transform: 'translateX\(-50%\)'/);
    expect(webStyleBlock).toMatch(/zIndex: 999/);
  });

  it('leaves native tab-bar positioning on the absolute/inset path', () => {
    expect(nativeStyleBlock).toMatch(/position: 'absolute'/);
    expect(nativeStyleBlock).toMatch(/zIndex: 999/);
  });
});

import { describe, expect, it } from 'vitest';
import { commonTail, pathSegments, samePath } from './paths';

describe('samePath', () => {
  it('compares Unicode NFC forms, ignoring case only where volumes do', () => {
    const decomposed = '/Volumes/E\u0301te\u0301';
    expect(samePath('/Volumes/Été', decomposed, false)).toBe(true);
    expect(samePath('/Volumes/ÉTÉ', decomposed, false)).toBe(false);
    expect(samePath('/Volumes/ÉTÉ', decomposed, true)).toBe(true);
    expect(samePath('/Volumes/Été', '/Volumes/Été/2024', true)).toBe(false);
  });
});

describe('pathSegments', () => {
  it('splits on the separators of the platform the path was written on', () => {
    expect(pathSegments('/Users/seb/Pictures/', 'darwin')).toEqual(['Users', 'seb', 'Pictures']);
    expect(pathSegments('/srv/a\\b', 'linux')).toEqual(['srv', 'a\\b']);
    expect(pathSegments('C:\\Users\\seb/Pictures', 'win32')).toEqual([
      'C:',
      'Users',
      'seb',
      'Pictures',
    ]);
    expect(pathSegments('\\\\nas\\photos', 'win32')).toEqual(['nas', 'photos']);
  });
});

describe('commonTail', () => {
  it('counts the trailing segments both paths share', () => {
    expect(commonTail(['a', 'Pictures', '2024', 'x.jpg'], ['b', 'Photos', '2024', 'x.jpg'])).toBe(
      2,
    );
    expect(commonTail(['2024', 'x.jpg'], ['old', '2024', 'x.jpg'])).toBe(2);
    expect(commonTail(['x.jpg'], ['y.jpg'])).toBe(0);
    expect(commonTail([], ['x.jpg'])).toBe(0);
  });
});

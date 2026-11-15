import { hasTerm, holdsTagOrText, toggleTerm } from './query-terms';

describe('query terms', () => {
  it('finds a whole term, ignoring case, but not inside quotes, other terms or negations', () => {
    expect(hasTerm('beach IS:Untagged', 'is:untagged')).toBe(true);
    expect(hasTerm('is:untagged', 'is:untagged')).toBe(true);
    expect(hasTerm('-is:untagged', 'is:untagged')).toBe(false);
    expect(hasTerm('"summer is:untagged"', 'is:untagged')).toBe(false);
    expect(hasTerm('is:untaggedness', 'is:untagged')).toBe(false);
    expect(hasTerm('', 'is:untagged')).toBe(false);
  });

  it('tells a query that compares names of tags, by a tag: term or free text, from others', () => {
    for (const query of [
      'tag:France',
      'T:Paris,Lyon type:image',
      '-tag:=draft',
      'beach',
      '-beach is:untagged',
      '"summer trip"',
      'camera:canon',
      '"is:untagged"',
    ]) {
      expect(holdsTagOrText(query)).toBe(true);
    }
    for (const query of [
      '',
      '  ',
      'is:untagged',
      'IS:Untagged -is:missing',
      'type:video ext:mp4,mov size:>10mb',
      'in:"C:/My Photos" folder:/Volumes/Archive path:Trips',
      'kind:photo format:jpg is:',
    ]) {
      expect(holdsTagOrText(query)).toBe(false);
    }
  });

  it('appends a missing term, keeping the rest of the query', () => {
    expect(toggleTerm('', 'is:untagged')).toBe('is:untagged');
    expect(toggleTerm('  ', 'is:untagged')).toBe('is:untagged');
    expect(toggleTerm('"summer trip"  type:image', 'is:untagged')).toBe(
      '"summer trip" type:image is:untagged',
    );
  });

  it('removes every copy of a present term, whatever its case', () => {
    expect(toggleTerm('is:untagged', 'is:untagged')).toBe('');
    expect(toggleTerm('beach Is:Untagged type:image is:untagged', 'is:untagged')).toBe(
      'beach type:image',
    );
  });

  it('leaves a byte order mark out, as the search does', () => {
    expect(hasTerm('is:un\uFEFFtagged', 'is:untagged')).toBe(true);
    expect(toggleTerm('tag:Pa\uFEFFris', 'is:untagged')).toBe('tag:Paris is:untagged');
    expect(toggleTerm('\uFEFFis:untagged', 'is:untagged')).toBe('');
  });
});

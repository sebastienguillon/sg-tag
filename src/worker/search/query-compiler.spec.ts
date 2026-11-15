import type { SortOrder } from '@shared/model';
import { describe, expect, it } from 'vitest';
import { createTestLibrary } from '../testing/test-library';
import type { CompiledQuery } from './query-compiler';
import { compileQuery } from './query-compiler';
import { parseQuery } from './query-parser';

const NEWEST: SortOrder = { field: 'modified', direction: 'desc' };

function compile(query: string): CompiledQuery {
  return compileQuery(parseQuery(query), NEWEST, { offlineRootIds: [] });
}

describe('compileQuery', () => {
  it('binds the names of a tag term as one parameter, without letter case or accents', () => {
    expect(compile('tag:France').params).toEqual(['["france"]']);
    expect(compile('tag:ÉTÉ,"New  York",Trips/2024').params).toEqual([
      '["ete","new york","trips/2024"]',
    ]);
    // The names without `=` first, then those with it, whatever their order in the term.
    expect(compile('tag:=France,Paris,=Rome,Tokyo').params).toEqual([
      '["paris","tokyo"]',
      '["france","rome"]',
    ]);
  });

  it('binds what is compared with the names of tags without the characters nobody sees', () => {
    // A soft hyphen and zero-width spaces, as a paste from a web page brings them.
    expect(compile('tag:Pa\u00ADris,=\u200BLyon\u200B').params).toEqual(['["paris"]', '["lyon"]']);
    // Free text is compared without them too, with the names of files and with those of tags; and
    // with the names of files as typed as well, since a name on disk may hold one.
    expect(compile('Pa\u00ADris').params).toEqual(['"Paris"', '"Pa\u00ADris"', '%paris%']);
    // Under 3 characters once they are left out, names and folders are searched with LIKE.
    expect(compile('pa\u200B').params).toEqual(['%pa%', '%pa%', '"pa\u200B"', '%pa%']);
    // The statement of a text that holds none is the one it always was.
    expect(compile('Paris').params).toEqual(['"Paris"', '%paris%']);
    // Nothing is left of a term made of them alone: a name that no tag has, and a pattern that no
    // name matches rather than one that every name does.
    expect(compile('tag:\u200B,=\u2060').params).toEqual(['[""]', '[""]']);
    expect(compile('\u200B\u00AD\u2060').params).toEqual(['"\u200B\u00AD\u2060"', '']);
  });

  it('writes the same statement whatever the number of names in a tag term', () => {
    expect(compile('tag:France,Paris,"New York",Tokyo').sql).toBe(compile('tag:France').sql);
    expect(compile('tag:=France,=Paris,=Tokyo').sql).toBe(compile('tag:=France').sql);
    expect(compile('tag:=France,Paris,=Rome,Tokyo').sql).toBe(compile('tag:Paris,=France').sql);
    expect(compile('-tag:France,Paris').sql).toBe(compile('-tag:France').sql);
  });

  it('walks the tags below only for the names without `=`', () => {
    expect(compile('tag:France').sql).toContain('WITH RECURSIVE');
    expect(compile('tag:=France').sql).not.toContain('WITH RECURSIVE');
    expect(compile('tag:=France,Paris').sql).toContain('WITH RECURSIVE');
  });

  it('keeps each tag once while it walks the tags below, which ends the walk on a loop', () => {
    // With `UNION ALL` a loop of parent links is walked for ever inside SQLite, where nothing can
    // stop it: the search of such a library would hang, and so would its test, instead of failing.
    expect(compile('tag:France').sql).not.toContain('UNION ALL');
    expect(compile('france').sql).not.toContain('UNION ALL');
  });

  it('builds the set of files of a tag term or of free text once, not again for each file', () => {
    const { db } = createTestLibrary();
    const plan = ({ sql, params }: CompiledQuery): string[] =>
      db
        .prepare<(string | number)[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((step) => step.detail);
    // What SQLite reads the tags of files (`ft`) by, in each step of the plan that reads them.
    const tagReads = (steps: readonly string[]): string[] =>
      steps.filter((step) => /\bft\b/.test(step));

    // The control: of a subquery it runs for each file, this SQLite says so, and that it reads the
    // tags of that file.
    const perFile = plan({
      sql: `SELECT f.id FROM files f
            WHERE (SELECT COUNT(*) FROM file_tags ft WHERE ft.file_id = f.id) > 0`,
      params: [],
    });
    expect(perFile).toContainEqual(expect.stringContaining('CORRELATED'));
    expect(tagReads(perFile)).toEqual([expect.stringContaining('(file_id=?)')]);

    for (const query of [
      'tag:France',
      '-tag:France',
      'tag:=France',
      '-tag:=France',
      'tag:France,=Paris',
      '-tag:France,=Paris',
      'france',
      '-france',
      'fr',
      '-fr',
      'tag:France tag:Paris -tag:=Rome france fr',
    ]) {
      const steps = plan(compile(query));
      expect(
        steps.filter((step) => step.includes('CORRELATED')),
        query,
      ).toEqual([]);
      // Read by tag, from the tags found: never the tags of one file after another.
      expect(tagReads(steps), query).not.toEqual([]);
      for (const read of tagReads(steps)) {
        expect(read, query).toMatch(
          /^SEARCH ft USING (COVERING )?INDEX file_tags_tag \(tag_id=\?\)$/,
        );
      }
    }
  });
});

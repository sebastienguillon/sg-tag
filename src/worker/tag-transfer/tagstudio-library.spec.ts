import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TagStudioLibrary } from './tagstudio-library';
import { readTagStudioLibrary, rewrite, segmentsOf } from './tagstudio-library';
import type { Fixture } from '../testing/tagstudio-library';
import { makeTagStudioLibrary } from '../testing/tagstudio-library';

const NOT_A_LIBRARY =
  'This folder is not a TagStudio library: choose the folder that holds its .TagStudio folder.';
const CANNOT_READ = 'Cannot read this TagStudio library.';

describe('readTagStudioLibrary', () => {
  let dir: string;
  let folder: string;
  let copies: string;

  const makeLibrary = (fixture?: Fixture): Promise<string> => makeTagStudioLibrary(folder, fixture);

  const read = (
    chosen = folder,
    signal = new AbortController().signal,
  ): Promise<TagStudioLibrary> =>
    readTagStudioLibrary(chosen, { copiesDir: copies, signal, onProgress: () => undefined });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-tagstudio-'));
    folder = path.join(dir, 'Library');
    copies = path.join(dir, 'imports');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads tags, aliases, shorthands, parent tags and tagged files', async () => {
    await makeLibrary({
      tags: [
        { id: 1000, name: 'Paris', shorthand: 'PAR' },
        { id: 1001, name: 'France' },
        { id: 1002, name: 'Unused' },
      ],
      aliases: [[1000, 'Paname']],
      parents: [[1000, 1001]],
      files: [
        { id: 1, path: 'Trips/eiffel.jpg', tags: [1000] },
        { id: 2, path: 'top.png', tags: [1000, 1001] },
      ],
    });

    const { parsed, details } = await read();

    expect(parsed.header).toEqual({
      app: 'TagStudio',
      exportedAt: expect.any(String) as string,
      platform: process.platform,
      roots: [folder],
    });
    // Each name first, so that a name always wins over another tag's alias.
    expect(parsed.definitions).toEqual([
      { name: 'Paris', aliases: [], parents: [] },
      { name: 'France', aliases: [], parents: [] },
      { name: 'Unused', aliases: [], parents: [] },
      { name: 'Paris', aliases: ['Paname', 'PAR'], parents: ['France'] },
    ]);
    expect(parsed.entries).toEqual([
      {
        root: 0,
        segments: ['Trips', 'eiffel.jpg'],
        path: path.join(folder, 'Trips', 'eiffel.jpg'),
        size: 0,
        mtimeMs: null,
        fingerprint: null,
        sha256: null,
        missing: false,
        tags: ['Paris'],
      },
      expect.objectContaining({ segments: ['top.png'], tags: ['Paris', 'France'] }),
    ]);
    expect(parsed.tagCount).toBe(3);
    expect([...parsed.tags.values()]).toEqual(['Paris', 'France']);
    expect(parsed.invalid).toBe(0);
    expect(details).toEqual({
      version: 102,
      renamed: 0,
      renamedItems: [],
      leftOut: {
        colors: 0,
        icons: 0,
        categories: 0,
        hidden: 0,
        fields: 0,
        // Archived, Favorite and Meta Tags, which no file has.
        builtIn: 3,
        broken: 0,
        otherFolders: 0,
      },
    });
  });

  it('reads the library when its .TagStudio folder is chosen', async () => {
    await makeLibrary({
      tags: [{ id: 1000, name: 'Paris' }],
      files: [{ id: 1, path: 'a.jpg', tags: [1000] }],
    });

    const { parsed } = await read(path.join(folder, '.TagStudio'));

    expect(parsed.header.roots).toEqual([folder]);
    expect(parsed.entries[0]?.path).toBe(path.join(folder, 'a.jpg'));
  });

  it('copies the database, leaves it as it was, and deletes the copy', async () => {
    const file = await makeLibrary({ tags: [{ id: 1000, name: 'Paris' }] });
    await mkdir(copies, { recursive: true });
    // Left by a reading that never ended.
    await writeFile(path.join(copies, 'tagstudio-old.sqlite'), 'old');
    await writeFile(path.join(copies, 'keep.txt'), 'not a copy');
    const before = await readFile(file);

    await read();

    expect(await readFile(file)).toEqual(before);
    expect(await readdir(path.join(folder, '.TagStudio'))).toEqual(['ts_library.sqlite']);
    expect(await readdir(copies)).toEqual(['keep.txt']);
  });

  it('refuses a folder that holds no TagStudio library, and says why', async () => {
    await mkdir(folder, { recursive: true });
    await expect(read()).rejects.toThrow(NOT_A_LIBRARY);

    await mkdir(path.join(folder, '.TagStudio'));
    await writeFile(path.join(folder, '.TagStudio', 'ts_library.json'), '{}');
    await expect(read()).rejects.toThrow(
      'This TagStudio library was saved by TagStudio 9.4 or earlier. Open it once in a recent ' +
        'TagStudio, which converts it, then import it again.',
    );
  });

  it('refuses a file that is not a database, and versions it cannot read', async () => {
    await mkdir(path.join(folder, '.TagStudio'), { recursive: true });
    await writeFile(path.join(folder, '.TagStudio', 'ts_library.sqlite'), 'not a database');
    await expect(read()).rejects.toThrow(CANNOT_READ);

    await makeLibrary({ version: 5, tags: [{ id: 1000, name: 'Paris' }] });
    await expect(read()).rejects.toThrow(
      'This TagStudio library was saved by a test version of TagStudio: it cannot be read.',
    );

    await makeLibrary({ version: 500, tags: [{ id: 1000, name: 'Paris' }] });
    await expect(read()).rejects.toThrow(
      'This TagStudio library was saved by a newer version of TagStudio than SG Tag can read.',
    );
  });

  it.each([
    [6, 'before parent links were turned round, with no table of versions'],
    [100, 'with no table of versions'],
    [103, 'with hidden tags'],
    [300, 'with no folders'],
    [400, 'at the newest version'],
  ])('reads version %i, %s', async (version) => {
    await makeLibrary({
      version,
      tags: [
        { id: 1000, name: 'Paris', hidden: true },
        { id: 1001, name: 'France' },
      ],
      parents: [[1000, 1001]],
      files: [{ id: 1, path: 'a.jpg', tags: [1000] }],
    });

    const { parsed, details } = await read();

    expect(details.version).toBe(version);
    expect(parsed.definitions).toContainEqual({ name: 'Paris', aliases: [], parents: ['France'] });
    expect(parsed.entries.map((entry) => entry.tags)).toEqual([['Paris']]);
    // Hidden tags come over as ordinary tags; versions before 103 had none.
    expect(details.leftOut.hidden).toBe(version >= 103 ? 1 : 0);
  });

  describe('built-in tags', () => {
    it('brings Archived and Favorite only when used, and never Meta Tags', async () => {
      await makeLibrary({
        tags: [{ id: 1000, name: 'Paris' }],
        files: [{ id: 1, path: 'a.jpg', tags: [0, 2, 1000] }],
      });

      const { parsed, details } = await read();

      // Archived, with its alias; its link to Meta Tags is left out.
      expect(parsed.definitions).toEqual([
        { name: 'Archived', aliases: [], parents: [] },
        { name: 'Paris', aliases: [], parents: [] },
        { name: 'Archived', aliases: ['Archive'], parents: [] },
      ]);
      expect(parsed.entries[0]?.tags).toEqual(['Archived', 'Paris']);
      // Version 102 has no hidden tags: Archived is hidden from version 103 on.
      expect(details.leftOut).toMatchObject({ builtIn: 2, hidden: 0, colors: 1, categories: 0 });
    });

    it('brings a built-in tag that a tag that comes over has as a parent tag', async () => {
      await makeLibrary({ tags: [{ id: 1000, name: 'Best' }], parents: [[1000, 1]] });

      const { parsed } = await read();

      expect(parsed.definitions).toContainEqual({
        name: 'Best',
        aliases: [],
        parents: ['Favorite'],
      });
      expect(parsed.definitions).toContainEqual({
        name: 'Favorite',
        aliases: ['Favorited', 'Favorites'],
        parents: [],
      });
    });
  });

  describe('names', () => {
    it('rewrites names and aliases a tag cannot have here, and lists them', async () => {
      await makeLibrary({
        builtIns: false,
        tags: [
          { id: 1000, name: 'Paris, France' },
          { id: 1001, name: 'The "Best"' },
          { id: 1002, name: '=Equal' },
          { id: 1003, name: `Tab${String.fromCodePoint(1)}here` },
          // Nothing left once rewritten.
          { id: 1004, name: ',,' },
        ],
        aliases: [[1000, 'Diversity, Equity, and Inclusion']],
        files: [{ id: 1, path: 'a.jpg', tags: [1000, 1004] }],
      });

      const { parsed, details } = await read();

      expect(parsed.definitions.map((definition) => definition.name)).toEqual([
        'Paris France',
        "The 'Best'",
        'Equal',
        'Tab here',
        'Paris France',
      ]);
      expect(parsed.definitions.at(-1)?.aliases).toEqual(['Diversity Equity and Inclusion']);
      expect(parsed.entries[0]?.tags).toEqual(['Paris France']);
      expect(details.renamed).toBe(6);
      expect(details.renamedItems).toEqual([
        { from: 'Paris, France', to: 'Paris France', why: 'characters' },
        { from: 'The "Best"', to: "The 'Best'", why: 'characters' },
        { from: '=Equal', to: 'Equal', why: 'characters' },
        { from: `Tab${String.fromCodePoint(1)}here`, to: 'Tab here', why: 'characters' },
        { from: ',,', to: null, why: 'characters' },
        {
          from: 'Diversity, Equity, and Inclusion',
          to: 'Diversity Equity and Inclusion',
          why: 'characters',
        },
      ]);
    });

    it('makes one tag of tags of one name and the same parent tags', async () => {
      await makeLibrary({
        builtIns: false,
        tags: [
          { id: 1000, name: 'Trips' },
          { id: 1001, name: '2024' },
          { id: 1002, name: '2024' },
        ],
        aliases: [[1002, 'Last year']],
        parents: [
          [1001, 1000],
          [1002, 1000],
        ],
        files: [
          { id: 1, path: 'a.jpg', tags: [1001] },
          { id: 2, path: 'b.jpg', tags: [1001, 1002] },
        ],
      });

      const { parsed, details } = await read();

      expect(parsed.definitions).toEqual([
        { name: 'Trips', aliases: [], parents: [] },
        { name: '2024', aliases: [], parents: [] },
        { name: '2024', aliases: [], parents: [] },
        { name: '2024', aliases: [], parents: ['Trips'] },
        { name: '2024', aliases: ['Last year'], parents: ['Trips'] },
      ]);
      expect(parsed.entries.map((entry) => entry.tags)).toEqual([['2024'], ['2024']]);
      expect(parsed.tagCount).toBe(2);
      expect(details.renamed).toBe(0);
    });

    it('tells apart tags of one name with other parent tags', async () => {
      await makeLibrary({
        builtIns: false,
        tags: [
          { id: 1000, name: 'Japan' },
          { id: 1001, name: 'Trips' },
          { id: 1002, name: 'Work' },
          { id: 1003, name: '2024' },
          // Its disambiguation parent comes first.
          { id: 1004, name: '2024', disambiguation: 1002 },
          { id: 1005, name: '2024' },
          // `2024 (Japan)` is taken by an alias: the next parent tag.
          { id: 1006, name: '2024' },
          { id: 1007, name: 'Other' },
          // Every parent tag taken: numbered.
          { id: 1008, name: '2024' },
        ],
        aliases: [[1007, '2024 (Japan)']],
        parents: [
          [1004, 1000],
          [1004, 1002],
          [1005, 1001],
          [1006, 1000],
          [1006, 1007],
          [1008, 1001],
          [1008, 1002],
        ],
        files: [{ id: 1, path: 'a.jpg', tags: [1003, 1004, 1005, 1006, 1008] }],
      });

      const { parsed, details } = await read();

      expect(parsed.entries[0]?.tags).toEqual([
        '2024',
        '2024 (Work)',
        '2024 (Trips)',
        '2024 (Other)',
        '2024 (Trips) (2)',
      ]);
      expect(details.renamedItems).toEqual([
        { from: '2024', to: '2024 (Work)', why: 'sameName' },
        { from: '2024', to: '2024 (Trips)', why: 'sameName' },
        { from: '2024', to: '2024 (Other)', why: 'sameName' },
        { from: '2024', to: '2024 (Trips) (2)', why: 'sameName' },
      ]);
    });

    it('lists an alias that another tag has: applying the definitions leaves it out', async () => {
      await makeLibrary({
        builtIns: false,
        tags: [
          { id: 1000, name: 'Minnesota' },
          { id: 1001, name: 'USA' },
        ],
        aliases: [[1000, 'USA']],
      });

      const { parsed } = await read();

      // The tag named USA comes first: the alias given after it is another tag's name.
      expect(parsed.definitions).toEqual([
        { name: 'Minnesota', aliases: [], parents: [] },
        { name: 'USA', aliases: [], parents: [] },
        { name: 'Minnesota', aliases: ['USA'], parents: [] },
      ]);
    });
  });

  it('counts what does not come over', async () => {
    await makeLibrary({
      version: 103,
      builtIns: false,
      tags: [
        { id: 1000, name: 'Paris', color: 'blue', icon: 'star', hidden: true },
        { id: 1001, name: 'Places', category: true },
      ],
      aliases: [[9999, 'Orphan']],
      parents: [
        [1000, 9999],
        [9998, 1001],
      ],
      folders: [1, 2],
      files: [
        { id: 1, path: 'a.jpg', tags: [1000, 9999] },
        { id: 2, path: 'b.jpg', tags: [1000], folder: 2 },
        { id: 3, path: '../outside.jpg', tags: [1000] },
      ],
      fields: 4,
      sql: 'INSERT INTO tag_entries VALUES (1000, 77)',
    });

    const { parsed, details } = await read();

    expect(parsed.entries.map((entry) => entry.segments)).toEqual([['a.jpg']]);
    expect(parsed.invalid).toBe(1);
    expect(parsed.problems).toEqual(['File 3: its path cannot be read.']);
    expect(details.leftOut).toEqual({
      colors: 1,
      icons: 1,
      categories: 1,
      hidden: 1,
      fields: 4,
      builtIn: 0,
      // The alias, the two links, the tag of file 1 and the row of file 77.
      broken: 5,
      otherFolders: 1,
    });
  });

  it('refuses a library with nothing to import', async () => {
    await makeLibrary();
    await expect(read()).rejects.toThrow('This TagStudio library has no tag to import.');
  });

  it('runs no code of the file: views and generated columns are refused', async () => {
    await makeLibrary({
      builtIns: false,
      sql: `
        ALTER TABLE tag_aliases RENAME TO real_aliases;
        CREATE VIEW tag_aliases AS SELECT * FROM real_aliases;`,
    });
    await expect(read()).rejects.toThrow(CANNOT_READ);

    await makeLibrary({
      builtIns: false,
      tags: [{ id: 1000, name: 'Paris' }],
      sql: `ALTER TABLE tags ADD COLUMN big BLOB GENERATED ALWAYS AS (zeroblob(1000)) VIRTUAL;`,
    });
    await expect(read()).rejects.toThrow(CANNOT_READ);
  });

  it('stops when canceled, and deletes the copy', async () => {
    await makeLibrary({ tags: [{ id: 1000, name: 'Paris' }] });
    const controller = new AbortController();
    const reason = new Error('Canceled.');
    controller.abort(reason);

    await expect(read(folder, controller.signal)).rejects.toBe(reason);
    expect(await readdir(copies).catch(() => [])).toEqual([]);
  });
});

describe('segmentsOf', () => {
  it('splits a path as TagStudio writes it', () => {
    expect(segmentsOf('Trips/2024/a.jpg', 'linux')).toEqual(['Trips', '2024', 'a.jpg']);
    expect(segmentsOf('back\\slash.jpg', 'linux')).toEqual(['back\\slash.jpg']);
  });

  it.each(['', '/a.jpg', 'a//b.jpg', '../a.jpg', 'a/./b.jpg', 'a\0.jpg'])(
    'refuses %j, which names no file within the folder',
    (rel) => {
      expect(segmentsOf(rel, 'linux')).toBeNull();
    },
  );

  it('refuses on Windows what would lead elsewhere', () => {
    expect(segmentsOf('a\\..\\..\\b.jpg', 'win32')).toBeNull();
    expect(segmentsOf('C:/b.jpg', 'win32')).toBeNull();
  });
});

describe('rewrite', () => {
  it('takes out what a name cannot hold', () => {
    expect(rewrite('a,b')).toBe('a b');
    expect(rewrite('"quoted"')).toBe("'quoted'");
    expect(rewrite(' == x')).toBe('x');
    expect(rewrite(`a${String.fromCodePoint(0x202e)}b`)).toBe('ab');
  });
});

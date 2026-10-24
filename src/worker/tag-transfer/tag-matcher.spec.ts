import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawl, statFiles } from '../indexer/crawler';
import { fingerprint, FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import { Reconciler } from '../indexer/reconciler';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { SLICE_BUDGET_MS } from './slices';
import type { ImportEntry, ParsedTagFile } from './tag-file';
import { endLine, entryLine, headerLine, readTagFile } from './tag-file';
import type { MatchOptions, MatchResult } from './tag-matcher';
import { matchEntries, MTIME_TOLERANCE_MS } from './tag-matcher';

/** Size of every file unless a case says otherwise: they are all compared with each other. */
const SIZE = 1_000;
/** Modification time of every file unless a case says otherwise. */
const MTIME = 1_700_000_000_000;
/** Well after `MTIME`: the dates tell nothing. */
const LATER = MTIME + 60_000;

/** The fingerprint of a file holding `content`. */
const printOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 32);
const hashOf = (content: string): string => createHash('sha256').update(content).digest('hex');

/** A file of a tags export made from `/a/Pictures`, holding `content`. */
const entry = (rel: string, content: string, fields: Partial<ImportEntry> = {}): ImportEntry => ({
  root: 0,
  segments: rel.split('/'),
  path: `/a/Pictures/${rel}`,
  size: SIZE,
  mtimeMs: MTIME,
  fingerprint: printOf(content),
  sha256: null,
  missing: false,
  tags: ['t'],
  ...fields,
});

/** A tags export of `entries`, made on a computer of `platform` whose library folders were `roots`. */
const exportOf = (
  entries: readonly ImportEntry[],
  roots = ['/a/Pictures'],
  platform = 'darwin',
): ParsedTagFile => ({
  header: { app: null, exportedAt: null, platform, roots },
  entries,
  invalid: 0,
  problems: [],
  tagCount: 1,
});

/** How each entry was found, and the path of the file found. */
const outcomesOf = (result: MatchResult): string[] =>
  result.outcomes.map((outcome) => {
    switch (outcome.kind) {
      case 'notFound':
        return `notFound: ${outcome.reason}`;
      case 'changed':
        return `changed ${outcome.target.path}`;
      default:
        return `${outcome.kind}${outcome.shared ? ' (shared)' : ''} ${outcome.target.path}`;
    }
  });

interface PutOptions {
  readonly size?: number;
  readonly mtimeMs?: number;
  /** Its fingerprint is stored, as for most files once indexing has settled (the default). */
  readonly printed?: boolean;
  /** Its SHA-256 is stored, as after Find duplicates. */
  readonly hashed?: boolean;
  /** Missing from disk. */
  readonly missing?: boolean;
}

describe.each([true, false])(
  'matchEntries, names in any case naming one file: %s',
  (caseInsensitive) => {
    let dir: string;
    let library: TestLibrary;
    let offline: Set<number>;
    /** Fingerprints of the files on disk, by path: what `read` finds there. */
    let disk: Map<string, string>;
    let read: Mock<MatchOptions['read']>;

    /** Indexes a file holding `content` at `rel` in `root`, and returns its id. */
    const put = (
      root: RootRecord,
      rel: string,
      content: string,
      options: PutOptions = {},
    ): number => {
      const missing = options.missing === true;
      const id = library.addFile(rel, {
        root,
        size: options.size ?? SIZE,
        mtimeMs: options.mtimeMs ?? MTIME,
        ...(options.printed === false ? {} : { fingerprint: printOf(content) }),
        ...(options.hashed === true ? { contentHash: hashOf(content) } : {}),
        ...(missing ? { missingSince: 1 } : {}),
      });
      if (!missing) {
        disk.set(`${root.path}/${rel}`, printOf(content));
      }
      return id;
    };
    const match = (
      parsed: ParsedTagFile,
      options: Partial<MatchOptions> = {},
    ): Promise<MatchResult> =>
      matchEntries(parsed, {
        files: library.files,
        roots: library.roots.list(),
        isOnline: (rootId) => !offline.has(rootId),
        caseInsensitive,
        read,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        ...options,
      });

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-match-'));
      library = createTestLibrary();
      offline = new Set();
      disk = new Map();
      read = vi.fn((target) => {
        const print = disk.get(target.path);
        return print === undefined
          ? Promise.reject(new Error('Cannot read it.'))
          : Promise.resolve(print);
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    });

    describe('with files on disk', () => {
      const file = (relative: string): string => path.join(dir, ...relative.split('/'));
      const write = async (relative: string, content: string): Promise<void> => {
        await mkdir(path.dirname(file(relative)), { recursive: true });
        await writeFile(file(relative), content);
      };
      const index = async (into: TestLibrary, root: RootRecord): Promise<void> => {
        await new Reconciler(into.files).syncRoot(root, await statFiles(await crawl(root.path)));
      };
      /**
       * Tags every file of `from` and exports them as the exporter does, fingerprints of present
       * files read first, then reads the tags export back as an import does.
       */
      const exportFrom = async (from: TestLibrary): Promise<ParsedTagFile> => {
        const roots = from.roots.list();
        const ids = roots.flatMap((root) => from.files.idsForRoot(root.id));
        from.tags.addToFiles(ids, ['trips']);
        for (const target of from.files.needingFingerprint(ids)) {
          from.files.setFingerprint(target, await fingerprint(target.path, target.size));
        }
        const rows = from.files.taggedPage(0, 1_000);
        const tags = from.tags.pathsForFiles(rows.map((row) => row.id));
        const exported = path.join(dir, 'tags.jsonl');
        await writeFile(
          exported,
          [
            headerLine({
              app: null,
              exportedAt: null,
              platform: process.platform,
              fingerprint: FINGERPRINT_SCHEME,
              roots: roots.map((root) => root.path),
            }),
            ...rows.map((row) =>
              entryLine(
                row,
                roots.findIndex((root) => root.id === row.rootId),
                tags.get(row.id) ?? [],
              ),
            ),
            endLine(rows.length),
          ].join(''),
        );
        return readTagFile(exported, {
          signal: new AbortController().signal,
          onBytes: () => undefined,
        });
      };
      /** How each entry was found, by its path in its library folder. */
      const outcomesByRel = (
        parsed: ParsedTagFile,
        result: MatchResult,
      ): Record<string, string> => {
        const outcomes = outcomesOf(result);
        return Object.fromEntries(
          parsed.entries.map((each, at) => [each.segments.join('/'), outcomes[at] ?? '']),
        );
      };

      beforeEach(() => {
        read.mockImplementation((target) => fingerprint(target.path, target.size));
      });

      it('finds every file at its place on the same computer, reading nothing', async () => {
        const root = library.roots.insert(file('Pictures'));
        await write('Pictures/a.jpg', 'a');
        await write('Pictures/2024/b.jpg', 'b');
        await write('Pictures/2024/b copy.jpg', 'b');
        await write('Pictures/gone.jpg', 'gone');
        await index(library, root);
        await rm(file('Pictures/gone.jpg'));
        await index(library, root);

        const parsed = await exportFrom(library);
        expect(outcomesByRel(parsed, await match(parsed))).toEqual({
          'a.jpg': `samePlace ${file('Pictures/a.jpg')}`,
          '2024/b.jpg': `samePlace ${file('Pictures/2024/b.jpg')}`,
          '2024/b copy.jpg': `samePlace ${file('Pictures/2024/b copy.jpg')}`,
          'gone.jpg': `samePlace ${file('Pictures/gone.jpg')}`,
        });
        expect(read).not.toHaveBeenCalled();
      });

      it('finds a library folder copied to another path with its dates, reading nothing', async () => {
        const from = createTestLibrary();
        const pictures = from.roots.insert(file('a/Pictures'));
        await write('a/Pictures/x.jpg', 'x');
        await write('a/Pictures/2024/y.jpg', 'y');
        await index(from, pictures);
        const parsed = await exportFrom(from);
        await cp(file('a/Pictures'), file('b/Photos'), {
          recursive: true,
          preserveTimestamps: true,
        });
        const photos = library.roots.insert(file('b/Photos'));
        await index(library, photos);

        const result = await match(parsed);
        expect(outcomesByRel(parsed, result)).toEqual({
          'x.jpg': `samePlace ${file('b/Photos/x.jpg')}`,
          '2024/y.jpg': `samePlace ${file('b/Photos/2024/y.jpg')}`,
        });
        expect(read).not.toHaveBeenCalled();
        expect(result.folders[parsed.header.roots.indexOf(pictures.path)]).toEqual({
          exported: pictures.path,
          files: 2,
          found: 2,
          foundIn: [photos.path],
          inLibrary: false,
          suspicious: false,
        });
      });

      it('reads each file of their size once when dates changed, and keeps what it read', async () => {
        const from = createTestLibrary();
        const pictures = from.roots.insert(file('a/Pictures'));
        await write('a/Pictures/x.jpg', 'xxxx');
        await write('a/Pictures/y.jpg', 'yyyy');
        await index(from, pictures);
        const parsed = await exportFrom(from);
        await cp(file('a/Pictures'), file('b/Photos'), { recursive: true });
        for (const name of ['x.jpg', 'y.jpg']) {
          await utimes(file(`b/Photos/${name}`), new Date(), new Date(2_000_000_000_000));
        }
        const photos = library.roots.insert(file('b/Photos'));
        await index(library, photos);

        const result = await match(parsed);
        expect(outcomesByRel(parsed, result)).toEqual({
          'x.jpg': `samePlace ${file('b/Photos/x.jpg')}`,
          'y.jpg': `samePlace ${file('b/Photos/y.jpg')}`,
        });
        expect(read.mock.calls.map(([target]) => target.path).sort()).toEqual([
          file('b/Photos/x.jpg'),
          file('b/Photos/y.jpg'),
        ]);
        expect(result.reads).toBe(2);
        for (const name of ['x.jpg', 'y.jpg']) {
          expect(library.files.findByPath(file(`b/Photos/${name}`))?.fingerprint).toBe(
            await fingerprint(file(`a/Pictures/${name}`), 4),
          );
        }
      });

      it('finds a file renamed since the export by its fingerprint', async () => {
        const root = library.roots.insert(file('Pictures'));
        await write('Pictures/a.jpg', 'a');
        await write('Pictures/b.jpg', 'b');
        await index(library, root);
        const parsed = await exportFrom(library);
        await mkdir(file('Pictures/2024'));
        await rename(file('Pictures/a.jpg'), file('Pictures/2024/renamed.jpg'));
        await index(library, root);

        expect(outcomesByRel(parsed, await match(parsed))).toEqual({
          'a.jpg': `moved ${file('Pictures/2024/renamed.jpg')}`,
          'b.jpg': `samePlace ${file('Pictures/b.jpg')}`,
        });
        expect(read).not.toHaveBeenCalled();
      });

      it('finds a file at its place whose name is decomposed on disk', async () => {
        const composed = '\u00c9t\u00e9.jpg';
        const decomposed = 'E\u0301te\u0301.jpg';
        expect(decomposed).not.toBe(composed);
        expect(decomposed.normalize('NFC')).toBe(composed);
        const root = library.roots.insert(file('Pictures'));
        await write('Pictures/a.jpg', 'a');
        await write('Pictures/b.jpg', 'b');
        await write(`Pictures/${decomposed}`, 'summer');
        // The disk keeps the name as written: otherwise this would check nothing.
        expect(await readdir(file('Pictures'))).toContain(decomposed);
        await index(library, root);
        const parsed = await exportFrom(library);
        expect(outcomesByRel(parsed, await match(parsed))[composed]).toBe(
          `samePlace ${file(`Pictures/${decomposed}`)}`,
        );

        // Edited since: still found at its place, in a folder its other files confirm.
        await write(`Pictures/${decomposed}`, 'summer, edited');
        await index(library, root);
        expect(outcomesByRel(parsed, await match(parsed))[composed]).toBe(
          `changed ${file(`Pictures/${decomposed}`)}`,
        );
      });
    });

    it('takes the same name and size, modified within 2 s, as the same file without reading it', async () => {
      const photos = library.roots.insert('/b/Photos');
      put(photos, 'a.jpg', 'a', { mtimeMs: MTIME + MTIME_TOLERANCE_MS, printed: false });
      put(photos, 'b.jpg', 'b', { mtimeMs: MTIME - MTIME_TOLERANCE_MS - 1, printed: false });

      const result = await match(
        exportOf([
          entry('a.jpg', 'a', { fingerprint: null }),
          entry('b.jpg', 'b', { fingerprint: null }),
        ]),
      );
      expect(outcomesOf(result)).toEqual(['samePlace /b/Photos/a.jpg', 'notFound: notFound']);
      expect(read).not.toHaveBeenCalled();
    });

    it('reads nothing for a library folder copied with its dates beside a copy of its files in another layout', async () => {
      // On another computer, just indexed: nothing is fingerprinted yet.
      const pictures = library.roots.insert('/b/Pictures');
      const backup = library.roots.insert('/Volumes/Backup');
      const entries: ImportEntry[] = [];
      for (let index = 0; index < 3; index++) {
        const rel = `2024/0${index}/IMG_${index}.JPG`;
        const mtimeMs = MTIME + index * 10_000;
        put(pictures, rel, rel, { printed: false, mtimeMs });
        put(backup, `All/IMG_${index}.JPG`, rel, { printed: false, mtimeMs });
        entries.push(entry(rel, rel, { mtimeMs }));
      }

      const result = await match(exportOf(entries));
      expect(outcomesOf(result)).toEqual([
        'samePlace /b/Pictures/2024/00/IMG_0.JPG',
        'samePlace /b/Pictures/2024/01/IMG_1.JPG',
        'samePlace /b/Pictures/2024/02/IMG_2.JPG',
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it('finds files at their very path in a library folder replaced by its parent, reading nothing, before a mirror of the old one', async () => {
      // Exported from `/Volumes/Photos/2024`, which was then replaced by its parent: library folders
      // do not nest.
      const names = ['a', 'b', 'c', 'd'];
      const entries = names.map((name) =>
        entry(`Trip/${name}.jpg`, name, { path: `/Volumes/Photos/2024/Trip/${name}.jpg` }),
      );
      // Just indexed, its files are fingerprinted or not yet. A mirror of the old folder is a
      // library folder too, added before or after it, or is not.
      for (const printed of [false, true]) {
        for (const [folders, mirror] of [
          [['/Volumes/Photos'], {}],
          // Fingerprinted long ago.
          [['/Volumes/Backup/2024', '/Volumes/Photos'], {}],
          [['/Volumes/Photos', '/Volumes/Backup/2024'], {}],
          // Copied without its dates, not fingerprinted yet.
          [['/Volumes/Backup/2024', '/Volumes/Photos'], { printed: false, mtimeMs: LATER }],
        ] as const) {
          library = createTestLibrary();
          read.mockClear();
          for (const folder of folders) {
            const root = library.roots.insert(folder);
            for (const name of names) {
              if (folder === '/Volumes/Photos') {
                put(root, `2024/Trip/${name}.jpg`, name, { printed });
              } else {
                put(root, `Trip/${name}.jpg`, name, mirror);
              }
            }
          }

          // Made on this computer's system: paths from another one are never taken as its own.
          const result = await match(exportOf(entries, ['/Volumes/Photos/2024'], process.platform));
          expect(outcomesOf(result)).toEqual(
            names.map((name) => `samePlace /Volumes/Photos/2024/Trip/${name}.jpg`),
          );
          expect(result.folders[0]?.foundIn).toEqual(['/Volumes/Photos']);
          expect(read).not.toHaveBeenCalled();
        }
      }
    });

    it('goes by content when another file is at the place and the file itself elsewhere', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      const other = put(pictures, '2024/a.jpg', 'another photo');
      put(pictures, 'old/a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'c.jpg', 'c');

      const result = await match(
        exportOf([entry('2024/a.jpg', 'a'), entry('b.jpg', 'b'), entry('c.jpg', 'c')]),
      );
      expect(outcomesOf(result)).toEqual([
        'moved /a/Pictures/old/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'samePlace /a/Pictures/c.jpg',
      ]);
      expect(
        result.outcomes.some((outcome) => 'target' in outcome && outcome.target.id === other),
      ).toBe(false);
    });

    it('lists an identical copy in another folder as moved, never as at the same place', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, '2024/x.jpg', 'x, edited');
      put(pictures, 'Originals/2024/x.jpg', 'x');
      const entries = [entry('a.jpg', 'a'), entry('b.jpg', 'b'), entry('2024/x.jpg', 'x')];

      expect(outcomesOf(await match(exportOf(entries)))).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'moved /a/Pictures/Originals/2024/x.jpg',
      ]);

      // The copy is in the tags export too: the file at the place is the one edited since.
      expect(
        outcomesOf(await match(exportOf([...entries, entry('Originals/2024/x.jpg', 'x')]))),
      ).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/2024/x.jpg',
        'samePlace /a/Pictures/Originals/2024/x.jpg',
      ]);

      // Under another path, a file whose path merely ends the same way was moved too.
      library = createTestLibrary();
      const photos = library.roots.insert('/b/Photos');
      put(photos, 'a.jpg', 'a');
      put(photos, 'b.jpg', 'b');
      put(photos, 'Trips/2024/x.jpg', 'x');
      expect(outcomesOf(await match(exportOf(entries)))).toEqual([
        'samePlace /b/Photos/a.jpg',
        'samePlace /b/Photos/b.jpg',
        'moved /b/Photos/Trips/2024/x.jpg',
      ]);
    });

    it('takes a file edited at its place in a folder its files confirm, and nowhere else', async () => {
      const entries = [entry('a.jpg', 'a'), entry('b.jpg', 'b'), entry('c.jpg', 'c')];
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'c.jpg', 'c, edited');

      const result = await match(exportOf(entries));
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/c.jpg',
      ]);
      expect(result.folders).toEqual([
        {
          exported: '/a/Pictures',
          files: 3,
          found: 2,
          foundIn: ['/a/Pictures'],
          inLibrary: true,
          suspicious: false,
        },
      ]);
      expect(result.samePathRoots).toEqual([pictures]);

      // The same files under another path: nothing says the file at that place is the one exported.
      library = createTestLibrary();
      const photos = library.roots.insert('/b/Photos');
      put(photos, 'a.jpg', 'a');
      put(photos, 'b.jpg', 'b');
      put(photos, 'c.jpg', 'c, edited');
      expect(outcomesOf(await match(exportOf(entries)))).toEqual([
        'samePlace /b/Photos/a.jpg',
        'samePlace /b/Photos/b.jpg',
        'notFound: notFound',
      ]);
    });

    it('takes the file at its place rather than share a copy another entry took', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'same');
      put(pictures, 'b.jpg', 'same, edited');
      put(pictures, 'c.jpg', 'c');
      put(pictures, 'd.jpg', 'd');

      const result = await match(
        exportOf([
          entry('a.jpg', 'same'),
          entry('b.jpg', 'same'),
          entry('c.jpg', 'c'),
          entry('d.jpg', 'd'),
        ]),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'changed /a/Pictures/b.jpg',
        'samePlace /a/Pictures/c.jpg',
        'samePlace /a/Pictures/d.jpg',
      ]);
    });

    it('takes the file at its place rather than share an exact counterpart another entry took', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, '2024/x.jpg', 'x, edited');
      put(library.roots.insert('/a/Backup'), '2024/x.jpg', 'x');

      const result = await match(
        exportOf(
          [
            entry('a.jpg', 'a'),
            entry('b.jpg', 'b'),
            entry('2024/x.jpg', 'x'),
            entry('2024/x.jpg', 'x', { root: 1, path: '/a/Backup/2024/x.jpg' }),
          ],
          ['/a/Pictures', '/a/Backup'],
        ),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/2024/x.jpg',
        'samePlace /a/Backup/2024/x.jpg',
      ]);
    });

    it('takes the file at its place rather than a file taken as identical by name and date alone, read where it may come first', async () => {
      // Elsewhere, or with its whole relative path in the library folder holding most of its
      // folder: there it would come before the copy another entry took.
      for (const [other, first] of [
        ['Other/x.jpg', false],
        ['Other/2024/x.jpg', true],
      ] as const) {
        for (const another of [false, true]) {
          library = createTestLibrary();
          read.mockClear();
          const pictures = library.roots.insert('/a/Pictures');
          put(pictures, 'a.jpg', 'a');
          put(pictures, 'b.jpg', 'b');
          put(pictures, '2024/x.jpg', 'x, edited', { mtimeMs: LATER });
          put(library.roots.insert('/a/Backup'), '2024/x.jpg', 'x');
          // Another photo, with the same name and size, modified within 2 s: not fingerprinted yet.
          put(pictures, other, 'another x', { printed: false, mtimeMs: MTIME + 1_000 });
          const entries = [
            entry('a.jpg', 'a'),
            entry('b.jpg', 'b'),
            entry('2024/x.jpg', 'x'),
            entry('2024/x.jpg', 'x', { root: 1, path: '/a/Backup/2024/x.jpg' }),
            // Found nowhere: every file of its size is read for it.
            ...(another ? [entry('old/q.jpg', 'q')] : []),
          ];

          const result = await match(exportOf(entries, ['/a/Pictures', '/a/Backup']));
          expect(outcomesOf(result).slice(0, 4)).toEqual([
            'samePlace /a/Pictures/a.jpg',
            'samePlace /a/Pictures/b.jpg',
            'changed /a/Pictures/2024/x.jpg',
            'samePlace /a/Backup/2024/x.jpg',
          ]);
          const reads = first || another ? [`/a/Pictures/${other}`] : [];
          expect(read.mock.calls.map(([target]) => target.path)).toEqual(reads);
          expect(library.files.findByPath(`/a/Pictures/${other}`)?.fingerprint).toBe(
            reads.length > 0 ? printOf('another x') : null,
          );
        }
      }
    });

    it('reads a file taken as identical by name and date deeper in the library folder at its path before taking it', async () => {
      for (const { edited, content, found } of [
        {
          edited: true,
          content: 'another photo',
          found: 'changed /a/Pictures/DCIM/100CANON/IMG_0001.CR2',
        },
        // Deleted since.
        { edited: false, content: 'another photo', found: 'notFound: notFound' },
        // A copy of the photo, made with its date.
        {
          edited: true,
          content: 'photo',
          found: 'moved /a/Pictures/Old card/DCIM/100CANON/IMG_0001.CR2',
        },
      ]) {
        library = createTestLibrary();
        read.mockClear();
        const pictures = library.roots.insert('/a/Pictures');
        put(pictures, 'a.jpg', 'a');
        put(pictures, 'b.jpg', 'b');
        if (edited) {
          put(pictures, 'DCIM/100CANON/IMG_0001.CR2', 'photo, edited', { mtimeMs: LATER });
        }
        // Of another card, with the same name and size, modified within 2 s: not fingerprinted yet.
        put(pictures, 'Old card/DCIM/100CANON/IMG_0001.CR2', content, {
          printed: false,
          mtimeMs: MTIME + 1_000,
        });

        const result = await match(
          exportOf([
            entry('a.jpg', 'a'),
            entry('b.jpg', 'b'),
            entry('DCIM/100CANON/IMG_0001.CR2', 'photo'),
          ]),
        );
        expect(outcomesOf(result)[2]).toBe(found);
        expect(read.mock.calls.map(([target]) => target.path)).toEqual([
          '/a/Pictures/Old card/DCIM/100CANON/IMG_0001.CR2',
        ]);
      }
    });

    it('finds a file renamed since beside another photo with its name, size and date, reading each once', async () => {
      // On the same computer or another, the library new: nothing is fingerprinted yet. A card
      // copied in since holds another photo with its name and size, modified within 2 s, whose path
      // ends with its relative path, in the same library folder or another.
      for (const at of ['/a/Pictures', '/b/Photos']) {
        for (const card of [at, '/c/Card']) {
          library = createTestLibrary();
          read.mockClear();
          const pictures = library.roots.insert(at);
          put(pictures, 'a.jpg', 'a');
          put(pictures, 'b.jpg', 'b');
          put(pictures, 'IMG_0001 edit.JPG', 'photo', { printed: false });
          put(
            card === at ? pictures : library.roots.insert(card),
            'Card 2/IMG_0001.JPG',
            'another photo',
            { printed: false, mtimeMs: MTIME + 1_000 },
          );
          const parsed = exportOf([
            entry('a.jpg', 'a'),
            entry('b.jpg', 'b'),
            entry('IMG_0001.JPG', 'photo'),
          ]);

          const found = `moved ${at}/IMG_0001 edit.JPG`;
          const progress: string[] = [];
          expect(
            outcomesOf(
              await match(parsed, {
                onProgress: (step, done, total) => progress.push(`${step} ${done}/${total}`),
              }),
            )[2],
          ).toBe(found);
          expect(read.mock.calls.map(([target]) => target.path).sort()).toEqual(
            [`${at}/IMG_0001 edit.JPG`, `${card}/Card 2/IMG_0001.JPG`].sort(),
          );
          // The other photo first, then, found to differ, the rest of the files of its size.
          expect(progress.filter((each) => each.startsWith('comparing'))).toEqual([
            'comparing 0/1',
            'comparing 1/1',
            'comparing 1/2',
            'comparing 2/2',
          ]);
          // Checked again: the same, reading nothing more.
          read.mockClear();
          expect(outcomesOf(await match(parsed))[2]).toBe(found);
          expect(read).not.toHaveBeenCalled();
        }
      }
    });

    it('reads only the files with the whole relative path of an entry while one may be its file, of many of one size', async () => {
      // Fixed-size RAW files: all one size. The library new: nothing is fingerprinted yet, dates
      // kept. On the same computer, one tagged file was moved deeper since, its folder and name
      // kept; on another, the library folder exported is deeper in the one here.
      for (const { at, moved, reads } of [
        { at: '/a/Pictures', moved: 'Archive/2024/DSC00000.ARW', reads: 1 },
        { at: '/b', moved: undefined, reads: 20 },
      ]) {
        library = createTestLibrary();
        read.mockClear();
        const root = library.roots.insert(at);
        const above = at === '/a/Pictures' ? '' : 'Pictures/';
        const entries: ImportEntry[] = [];
        const found: string[] = [];
        for (let index = 0; index < 20; index++) {
          const rel = `2024/DSC${String(index).padStart(5, '0')}.ARW`;
          const mtimeMs = MTIME + index * 10_000;
          const here = index === 0 && moved !== undefined ? moved : `${above}${rel}`;
          put(root, here, rel, { printed: false, mtimeMs });
          entries.push(entry(rel, rel, { mtimeMs }));
          found.push(`${here === rel ? 'samePlace' : 'moved'} ${at}/${here}`);
        }
        // Untagged.
        for (let index = 0; index < 30; index++) {
          put(root, `2023/_DSC${String(index).padStart(5, '0')}.ARW`, `untagged ${index}`, {
            printed: false,
            mtimeMs: LATER + index * 10_000,
          });
        }

        const result = await match(exportOf(entries));
        expect(outcomesOf(result)).toEqual(found);
        expect(result.reads).toBe(reads);
        expect(read.mock.calls.map(([target]) => target.path).sort()).toEqual(
          moved === undefined
            ? found.map((outcome) => outcome.replace('moved ', '')).sort()
            : [`${at}/${moved}`],
        );
      }
    });

    it('finds a file renamed since when a read for another entry finds the one taken as it by name and date to differ', async () => {
      // On the same computer or another, the library new: nothing is fingerprinted yet. Another
      // photo was saved with its name, size and date where it was in its library folder, the file
      // itself renamed. Another entry's file was renamed too, beside a photo of another card with
      // its name, size and date: only once that one is read are the rest of its size read.
      for (const at of ['/a/Pictures', '/b/Photos']) {
        library = createTestLibrary();
        read.mockClear();
        const root = library.roots.insert(at);
        put(root, 'a.jpg', 'a');
        put(root, 'b.jpg', 'b');
        put(root, 'x.jpg', 'another x', { printed: false });
        put(root, 'x renamed.jpg', 'x', { printed: false, mtimeMs: LATER });
        put(root, 'Card 2/IMG_0001.JPG', 'another photo', {
          printed: false,
          mtimeMs: MTIME + 1_000,
        });
        put(root, 'IMG_0001 edit.JPG', 'photo', { printed: false, mtimeMs: LATER });
        const parsed = exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('x.jpg', 'x'),
          entry('IMG_0001.JPG', 'photo'),
        ]);

        const found = [
          `samePlace ${at}/a.jpg`,
          `samePlace ${at}/b.jpg`,
          `moved ${at}/x renamed.jpg`,
          `moved ${at}/IMG_0001 edit.JPG`,
        ];
        expect(outcomesOf(await match(parsed))).toEqual(found);
        expect(read.mock.calls.map(([target]) => target.path).sort()).toEqual(
          [
            `${at}/Card 2/IMG_0001.JPG`,
            `${at}/IMG_0001 edit.JPG`,
            `${at}/x renamed.jpg`,
            `${at}/x.jpg`,
          ].sort(),
        );
        // Checked again: the same, reading nothing more.
        read.mockClear();
        expect(outcomesOf(await match(parsed))).toEqual(found);
        expect(read).not.toHaveBeenCalled();
      }
    });

    it('rules out a file taken as identical by name and date once read for another entry', async () => {
      const photos = library.roots.insert('/b/Photos');
      put(photos, 'a.jpg', 'a');
      put(photos, 'x.jpg', 'another x', { printed: false });
      const entries = [entry('a.jpg', 'a'), entry('x.jpg', 'x'), entry('old/q.jpg', 'q')];

      const result = await match(exportOf(entries));
      expect(outcomesOf(result)).toEqual([
        'samePlace /b/Photos/a.jpg',
        'notFound: notFound',
        'notFound: notFound',
      ]);
      expect(read.mock.calls.map(([target]) => target.path)).toEqual(['/b/Photos/x.jpg']);

      // At its very place, edited with its date kept: the file found to differ may only have changed.
      library = createTestLibrary();
      read.mockClear();
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'x.jpg', 'x, edited', { printed: false });
      const kept = await match(
        exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), ...entries.slice(1)]),
      );
      expect(outcomesOf(kept)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/x.jpg',
        'notFound: notFound',
      ]);
      expect(read.mock.calls.map(([target]) => target.path)).toEqual(['/a/Pictures/x.jpg']);
    });

    it('takes nothing at their place in a folder where most files there differ', async () => {
      const card = library.roots.insert('/Volumes/CARD');
      put(card, 'DCIM/IMG_0001.JPG', 'first');
      put(card, 'DCIM/IMG_0002.JPG', 'another second');
      put(card, 'DCIM/IMG_0003.JPG', 'another third', { size: 2_000 });

      const result = await match(
        exportOf(
          [
            entry('DCIM/IMG_0001.JPG', 'first'),
            entry('DCIM/IMG_0002.JPG', 'second'),
            entry('DCIM/IMG_0003.JPG', 'third'),
          ],
          ['/Volumes/CARD'],
        ),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /Volumes/CARD/DCIM/IMG_0001.JPG',
        'notFound: notFound',
        'notFound: notFound',
      ]);
      expect(result.folders[0]).toMatchObject({ files: 3, found: 1, suspicious: true });
    });

    it('takes nothing on its place alone in a folder with no other file to confirm it', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'another photo');

      const result = await match(exportOf([entry('a.jpg', 'a')]));
      expect(outcomesOf(result)).toEqual(['notFound: notFound']);
      expect(result.folders[0]).toMatchObject({ found: 0, suspicious: true });

      // Only the middle differs: same fingerprint, another SHA-256.
      library = createTestLibrary();
      put(library.roots.insert('/a/Pictures'), 'a.jpg', 'a', { hashed: true });
      const middle = await match(exportOf([entry('a.jpg', 'a', { sha256: hashOf('another a') })]));
      expect(outcomesOf(middle)).toEqual(['notFound: notFound']);
      expect(middle.folders[0]).toMatchObject({ found: 0, suspicious: true });
    });

    it('takes nothing on its place alone for a file already missing when exported', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'c.jpg', 'c');
      put(pictures, 'gone.jpg', 'a new photo');
      put(pictures, 'back.jpg', 'back');

      const result = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('c.jpg', 'c'),
          entry('gone.jpg', 'gone', { missing: true }),
          entry('back.jpg', 'back', { missing: true }),
        ]),
      );
      // Its content still finds it.
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'samePlace /a/Pictures/c.jpg',
        'notFound: missing',
        'samePlace /a/Pictures/back.jpg',
      ]);

      // Nor does the file at its place count against the folder: it may be anything.
      library = createTestLibrary();
      const again = library.roots.insert('/a/Pictures');
      put(again, 'a.jpg', 'a');
      put(again, 'b.jpg', 'b');
      put(again, 'c.jpg', 'c, edited');
      put(again, 'gone.jpg', 'a new photo');
      const edited = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('c.jpg', 'c'),
          entry('gone.jpg', 'gone', { missing: true }),
        ]),
      );
      expect(outcomesOf(edited)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/c.jpg',
        'notFound: missing',
      ]);
      expect(edited.folders[0]).toMatchObject({ suspicious: false });
    });

    describe('identical files', () => {
      let photos: RootRecord;

      beforeEach(() => {
        photos = library.roots.insert('/b/Photos');
      });

      it('gives each its exact counterpart, whichever comes first in the tags export', async () => {
        put(photos, 'a/x.jpg', 'same');
        put(photos, 'b/x.jpg', 'same');

        const result = await match(
          exportOf([
            entry('old/x.jpg', 'same'),
            entry('a/x.jpg', 'same'),
            entry('b/x.jpg', 'same'),
          ]),
        );
        expect(outcomesOf(result)).toEqual([
          'moved (shared) /b/Photos/a/x.jpg',
          'samePlace /b/Photos/a/x.jpg',
          'samePlace /b/Photos/b/x.jpg',
        ]);
      });

      it('each go to a copy of their own while there are enough', async () => {
        put(photos, 'p/x.jpg', 'same');
        put(photos, 'q/x.jpg', 'same');

        const result = await match(
          exportOf([entry('old/x.jpg', 'same'), entry('new/x.jpg', 'same')]),
        );
        expect(outcomesOf(result)).toEqual(['moved /b/Photos/p/x.jpg', 'moved /b/Photos/q/x.jpg']);
      });

      it('in two library folders each go to an exact counterpart of their own', async () => {
        const backup = library.roots.insert('/c/Backup');
        put(photos, 'x.jpg', 'same');
        put(backup, 'x.jpg', 'same');

        const result = await match(
          exportOf(
            [entry('x.jpg', 'same'), entry('x.jpg', 'same', { root: 1 })],
            ['/a/Pictures', '/a/Backup'],
          ),
        );
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Photos/x.jpg',
          'samePlace /c/Backup/x.jpg',
        ]);
      });

      it('are found in the library folder where the rest of their folder is', async () => {
        const backup = library.roots.insert('/c/Backup');
        put(backup, 'x.jpg', 'x');
        put(photos, 'x.jpg', 'x');
        put(photos, 'y.jpg', 'y');
        put(photos, 'z.jpg', 'z');

        const result = await match(
          exportOf([entry('x.jpg', 'x'), entry('y.jpg', 'y'), entry('z.jpg', 'z')]),
        );
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Photos/x.jpg',
          'samePlace /b/Photos/y.jpg',
          'samePlace /b/Photos/z.jpg',
        ]);
        expect(result.folders[0]?.foundIn).toEqual(['/b/Photos']);
      });

      it('share the one copy left, which gets the tags of both', async () => {
        put(photos, 'x.jpg', 'same');

        const result = await match(exportOf([entry('x.jpg', 'same'), entry('copy/x.jpg', 'same')]));
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Photos/x.jpg',
          'moved (shared) /b/Photos/x.jpg',
        ]);
      });

      it('give their tags to the most alike copy only', async () => {
        put(photos, 'backup/x.jpg', 'same');
        put(photos, '2024/trips/x.jpg', 'same');

        const result = await match(exportOf([entry('old/trips/x.jpg', 'same')]));
        expect(outcomesOf(result)).toEqual(['moved /b/Photos/2024/trips/x.jpg']);
      });

      it('are read when no entry took them yet, before one is shared', async () => {
        put(photos, 'a.jpg', 'same');
        put(photos, 'b.jpg', 'same', { printed: false, mtimeMs: LATER });
        const progress: string[] = [];

        const result = await match(exportOf([entry('a.jpg', 'same'), entry('b.jpg', 'same')]), {
          onProgress: (step, done, total) => progress.push(`${step} ${done}/${total}`),
        });
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Photos/a.jpg',
          'samePlace /b/Photos/b.jpg',
        ]);
        expect(read.mock.calls.map(([target]) => target.path)).toEqual(['/b/Photos/b.jpg']);
        expect(library.files.findByPath('/b/Photos/b.jpg')?.fingerprint).toBe(printOf('same'));
        expect(progress[0]).toBe('matching 0/2');
        expect(progress.slice(-3)).toEqual(['matching 2/2', 'comparing 0/1', 'comparing 1/1']);
      });

      it('are read when the only one known is the place of another entry', async () => {
        const pictures = library.roots.insert('/a/Pictures');
        put(pictures, '2024/x.jpg', 'x');
        put(pictures, '2024/y.jpg', 'y');
        put(library.roots.insert('/c/Backup'), '2024/x.jpg', 'x', {
          printed: false,
          mtimeMs: LATER,
        });

        const result = await match(
          exportOf(
            [
              entry('2024/x.jpg', 'x'),
              entry('2024/y.jpg', 'y'),
              entry('2024/x.jpg', 'x', { root: 1, path: '/a/Backup/2024/x.jpg' }),
            ],
            ['/a/Pictures', '/a/Backup'],
          ),
        );
        expect(outcomesOf(result)).toEqual([
          'samePlace /a/Pictures/2024/x.jpg',
          'samePlace /a/Pictures/2024/y.jpg',
          'samePlace /c/Backup/2024/x.jpg',
        ]);
        expect(read.mock.calls.map(([target]) => target.path)).toEqual(['/c/Backup/2024/x.jpg']);

        // The copy in a folder of the same library folder: the file at the place is read.
        library = createTestLibrary();
        read.mockClear();
        const same = library.roots.insert('/a/Pictures');
        put(same, 'a.jpg', 'a');
        put(same, '2024/x.jpg', 'x', { printed: false, mtimeMs: LATER });
        put(same, 'backup/2024/x.jpg', 'x');
        const inFolder = await match(
          exportOf([
            entry('a.jpg', 'a'),
            entry('2024/x.jpg', 'x'),
            entry('backup/2024/x.jpg', 'x'),
          ]),
        );
        expect(outcomesOf(inFolder)).toEqual([
          'samePlace /a/Pictures/a.jpg',
          'samePlace /a/Pictures/2024/x.jpg',
          'samePlace /a/Pictures/backup/2024/x.jpg',
        ]);
        expect(read.mock.calls.map(([target]) => target.path)).toEqual(['/a/Pictures/2024/x.jpg']);

        // Copied with its date, deeper in a library folder: its name and date alone may be those of
        // another photo.
        for (const content of ['x', 'another x']) {
          library = createTestLibrary();
          read.mockClear();
          const main = library.roots.insert('/a/Pictures');
          put(main, '2024/x.jpg', 'x');
          put(main, '2024/y.jpg', 'y');
          put(library.roots.insert('/c'), 'Backup/2024/x.jpg', content, { printed: false });
          const deeper = await match(
            exportOf(
              [
                entry('2024/x.jpg', 'x'),
                entry('2024/y.jpg', 'y'),
                entry('2024/x.jpg', 'x', { root: 1, path: '/a/Backup/2024/x.jpg' }),
              ],
              ['/a/Pictures', '/a/Backup'],
            ),
          );
          expect(outcomesOf(deeper)[2]).toBe(
            content === 'x'
              ? 'moved /c/Backup/2024/x.jpg'
              : 'samePlace (shared) /a/Pictures/2024/x.jpg',
          );
          expect(read.mock.calls.map(([target]) => target.path)).toEqual(['/c/Backup/2024/x.jpg']);
        }
      });

      it('are read when taken as identical by name and date only, to rule out another file', async () => {
        put(photos, '2023/DSC00001 edit.ARW', 'raw', { printed: false, mtimeMs: LATER });
        put(photos, '2024/DSC00001.ARW', 'another raw', {
          printed: false,
          mtimeMs: MTIME + 1_000,
        });

        const result = await match(exportOf([entry('2023/DSC00001.ARW', 'raw')]));
        expect(outcomesOf(result)).toEqual(['moved /b/Photos/2023/DSC00001 edit.ARW']);
        expect(read.mock.calls.map(([target]) => target.path).sort()).toEqual([
          '/b/Photos/2023/DSC00001 edit.ARW',
          '/b/Photos/2024/DSC00001.ARW',
        ]);
        expect(library.files.findByPath('/b/Photos/2024/DSC00001.ARW')?.fingerprint).toBe(
          printOf('another raw'),
        );
      });

      it('known by content come before those taken as identical by name and date', async () => {
        const card = library.roots.insert('/c/Card');
        offline.add(card.id);
        put(card, '2023/DSC00001 edit.ARW', 'raw');
        put(photos, '2024/DSC00001.ARW', 'another raw', {
          printed: false,
          mtimeMs: MTIME + 1_000,
        });
        disk.delete('/b/Photos/2024/DSC00001.ARW');

        const result = await match(exportOf([entry('2023/DSC00001.ARW', 'raw')]));
        expect(outcomesOf(result)).toEqual(['moved /c/Card/2023/DSC00001 edit.ARW']);
      });
    });

    describe('identical files in a mirror of a library folder', () => {
      it('go to the copy at their place in its library folder rather than to one deeper in another', async () => {
        // Fingerprinted long ago.
        const backup = library.roots.insert('/c/Backup');
        put(backup, 'Pictures/2024/x.jpg', 'x');
        put(backup, 'Pictures/2024/y.jpg', 'y');
        // Copied with its dates, not fingerprinted yet.
        const photos = library.roots.insert('/b/Photos');
        put(photos, '2024/x.jpg', 'x', { printed: false });
        put(photos, '2024/y.jpg', 'y', { printed: false });

        const result = await match(exportOf([entry('2024/x.jpg', 'x'), entry('2024/y.jpg', 'y')]));
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Photos/2024/x.jpg',
          'samePlace /b/Photos/2024/y.jpg',
        ]);
        expect(result.folders[0]?.foundIn).toEqual(['/b/Photos']);
        expect(read).not.toHaveBeenCalled();
      });

      it('go to the main copy rather than to a full mirror added first, the main folder at a new path', async () => {
        // The mirror keeps the name of the folder, or not.
        for (const kept of ['', 'Pictures/']) {
          library = createTestLibrary();
          const backup = library.roots.insert('/c/Backup');
          put(backup, `${kept}2024/x.jpg`, 'x');
          put(backup, `${kept}2024/y.jpg`, 'y');
          const pictures = library.roots.insert('/b/Pictures');
          put(pictures, '2024/x.jpg', 'x');
          put(pictures, '2024/y.jpg', 'y');

          const result = await match(
            exportOf([entry('2024/x.jpg', 'x'), entry('2024/y.jpg', 'y')]),
          );
          expect(outcomesOf(result)).toEqual([
            'samePlace /b/Pictures/2024/x.jpg',
            'samePlace /b/Pictures/2024/y.jpg',
          ]);
          expect(result.folders[0]?.foundIn).toEqual(['/b/Pictures']);
        }
      });

      it('go to a copy moved in the library folder of the rest of their folder, not to an old one at their place in a mirror', async () => {
        /** Restores `/a/Pictures`, whose `2024/x.jpg` was moved into `Trips` since, here at `at`. */
        const restore = async (
          at: string,
          mirror: { readonly offline?: boolean; readonly kept?: string; readonly full?: boolean },
        ): Promise<MatchResult> => {
          library = createTestLibrary();
          offline = new Set();
          // Added first: its files come first by id.
          const backup = library.roots.insert('/Volumes/Backup');
          put(backup, `${mirror.kept ?? ''}2024/x.jpg`, 'x');
          if (mirror.full === true) {
            put(backup, 'a.jpg', 'a');
            put(backup, 'b.jpg', 'b');
          }
          if (mirror.offline === true) {
            offline.add(backup.id);
          }
          const pictures = library.roots.insert(at);
          put(pictures, 'a.jpg', 'a');
          put(pictures, 'b.jpg', 'b');
          put(pictures, 'Trips/2024/x.jpg', 'x');
          return match(
            exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), entry('2024/x.jpg', 'x')]),
          );
        };

        // At the same path, the mirror connected or not.
        for (const offlineMirror of [false, true]) {
          const result = await restore('/a/Pictures', { offline: offlineMirror });
          expect(outcomesOf(result)).toEqual([
            'samePlace /a/Pictures/a.jpg',
            'samePlace /a/Pictures/b.jpg',
            'moved /a/Pictures/Trips/2024/x.jpg',
          ]);
          expect(result.folders[0]?.foundIn).toEqual(['/a/Pictures']);
        }
        // A full mirror, or one that kept the name of the folder.
        for (const mirror of [{ full: true }, { kept: 'Pictures/' }]) {
          expect(outcomesOf(await restore('/a/Pictures', mirror))[2]).toBe(
            'moved /a/Pictures/Trips/2024/x.jpg',
          );
        }
        // At another path, the mirror full or not.
        for (const full of [false, true]) {
          const elsewhere = await restore('/b/Pictures', { full });
          expect(outcomesOf(elsewhere)).toEqual([
            'samePlace /b/Pictures/a.jpg',
            'samePlace /b/Pictures/b.jpg',
            'moved /b/Pictures/Trips/2024/x.jpg',
          ]);
          expect(elsewhere.folders[0]?.foundIn).toEqual(['/b/Pictures']);
        }
        expect(read).not.toHaveBeenCalled();
      });

      it('go to copies moved in the library folder at their path, however many, not to old ones at their place in a mirror', async () => {
        for (const { kept, moved, mirrored } of [
          // The whole folder, or its one file.
          { kept: [], moved: ['2024/x.jpg', '2024/y.jpg'], mirrored: ['2024/x.jpg', '2024/y.jpg'] },
          { kept: [], moved: ['2024/x.jpg'], mirrored: ['2024/x.jpg'] },
          // As many as those left at their place, or more, the mirror full or not.
          { kept: ['a.jpg'], moved: ['2024/x.jpg'], mirrored: ['2024/x.jpg'] },
          {
            kept: ['a.jpg'],
            moved: ['2024/x.jpg', '2024/y.jpg'],
            mirrored: ['2024/x.jpg', '2024/y.jpg'],
          },
          {
            kept: ['a.jpg'],
            moved: ['2024/x.jpg', '2024/y.jpg'],
            mirrored: ['a.jpg', '2024/x.jpg', '2024/y.jpg'],
          },
        ]) {
          // Whichever library folder was added first, its files first by id.
          for (const mirrorFirst of [true, false]) {
            library = createTestLibrary();
            const first = mirrorFirst ? library.roots.insert('/Volumes/Backup') : undefined;
            const pictures = library.roots.insert('/a/Pictures');
            const backup = first ?? library.roots.insert('/Volumes/Backup');
            const fill = [
              () => {
                for (const rel of mirrored) {
                  put(backup, rel, rel);
                }
              },
              () => {
                for (const rel of kept) {
                  put(pictures, rel, rel);
                }
                for (const rel of moved) {
                  put(pictures, `Trips/${rel}`, rel);
                }
              },
            ];
            for (const each of mirrorFirst ? fill : fill.toReversed()) {
              each();
            }

            const result = await match(exportOf([...kept, ...moved].map((rel) => entry(rel, rel))));
            expect(outcomesOf(result)).toEqual([
              ...kept.map((rel) => `samePlace /a/Pictures/${rel}`),
              ...moved.map((rel) => `moved /a/Pictures/Trips/${rel}`),
            ]);
            expect(result.folders[0]?.foundIn).toEqual(['/a/Pictures']);
          }
        }
        expect(read).not.toHaveBeenCalled();
      });

      it('go to copies moved where the rest of their folder is, known by name and date once read', async () => {
        // At the same path or another, just indexed: only the mirror was fingerprinted.
        for (const at of ['/a/Pictures', '/b/Pictures']) {
          for (const content of ['x', 'another x']) {
            library = createTestLibrary();
            read.mockClear();
            put(library.roots.insert('/Volumes/Backup'), '2024/x.jpg', 'x');
            const pictures = library.roots.insert(at);
            put(pictures, 'a.jpg', 'a', { printed: false });
            put(pictures, 'b.jpg', 'b', { printed: false });
            put(pictures, 'Trips/2024/x.jpg', content, { printed: false });

            const result = await match(
              exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), entry('2024/x.jpg', 'x')]),
            );
            // Another photo with the same name and date: the old copy is the one left.
            expect(outcomesOf(result)).toEqual([
              `samePlace ${at}/a.jpg`,
              `samePlace ${at}/b.jpg`,
              content === 'x'
                ? `moved ${at}/Trips/2024/x.jpg`
                : 'samePlace /Volumes/Backup/2024/x.jpg',
            ]);
            expect(read.mock.calls.map(([target]) => target.path)).toEqual([
              `${at}/Trips/2024/x.jpg`,
            ]);
          }
        }
      });

      it('at their place in both go to the most alike library folder', async () => {
        put(library.roots.insert('/c/Backup'), '2024/x.jpg', 'x');
        put(library.roots.insert('/b/Pictures'), '2024/x.jpg', 'x', { printed: false });

        const result = await match(exportOf([entry('2024/x.jpg', 'x')]));
        expect(outcomesOf(result)).toEqual(['samePlace /b/Pictures/2024/x.jpg']);
      });

      it('go to the library folder where the rest of their folder is at its place', async () => {
        const backup = library.roots.insert('/c/Backup');
        put(backup, 'Pictures/x.jpg', 'x');
        put(backup, 'Pictures/y.jpg', 'y');
        put(backup, 'Pictures/z.jpg', 'z');
        const photos = library.roots.insert('/b/Photos');
        put(photos, 'x.jpg', 'x');
        put(photos, 'y.jpg', 'y');
        put(photos, '2023/z.jpg', 'z');

        const result = await match(
          exportOf([entry('x.jpg', 'x'), entry('y.jpg', 'y'), entry('z.jpg', 'z')]),
        );
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Photos/x.jpg',
          'samePlace /b/Photos/y.jpg',
          'moved /b/Photos/2023/z.jpg',
        ]);
      });

      it('go where the rest of their folder is, files already missing when exported aside', async () => {
        const backup = library.roots.insert('/c/Pictures');
        put(backup, '2024/x.jpg', 'x');
        put(backup, '2024/gone1.jpg', 'gone1');
        put(backup, '2024/gone2.jpg', 'gone2');
        const pictures = library.roots.insert('/b/Pictures');
        put(pictures, '2024/x.jpg', 'x');
        put(pictures, '2024/n.jpg', 'n');

        const result = await match(
          exportOf([
            entry('2024/x.jpg', 'x'),
            entry('2024/gone1.jpg', 'gone1', { missing: true }),
            entry('2024/gone2.jpg', 'gone2', { missing: true }),
            entry('2024/n.jpg', 'n'),
          ]),
        );
        expect(outcomesOf(result)).toEqual([
          'samePlace /b/Pictures/2024/x.jpg',
          'samePlace /c/Pictures/2024/gone1.jpg',
          'samePlace /c/Pictures/2024/gone2.jpg',
          'samePlace /b/Pictures/2024/n.jpg',
        ]);
      });
    });

    it('never takes an empty file for another, only for the one at its place', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'empty.jpg', '', { size: 0 });
      put(pictures, 'other/gone.jpg', '', { size: 0 });

      const result = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('empty.jpg', '', { size: 0 }),
          entry('gone.jpg', '', { size: 0 }),
        ]),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/empty.jpg',
        'notFound: notFound',
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it('finds a name in another case by its content, and at its place only if case does not matter', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'img_0001.jpg', 'photo', { size: 1_500, printed: false });
      put(pictures, 'img_0002.jpg', 'photo, edited', { size: 2_500 });

      const result = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('IMG_0001.JPG', 'photo', { size: 1_500 }),
          entry('IMG_0002.JPG', 'photo', { size: 2_500 }),
        ]),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        // Where case tells names apart, it was renamed: read to make sure, and listed.
        caseInsensitive ? 'samePlace /a/Pictures/img_0001.jpg' : 'moved /a/Pictures/img_0001.jpg',
        caseInsensitive ? 'changed /a/Pictures/img_0002.jpg' : 'notFound: notFound',
      ]);
      expect(read.mock.calls.map(([target]) => target.path)).toEqual(
        caseInsensitive ? [] : ['/a/Pictures/img_0001.jpg'],
      );
    });

    it('takes, of files at its place whose names differ only in case, the one with its very name', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'img_0001.jpg', 'another photo');
      put(pictures, 'IMG_0001.JPG', 'photo, edited');

      const result = await match(
        exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), entry('IMG_0001.JPG', 'photo')]),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'changed /a/Pictures/IMG_0001.JPG',
      ]);
    });

    it('takes, of files at its place whose names differ only in Unicode form, the one at its very path', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      // As the indexer stores them: names in NFC, paths as on disk.
      const twin = (name: string, content: string): void => {
        const target = { path: `/a/Pictures/${name}`, size: SIZE, mtimeMs: MTIME };
        const id = library.files.insert({
          ...target,
          rootId: pictures.id,
          dir: '',
          name: name.normalize('NFC'),
          ext: 'jpg',
          kind: 'image',
          birthtimeMs: null,
          fileId: null,
        });
        library.files.setFingerprint({ id, ...target }, printOf(content));
      };
      twin('\u00c9t\u00e9.jpg', 'another photo');
      twin('E\u0301te\u0301.jpg', 'photo, edited');
      const summer = (exported: string): ImportEntry =>
        entry('\u00c9t\u00e9.jpg', 'photo', { path: `/a/Pictures/${exported}` });

      const result = await match(
        exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), summer('E\u0301te\u0301.jpg')]),
      );
      expect(outcomesOf(result)[2]).toBe('changed /a/Pictures/E\u0301te\u0301.jpg');

      // Neither is at its very path: which one it was cannot be told.
      const neither = await match(
        exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), summer('\u00c9te\u0301.jpg')]),
      );
      expect(outcomesOf(neither)[2]).toBe('notFound: notFound');
      expect(neither.folders[0]).toMatchObject({ found: 2, suspicious: false });
    });

    it('rules out a file whose known fingerprint or hash differs, whatever its name and date', async () => {
      const photos = library.roots.insert('/b/Photos');
      put(photos, 'a.jpg', 'another a');
      put(photos, 'b.jpg', 'b', { hashed: true });
      put(photos, 'c.jpg', 'c');

      const result = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b', { sha256: hashOf('another b') }),
          entry('c.jpg', 'c'),
        ]),
      );
      expect(outcomesOf(result)).toEqual([
        'notFound: notFound',
        'notFound: notFound',
        'samePlace /b/Photos/c.jpg',
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it('ignores fingerprints computed another way rather than take them as a difference', async () => {
      const photos = library.roots.insert('/b/Photos');
      put(photos, 'a.jpg', 'a');
      const exported = path.join(dir, 'tags.jsonl');
      await writeFile(
        exported,
        [
          headerLine({
            app: null,
            exportedAt: null,
            platform: 'darwin',
            fingerprint: 'md5(head64k)/32',
            roots: ['/a/Pictures'],
          }),
          entryLine(
            {
              id: 1,
              rootId: 1,
              path: '/a/Pictures/a.jpg',
              dir: '',
              name: 'a.jpg',
              size: SIZE,
              mtimeMs: MTIME,
              fingerprint: 'f'.repeat(32),
              contentHash: null,
              missing: false,
            },
            0,
            ['t'],
          ),
          endLine(1),
        ].join(''),
      );

      const parsed = await readTagFile(exported, {
        signal: new AbortController().signal,
        onBytes: () => undefined,
      });
      expect(outcomesOf(await match(parsed))).toEqual(['samePlace /b/Photos/a.jpg']);
    });

    it('compares files of a drive that is not connected on what is stored, never reading them', async () => {
      const photos = library.roots.insert('/b/Photos');
      offline.add(photos.id);
      put(photos, 'a.jpg', 'a');
      put(photos, 'b.jpg', 'b', { printed: false });
      put(photos, 'c.jpg', 'c', { printed: false, mtimeMs: LATER });

      const result = await match(
        exportOf([entry('a.jpg', 'a'), entry('b.jpg', 'b'), entry('c.jpg', 'c')]),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /b/Photos/a.jpg',
        'samePlace /b/Photos/b.jpg',
        'notFound: uncompared',
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it('takes a file missing from disk on its content only, after present ones', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      put(pictures, 'x/c.jpg', 'c', { missing: true });
      put(pictures, 'y/c.jpg', 'c');
      put(pictures, '2024/trips/d.jpg', 'd', { missing: true });
      put(pictures, 'other/d.jpg', 'd');
      put(pictures, 'e.jpg', 'e, edited', { missing: true });
      put(pictures, 'f.jpg', 'f', { missing: true });
      put(pictures, 'g.jpg', 'g', { missing: true, printed: false, mtimeMs: LATER });

      const result = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('c.jpg', 'c'),
          entry('old/trips/d.jpg', 'd'),
          entry('e.jpg', 'e'),
          entry('f.jpg', 'f'),
          entry('g.jpg', 'g'),
        ]),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'moved /a/Pictures/y/c.jpg',
        'moved /a/Pictures/other/d.jpg',
        'notFound: notFound',
        'samePlace /a/Pictures/f.jpg',
        'notFound: notFound',
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it('says why each file was not found', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'locked.jpg', 'locked', { size: 2_000, printed: false, mtimeMs: LATER });
      disk.delete('/a/Pictures/locked.jpg');
      put(pictures, 'backup/e.jpg', 'e');

      const result = await match(
        exportOf(
          [
            entry('a.jpg', 'a'),
            entry('gone.jpg', 'gone', { size: 5_000, missing: true }),
            entry('b.jpg', 'b', { size: 2_000 }),
            entry('c.jpg', 'c', { size: 3_000 }),
            entry('d.jpg', 'd', { root: 1, size: 4_000 }),
            entry('2019/e.jpg', 'e', { root: 2 }),
            entry('f.jpg', 'f', { root: 2, size: 6_000 }),
          ],
          ['/a/Pictures', '/Volumes/Old', '/Volumes/Backup'],
        ),
      );
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'notFound: missing',
        'notFound: uncompared',
        'notFound: notFound',
        'notFound: folder',
        'moved /a/Pictures/backup/e.jpg',
        'notFound: notFound',
      ]);
      expect(result.folders).toEqual([
        {
          exported: '/a/Pictures',
          files: 4,
          found: 1,
          foundIn: ['/a/Pictures'],
          inLibrary: true,
          suspicious: false,
        },
        {
          exported: '/Volumes/Old',
          files: 1,
          found: 0,
          foundIn: [],
          inLibrary: false,
          suspicious: false,
        },
        {
          exported: '/Volumes/Backup',
          files: 2,
          found: 1,
          foundIn: ['/a/Pictures'],
          inLibrary: false,
          suspicious: false,
        },
      ]);
      expect(result.samePathRoots).toEqual([pictures, null, null]);
      expect(result.reads).toBe(1);
    });

    it('stops reading once canceled', async () => {
      const photos = library.roots.insert('/b/Photos');
      const entries: ImportEntry[] = [];
      for (let index = 0; index < 10; index++) {
        put(photos, `${index}.jpg`, String(index), { printed: false, mtimeMs: LATER });
        entries.push(entry(`${index}.jpg`, String(index)));
      }
      const controller = new AbortController();
      read.mockImplementation((target) => {
        controller.abort(new Error('Canceled.'));
        return Promise.resolve(disk.get(target.path) ?? '');
      });

      await expect(match(exportOf(entries), { signal: controller.signal })).rejects.toThrow(
        'Canceled.',
      );
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('copes with files leaving the library meanwhile', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a');
      put(pictures, 'b.jpg', 'b');
      const c = put(pictures, 'c.jpg', 'c', { printed: false, mtimeMs: LATER });
      const d = put(pictures, 'd.jpg', 'another d', { size: 2_000 });
      read.mockImplementation((target) => {
        library.files.delete([c, d]);
        return Promise.resolve(disk.get(target.path) ?? '');
      });

      const result = await match(
        exportOf([
          entry('a.jpg', 'a'),
          entry('b.jpg', 'b'),
          entry('c.jpg', 'c'),
          entry('d.jpg', 'd', { size: 2_000 }),
        ]),
      );
      // A file gone since is left out when the tags are added: its snapshot no longer holds.
      expect(outcomesOf(result)).toEqual([
        'samePlace /a/Pictures/a.jpg',
        'samePlace /a/Pictures/b.jpg',
        'samePlace /a/Pictures/c.jpg',
        'notFound: notFound',
      ]);
    });

    it('normalises the path of each exported library folder once, however many library folders here', async () => {
      // A crafted tags export may name folders that take long to normalise.
      for (let index = 0; index < 20; index++) {
        library.roots.insert(`/Volumes/Disk ${index}`);
      }
      put(library.roots.insert('/b/Photos'), 'a.jpg', 'a');
      const normalize = vi.spyOn(String.prototype, 'normalize');

      const result = await match(
        exportOf(
          [entry('a.jpg', 'a', { path: '/Volumes/Old/Pictures/a.jpg' })],
          ['/Volumes/Old/Pictures'],
        ),
      );
      expect(outcomesOf(result)).toEqual(['samePlace /b/Photos/a.jpg']);
      expect(
        normalize.mock.contexts.filter((value) => String(value) === '/Volumes/Old/Pictures'),
      ).toHaveLength(1);
    });

    it('lets the event loop run while matching many files', async () => {
      // Each step takes 1 ms of the fake clock: slices end after a few entries.
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock++);
      const pictures = library.roots.insert('/a/Pictures');
      put(pictures, 'a.jpg', 'a', { size: 1 });
      const entries = Array.from({ length: 5_000 }, (_, index) =>
        entry(`${index}.jpg`, String(index), { size: (index % 100) + 1 }),
      );
      let turns = 0;
      let matching = true;
      const turn = (): void => {
        if (matching) {
          turns++;
          setImmediate(turn);
        }
      };
      setImmediate(turn);
      const matched: number[] = [];

      await match(exportOf(entries), {
        onProgress: (step, done) => {
          if (step === 'matching') {
            matched.push(done);
          }
        },
      });
      matching = false;
      expect(turns).toBeGreaterThan(1);
      expect(matched.some((done) => done > 0 && done < entries.length)).toBe(true);
    });

    it('lets the event loop run while loading many files of one size', async () => {
      const photos = library.roots.insert('/b/Photos');
      for (let index = 0; index < 3_000; index++) {
        put(photos, `${index}.jpg`, `another ${index}`);
      }
      // Each step takes 1 ms of the fake clock: slices end after a few files.
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock++);
      let turns = 0;
      let matching = true;
      const turn = (): void => {
        if (matching) {
          turns++;
          setImmediate(turn);
        }
      };
      setImmediate(turn);
      // Turns taken before the files are loaded, then once the one entry was compared with them.
      const progress: number[] = [];

      await match(exportOf([entry('x.jpg', 'x')]), {
        onProgress: (step) => {
          if (step === 'matching') {
            progress.push(turns);
          }
        },
      });
      matching = false;
      expect(progress).toHaveLength(2);
      expect(progress[1]).toBeGreaterThan(progress[0] ?? 0);
    });

    it('goes on in one step with the slice of the step before, however few entries each has', async () => {
      const pictures = library.roots.insert('/a/Pictures');
      const entries = Array.from({ length: 6 }, (_, index) => {
        put(pictures, `${index}.jpg`, String(index));
        return entry(`${index}.jpg`, String(index));
      });
      // Each look at the clock takes 1 ms: no step spends a slice, but all of them together do.
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock++);
      /** The clock when matching starts, at each turn of the event loop, then when it ends. */
      const clocks = [clock];
      let matching = true;
      const turn = (): void => {
        if (matching) {
          clocks.push(clock);
          setImmediate(turn);
        }
      };
      setImmediate(turn);

      const result = await match(exportOf(entries));
      clocks.push(clock);
      matching = false;
      expect(outcomesOf(result)).toEqual(entries.map((each) => `samePlace ${each.path}`));
      const longest = Math.max(...clocks.slice(1).map((at, before) => at - (clocks[before] ?? 0)));
      // The budget, the look at the clock that finds it spent, and one timing the whole match.
      expect(longest).toBeLessThanOrEqual(SLICE_BUDGET_MS + 2);
    });
  },
);

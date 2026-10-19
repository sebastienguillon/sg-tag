import type { TagImportResult, TagTransferProgress } from '@shared/model';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawl, statFiles } from '../indexer/crawler';
import { fingerprint, FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import { Reconciler } from '../indexer/reconciler';
import type { FingerprintTarget, IndexedFile } from '../library/files-repository';
import { SettingsRepository } from '../library/settings-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { MAX_LINE_BYTES, readTagFile } from './tag-file';
import type { TagExporterOptions } from './tag-exporter';
import { TagExporter } from './tag-exporter';
import { TagImporter } from './tag-importer';

// `open` stays the real one unless a test makes it fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return { ...fs, open: vi.fn(fs.open) };
});

const { open: realOpen } = await vi.importActual<typeof FsPromises>('node:fs/promises');

const APP = '2026.10.0-alpha.1';
const PRINT = '9f86d081884c7d659a2feaa0c55ad015';
const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EARLIER = 'an earlier tags export';
const STOPPED = 'The tags export was stopped.';
const TOO_LARGE = 'This library has more tagged files than one tags export can hold.';
const TOO_MANY_FOLDERS = 'This library has more library folders than one tags export can list.';

type Line = Record<string, unknown>;
/** `FileHandle.write` as the exporter calls it. */
type Write = (
  data: Uint8Array,
  offset: number,
  length: number,
) => Promise<{ readonly bytesWritten: number }>;

describe('TagExporter', () => {
  let dir: string;
  let exportsDir: string;
  let destination: string;
  let library: TestLibrary;
  let settings: SettingsRepository;
  let offline: Set<number>;
  /** Files whose fingerprint was read, by id. */
  let reads: number[];
  let progress: (TagTransferProgress | null)[];
  let onProgress: () => void;
  let exporter: TagExporter;

  /** The lines of the tags export at `file`, parsed. */
  const linesOf = async (file = destination): Promise<Line[]> =>
    (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Line);
  /** The file lines of the tags export at `file`. */
  const entriesOf = async (file = destination): Promise<Line[]> =>
    (await linesOf(file)).slice(1, -1);
  const rename = (id: number, name: string): void => {
    library.files.relocate(id, {
      rootId: library.root.id,
      path: `/library/${name}`,
      dir: '',
      name,
      ext: 'jpg',
      kind: 'image',
      size: 1_000,
      mtimeMs: 1,
      birthtimeMs: null,
      fileId: null,
    });
  };
  /** Makes opening the files `match` accepts fail with `code`. */
  const failOpen = (match: (file: string) => boolean, code: string): void => {
    vi.mocked(open).mockImplementation((target, flags, mode) =>
      match(String(target)) ? Promise.reject(systemError(code)) : realOpen(target, flags, mode),
    );
  };
  /** Makes writing to the files `match` accepts fail with `code`, once they are opened. */
  const failWrites = (match: (file: string) => boolean, code: string): void => {
    vi.mocked(open).mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (match(String(target))) {
        vi.spyOn(handle, 'write').mockRejectedValue(systemError(code));
      }
      return handle;
    });
  };
  /**
   * Makes each write to the files `match` accepts go through `write`, given the real write and how
   * many writes to that file came before. Text is written as UTF-8 bytes, all of them by default.
   */
  const onWrites = (
    match: (file: string) => boolean,
    write: (
      real: Write,
      call: number,
      data: Uint8Array,
      offset: number,
      length: number,
    ) => ReturnType<Write>,
  ): void => {
    vi.mocked(open).mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (match(String(target))) {
        const real = handle.write.bind(handle) as Write;
        let calls = 0;
        vi.spyOn(handle, 'write').mockImplementation(((
          data: Uint8Array | string,
          offset = 0,
          length?: number,
        ) => {
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          return write(real, calls++, bytes, offset, length ?? bytes.length - offset);
        }) as never);
      }
      return handle;
    });
  };
  const inExports = (file: string): boolean => path.dirname(file) === exportsDir;
  /** An exporter of `library`, as the library makes one, with `options` changed. */
  const createExporter = (options: Partial<TagExporterOptions> = {}): TagExporter => {
    const created: TagExporter = new TagExporter({
      files: library.files,
      tags: library.tags,
      roots: library.roots,
      settings,
      exportsDir,
      isOnline: (rootId) => !offline.has(rootId),
      onProgress: () => {
        progress.push(created.progress);
        onProgress();
      },
      fingerprint: (target: FingerprintTarget) => {
        reads.push(target.id);
        return fingerprint(target.path, target.size);
      },
      ...options,
    });
    return created;
  };
  /** The tags export at `destination`, read as an import reads it. */
  const readBack = (): ReturnType<typeof readTagFile> =>
    readTagFile(destination, { signal: new AbortController().signal, onBytes: () => undefined });
  /**
   * Removes every tag from `ids`, then imports the tags export at `destination` back, as on the
   * computer it was exported from.
   */
  const restore = async (ids: readonly number[]): Promise<TagImportResult> => {
    library.tags.removeFromFiles(
      ids,
      library.tags.list().map((tag) => tag.id),
    );
    library.tags.pruneUnused();
    const importer = new TagImporter({
      files: library.files,
      tags: library.tags,
      roots: library.roots,
      isOnline: (rootId) => !offline.has(rootId),
      whenIndexed: () => Promise.resolve(),
      onTagged: () => undefined,
      onImported: () => undefined,
      onProgress: () => undefined,
      read: () => Promise.reject(new Error('Not read.')),
    });
    const source = await importer.open(destination);
    const preview = await importer.plan(source.token);
    return importer.apply(source.token, preview.planId, false);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-export-'));
    exportsDir = path.join(dir, 'data', 'exports');
    destination = path.join(dir, 'SG Tag tags 2026-10-19.jsonl');
    library = createTestLibrary();
    settings = new SettingsRepository(library.db);
    offline = new Set();
    reads = [];
    progress = [];
    onProgress = () => undefined;
    exporter = createExporter();
  });

  afterEach(async () => {
    vi.mocked(open).mockReset();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('exports every tagged file, missing and offline ones included, flagged missing', async () => {
    const drive = library.roots.insert('/drive');
    offline.add(drive.id);
    const photo = library.addFile('trips/photo.jpg', {
      size: 10,
      mtimeMs: 5,
      fingerprint: PRINT,
      contentHash: HASH,
    });
    library.addFile('untagged.jpg');
    const gone = library.addFile('gone.jpg', { size: 20, mtimeMs: 6, missingSince: 1 });
    const away = library.addFile('away.jpg', { size: 30, mtimeMs: 7, root: drive });
    library.tags.addToFiles([photo, gone, away], ['trips/2024']);

    expect(await exporter.export(destination, APP)).toEqual({
      path: destination,
      files: 3,
      missing: 1,
      tags: 2,
      leftOut: 0,
    });

    const lines = await linesOf();
    expect(lines[0]).toEqual({
      format: 'sg-tag/tags',
      version: 1,
      app: APP,
      exportedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
      platform: process.platform,
      fingerprint: FINGERPRINT_SCHEME,
      roots: [{ path: '/drive' }, { path: '/library' }],
    });
    const defaults = { fingerprint: null, sha256: null, missing: false, tags: ['trips/2024'] };
    expect(lines.slice(1)).toEqual([
      {
        ...defaults,
        root: 1,
        rel: 'trips/photo.jpg',
        path: '/library/trips/photo.jpg',
        size: 10,
        mtimeMs: 5,
        fingerprint: PRINT,
        sha256: HASH,
      },
      {
        ...defaults,
        root: 1,
        rel: 'gone.jpg',
        path: '/library/gone.jpg',
        size: 20,
        mtimeMs: 6,
        missing: true,
      },
      { ...defaults, root: 0, rel: 'away.jpg', path: '/drive/away.jpg', size: 30, mtimeMs: 7 },
      { end: true, files: 3 },
    ]);
    // Neither missing nor offline files are read.
    expect(reads).toEqual([]);
    const read = await readTagFile(destination, {
      signal: new AbortController().signal,
      onBytes: () => undefined,
    });
    expect(read.entries).toHaveLength(3);
  });

  it('writes `rel` in NFC for a name decomposed on disk, and `path` as indexed', async () => {
    const pictures = path.join(dir, 'Pictures');
    const decomposed = path.join(pictures, 'Été'.normalize('NFD'), 'café.jpg'.normalize('NFD'));
    await mkdir(path.dirname(decomposed), { recursive: true });
    await writeFile(decomposed, 'content');
    const root = library.roots.insert(pictures);
    await new Reconciler(library.files).syncRoot(root, await statFiles(await crawl(pictures)));
    const [indexed] = library.files.listForRoot(root.id).values();
    library.tags.addToFiles([indexed?.id ?? 0], ['cafés']);

    await exporter.export(destination, APP);

    const [entry] = await entriesOf();
    expect(entry?.['rel']).toBe('Été/café.jpg'.normalize('NFC'));
    expect(entry?.['path']).toBe(indexed?.path);
    expect(entry?.['path']).toBe(decomposed);
  });

  it('writes files by id with their tags in any case order, the same each time', async () => {
    const zebra = library.addFile('zebra.jpg', { mtimeMs: 1 });
    const apple = library.addFile('apple.jpg', { mtimeMs: 2 });
    library.tags.addToFiles([apple], ['trips']);
    library.tags.addToFiles([zebra], ['beta', 'Alpha', 'gamma/Delta']);
    const again = path.join(dir, 'again.jsonl');

    await exporter.export(destination, APP);
    await exporter.export(again, APP);

    const entries = await entriesOf();
    expect(entries.map((entry) => [entry['rel'], entry['tags']])).toEqual([
      ['zebra.jpg', ['Alpha', 'beta', 'gamma/Delta']],
      ['apple.jpg', ['trips']],
    ]);
    // Only the time of the export differs.
    const undated = async (file: string): Promise<string> =>
      (await readFile(file, 'utf8')).replace(/"exportedAt":"[^"]+"/, '');
    expect(await undated(again)).toBe(await undated(destination));
  });

  it('reads and keeps the fingerprints that tagged files on connected drives lack', async () => {
    const pictures = path.join(dir, 'Pictures');
    const drivePath = path.join(dir, 'Drive');
    await mkdir(pictures);
    await mkdir(drivePath);
    for (const name of ['a.jpg', 'printed.jpg', 'untagged.jpg', 'deleted.jpg']) {
      await writeFile(path.join(pictures, name), `content of ${name}`);
    }
    await writeFile(path.join(drivePath, 'away.jpg'), 'content of away.jpg');
    const root = library.roots.insert(pictures);
    const drive = library.roots.insert(drivePath);
    for (const each of [root, drive]) {
      await new Reconciler(library.files).syncRoot(each, await statFiles(await crawl(each.path)));
    }
    const indexed = (filePath: string): IndexedFile => {
      const file = library.files.findByPath(filePath);
      expect(file).toBeDefined();
      return file as IndexedFile;
    };
    const a = indexed(path.join(pictures, 'a.jpg'));
    const printed = indexed(path.join(pictures, 'printed.jpg'));
    const deleted = indexed(path.join(pictures, 'deleted.jpg'));
    const away = indexed(path.join(drivePath, 'away.jpg'));
    const gone = library.addFile('gone.jpg', { root, missingSince: 1 });
    library.files.setFingerprint(printed, PRINT);
    library.tags.addToFiles([a.id, printed.id, deleted.id, away.id, gone], ['t']);
    // Deleted since it was indexed: it cannot be read.
    await rm(deleted.path);
    offline.add(drive.id);

    await exporter.export(destination, APP);

    const print = await fingerprint(a.path, a.size);
    const prints = Object.fromEntries(
      (await entriesOf()).map((entry) => [String(entry['rel']), entry['fingerprint']] as const),
    );
    expect(prints).toEqual({
      'a.jpg': print,
      'printed.jpg': PRINT,
      'deleted.jpg': null,
      'away.jpg': null,
      'gone.jpg': null,
    });
    // Each once.
    const byId = (x: number, y: number): number => x - y;
    expect(reads.toSorted(byId)).toEqual([a.id, deleted.id].toSorted(byId));
    // Kept, as the background fingerprinter would.
    expect(indexed(a.path).fingerprint).toBe(print);
    expect(library.files.needingFingerprint([a.id, deleted.id])).toEqual([
      { id: deleted.id, path: deleted.path, size: deleted.size, mtimeMs: deleted.mtimeMs },
    ]);
  });

  it('writes the tags of a file in a line its import reads whole, up to the tags it takes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    const many = library.addFile('many.jpg');
    const trip = library.addFile('trip.jpg');
    // The most an import takes: 1,000 tags of 1,024 characters, each of 6 bytes as JSON.
    const longest = Array.from({ length: 999 }, (_, index) =>
      String(index).padEnd(1_024, '\u0001'),
    );
    library.tags.addToFiles([photo], ['people/Ana', ...longest]);
    // One tag past that, of 3 bytes a character.
    const past = Array.from({ length: 1_001 }, (_, index) =>
      String(index).padStart(4, '0').padEnd(1_024, '語'),
    );
    library.tags.addToFiles([many], past);
    library.tags.addToFiles([trip], ['trips/2024']);

    expect(await exporter.export(destination, APP)).toMatchObject({
      files: 3,
      missing: 0,
      leftOut: 1,
    });

    const [, photoLine] = (await readFile(destination, 'utf8')).split('\n');
    expect(Buffer.byteLength(photoLine ?? '')).toBeGreaterThan(6_000_000);
    const read = await readTagFile(destination, {
      signal: new AbortController().signal,
      onBytes: () => undefined,
    });
    expect(read.entries.map((entry) => entry.segments)).toEqual([
      ['photo.jpg'],
      ['many.jpg'],
      ['trip.jpg'],
    ]);
    expect(read.entries[0]?.tags.toSorted()).toEqual(['people/Ana', ...longest].toSorted());
    // Past them, tags are left out of the export, which says so: the import has nothing to leave.
    expect(read.entries[1]?.tags).toEqual(past.slice(0, 1_000));
    expect(read.problems).toEqual([]);
  });

  it('leaves out the tags an import would, and says how many, so no line is too long', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pasted = library.addFile('pasted.jpg');
    const wordy = library.addFile('wordy.jpg');
    const odd = library.addFile('odd.jpg');
    const none = library.addFile('none.jpg');
    // Nothing keeps a tag from being this long: a pasted text, longer than a line may be.
    library.tags.addToFiles([pasted], ['people/Ana', `note ${'x'.repeat(MAX_LINE_BYTES)}`]);
    // One more tag than a file may carry.
    const words = Array.from(
      { length: 1_001 },
      (_, index) => `word ${String(index).padStart(4, '0')}`,
    );
    library.tags.addToFiles([wordy], words);
    library.tags.addToFiles(
      [odd],
      ['trips/2024', `deep${'/level'.repeat(64)}`, `q${'̖'.repeat(31)}`],
    );
    library.tags.addToFiles([none], [`q${'̖'.repeat(40)}`]);

    // Each tag left out once: 1 + 1 + 2 + 1.
    expect(await exporter.export(destination, APP)).toMatchObject({ files: 3, leftOut: 5 });

    for (const line of (await readFile(destination, 'utf8')).split('\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    }
    const read = await readTagFile(destination, {
      signal: new AbortController().signal,
      onBytes: () => undefined,
    });
    expect(read.problems).toEqual([]);
    expect(read.entries.map((entry) => [entry.segments, entry.tags])).toEqual([
      [['pasted.jpg'], ['people/Ana']],
      [['wordy.jpg'], words.slice(0, 1_000)],
      [['odd.jpg'], ['trips/2024']],
    ]);
    expect(warn).toHaveBeenCalledWith(
      '[tag-transfer]',
      'Left out 5 tags a tags export cannot hold (too long, too deep, ' +
        'with a long run of combining marks, or too many on one file)',
    );
  });

  it('counts each tag left out once, however many files it is left out of', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ids = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => library.addFile(name));
    library.tags.addToFiles(ids, [`note ${'x'.repeat(1_024)}`, 'kept']);
    // Tags of a file are written in order: past 1,000, the last is left out of this file only.
    const many = library.addFile('many.jpg');
    const tags = Array.from(
      { length: 1_001 },
      (_, index) => `tag ${String(index).padStart(4, '0')}`,
    );
    library.tags.addToFiles([many], tags);
    library.tags.addToFiles([ids[0] ?? 0], ['tag 1000']);

    expect(await exporter.export(destination, APP)).toMatchObject({ files: 4, leftOut: 2 });

    expect((await entriesOf()).map((entry) => [entry['rel'], entry['tags']])).toEqual([
      ['a.jpg', ['kept', 'tag 1000']],
      ['b.jpg', ['kept']],
      ['c.jpg', ['kept']],
      ['many.jpg', tags.slice(0, 1_000)],
    ]);
  });

  it('refuses, before saving it, an export larger than its import reads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await exporter.export(path.join(dir, 'earlier.jsonl'), APP);
    const recorded = settings.lastTagExport();
    // The same export again takes as many bytes: only its time differs.
    const { size } = await stat(path.join(dir, 'earlier.jsonl'));
    await writeFile(destination, EARLIER);

    exporter = createExporter({ maxBytes: size - 1 });
    await expect(exporter.export(destination, APP)).rejects.toThrow(TOO_LARGE);
    expect(await readFile(destination, 'utf8')).toBe(EARLIER);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toEqual(recorded);
    expect(exporter.busy).toBe(false);

    // An export it saves, its import reads, at the limit and past it.
    exporter = createExporter({ maxBytes: size });
    expect(await exporter.export(destination, APP)).toMatchObject({ files: 1 });
    const reading = { signal: new AbortController().signal, onBytes: () => undefined };
    expect(await readTagFile(destination, { ...reading, maxBytes: size })).toMatchObject({
      entries: [expect.objectContaining({ segments: ['photo.jpg'] })],
    });
    await expect(readTagFile(destination, { ...reading, maxBytes: size - 1 })).rejects.toThrow(
      'This file is too large to be an SG Tag tags export.',
    );
  });

  it('stops writing an export once it is larger than its import reads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // More than a page of 1,000 files, the first page already past the limit.
    const ids = Array.from({ length: 1_002 }, (_, index) => library.addFile(`${index}.jpg`));
    library.tags.addToFiles(ids, ['t']);
    exporter = createExporter({ maxBytes: 10_000 });

    await expect(exporter.export(destination, APP)).rejects.toThrow(TOO_LARGE);
    expect(warn).toHaveBeenCalledWith(
      '[tag-transfer]',
      'Not saving the tags export: past 10000 bytes with 1000 tagged files written, ' +
        'an import would refuse it',
    );
    // The files of the next page are neither read nor written.
    expect(reads).toHaveLength(1_000);
    expect(progress).toEqual([
      { step: 'exporting', done: 0, total: 1_002 },
      { step: 'exporting', done: 1_000, total: 1_002 },
      null,
    ]);
    expect(existsSync(destination)).toBe(false);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
  });

  it('exports every library folder, whatever its combining marks, and imports its files back', async () => {
    // Names pasted from a "Zalgo" generator: 31 marks in a row, the most macOS takes, and 40,
    // which Windows and Linux take.
    const marks = (count: number): string =>
      Array.from({ length: count }, (_, index) => String.fromCharCode(0x0316 + (index % 32))).join(
        '',
      );
    const memes = library.roots.insert(`/Volumes/Memes h${marks(31)}ello`);
    const more = library.roots.insert(`/Volumes/More h${marks(40)}ello`);
    const photos = ['2024/a.jpg', '2024/b.jpg', '2024/c.jpg'].map((rel, index) =>
      library.addFile(rel, { fingerprint: String(index).repeat(32) }),
    );
    const meme = library.addFile('cat.jpg', { root: memes, fingerprint: '8'.repeat(32) });
    const other = library.addFile('dog.jpg', { root: more, fingerprint: '9'.repeat(32) });
    library.tags.addToFiles(photos, ['trips/japan']);
    library.tags.addToFiles([meme, other], ['funny']);

    expect(await exporter.export(destination, APP)).toMatchObject({ files: 5 });
    expect((await readBack()).header.roots).toEqual([memes.path, more.path, '/library']);

    const ids = [...photos, meme, other];
    expect(await restore(ids)).toMatchObject({ assignments: 5, files: 5, notFound: 0 });
    expect(library.tags.pathsForFiles(ids)).toEqual(
      new Map<number, string[]>([
        ...photos.map((id): [number, string[]] => [id, ['trips/japan']]),
        [meme, ['funny']],
        [other, ['funny']],
      ]),
    );
  });

  it('exports a file at the longest path Windows takes, and imports its tags back', async () => {
    // 127 folders of 255 units, the most a name takes, each about 760 in NFC (U+FB2C is 3), and a
    // name: a path of 32,767 units, the most Windows takes, and `rel` of nearly 3 times that.
    const pictures = library.roots.insert('C:\\Users\\seb\\Pictures');
    const folders = Array.from({ length: 127 }, (_, index) => String(index).padEnd(255, '\uFB2C'));
    const name = `${'x'.repeat(229)}.jpg`;
    const file = {
      path: [pictures.path, ...folders, name].join('\\'),
      size: 1_000,
      mtimeMs: 1,
    };
    expect(file.path).toHaveLength(32_767);
    const id = library.files.insert({
      ...file,
      rootId: pictures.id,
      dir: folders.join('/').normalize('NFC'),
      name,
      ext: 'jpg',
      kind: 'image',
      birthtimeMs: null,
      fileId: null,
    });
    library.files.setFingerprint({ id, ...file }, PRINT);
    library.tags.addToFiles([id], ['scans/1998']);

    expect(await exporter.export(destination, APP)).toMatchObject({ files: 1 });
    const [entry] = await entriesOf();
    expect(String(entry?.['rel']).length).toBeGreaterThan(2.9 * 32_767);
    expect(entry?.['path']).toBe(file.path);
    const read = await readBack();
    expect(read.problems).toEqual([]);
    expect(read.entries[0]?.segments).toEqual([
      ...folders.map((folder) => folder.normalize('NFC')),
      name,
    ]);

    expect(await restore([id])).toMatchObject({ assignments: 1, files: 1, notFound: 0 });
    expect(library.tags.pathsForFiles([id])).toEqual(new Map([[id, ['scans/1998']]]));
  });

  it('refuses, and writes nothing, an export whose header its import would refuse', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    // At the longest path, of characters JSON escapes: a header holds 37 of them, not 38.
    const longest = Array.from({ length: 38 }, (_, index) =>
      library.roots.insert(`/${index}`.padEnd(32_767, '\u0001')),
    );

    await expect(exporter.export(destination, APP)).rejects.toThrow(TOO_MANY_FOLDERS);
    expect(warn).toHaveBeenLastCalledWith(
      '[tag-transfer]',
      expect.stringMatching(
        /^Not exporting: an import would refuse the header listing 39 library folders, of \d+ bytes$/,
      ),
    );
    expect(existsSync(exportsDir)).toBe(false);
    expect(await readFile(destination, 'utf8')).toBe(EARLIER);
    expect(settings.lastTagExport()).toBeNull();

    library.roots.delete(longest.pop()?.id ?? 0);
    expect(await exporter.export(destination, APP)).toMatchObject({ files: 1 });
    expect((await readBack()).header.roots).toHaveLength(38);

    // As many library folders as a header lists, then one more.
    for (const root of longest) {
      library.roots.delete(root.id);
    }
    for (let index = 1; index < 10_000; index++) {
      library.roots.insert(`/Volumes/${index}`);
    }
    expect(await exporter.export(destination, APP)).toMatchObject({ files: 1 });
    expect((await readBack()).header.roots).toHaveLength(10_000);
    library.roots.insert('/Volumes/more');
    await expect(exporter.export(destination, APP)).rejects.toThrow(TOO_MANY_FOLDERS);
  });

  it('writes the export in the data folder, then saves it where asked and records it', async () => {
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    const during: { readonly exports: string[]; readonly destination: string }[] = [];
    onProgress = () => {
      if (exporter.progress?.done === 1) {
        during.push({
          exports: readdirSync(exportsDir),
          destination: readFileSync(destination, 'utf8'),
        });
      }
    };
    const before = Date.now();

    await exporter.export(destination, APP);

    expect(during).toEqual([
      {
        exports: [expect.stringMatching(/^[0-9a-f-]{36}\.jsonl$/) as string],
        destination: EARLIER,
      },
    ]);
    expect(await entriesOf()).toHaveLength(1);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toEqual({
      at: expect.any(Number) as number,
      path: destination,
      files: 1,
    });
    expect(settings.lastTagExport()?.at).toBeGreaterThanOrEqual(before);
    expect(progress).toEqual([
      { step: 'exporting', done: 0, total: 1 },
      { step: 'exporting', done: 1, total: 1 },
      null,
    ]);
    expect(exporter.busy).toBe(false);
  });

  it('runs one export at a time', async () => {
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);

    const first = exporter.export(destination, APP);
    expect(exporter.busy).toBe(true);
    await expect(exporter.export(path.join(dir, 'other.jsonl'), APP)).rejects.toThrow(
      'A tags export is already being written.',
    );
    await first;
    expect(exporter.busy).toBe(false);
    expect(existsSync(path.join(dir, 'other.jsonl'))).toBe(false);
  });

  it('refuses to export when no file is tagged, and creates nothing', async () => {
    library.addFile('photo.jpg');

    await expect(exporter.export(destination, APP)).rejects.toThrow(
      'Nothing to export yet: no file is tagged.',
    );
    expect(existsSync(exportsDir)).toBe(false);
    expect(existsSync(destination)).toBe(false);
    expect(settings.lastTagExport()).toBeNull();
    expect(progress).toEqual([]);
  });

  it('leaves the destination as it was when writing the export fails, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    failWrites(inExports, 'ENOSPC');

    const error = await exporter.export(destination, APP).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The tags export could not be written: the disk of SG Tag’s data folder is full.',
    );
    expect((error as Error).cause).toMatchObject({ code: 'ENOSPC' });
    expect(warn).toHaveBeenCalledWith(
      '[tag-transfer]',
      `Cannot write the tags export in ${exportsDir}:`,
      'ENOSPC',
    );
    expect(await readFile(destination, 'utf8')).toBe(EARLIER);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
    expect(exporter.progress).toBeNull();
  });

  it('says why the export cannot be written in the data folder, in words about that folder', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    const reasons = {
      EACCES: 'SG Tag is not allowed to write in its data folder',
      EPERM: 'SG Tag is not allowed to write in its data folder',
      ENOSPC: 'the disk of SG Tag’s data folder is full',
      EROFS: 'the disk of SG Tag’s data folder is read-only',
      EIO: 'an error occurred while writing it',
    };

    for (const [code, reason] of Object.entries(reasons)) {
      failOpen(inExports, code);
      await expect(exporter.export(destination, APP)).rejects.toThrow(
        `The tags export could not be written: ${reason}.`,
      );
    }
    vi.mocked(open).mockReset();
    // The folder for exports cannot even be made.
    await rm(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, 'data'), 'not a folder');
    await expect(exporter.export(destination, APP)).rejects.toThrow(
      'The tags export could not be written: an error occurred while writing it.',
    );
    expect(existsSync(destination)).toBe(false);
    expect(settings.lastTagExport()).toBeNull();
  });

  it('writes every byte when the disk takes only part of each write', async () => {
    const ids = Array.from({ length: 3 }, (_, index) => library.addFile(`${index}.jpg`));
    library.tags.addToFiles(ids, ['trips/2024']);
    onWrites(
      (file) => file === destination || inExports(file),
      (real, _call, data, offset, length) => real(data, offset, Math.min(length, 7)),
    );

    expect(await exporter.export(destination, APP)).toMatchObject({ files: 3 });

    const read = await readTagFile(destination, {
      signal: new AbortController().signal,
      onBytes: () => undefined,
    });
    expect(read.entries.map((entry) => entry.segments)).toEqual([['0.jpg'], ['1.jpg'], ['2.jpg']]);
  });

  it('deletes the destination when the disk fills up within its last write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    // As on Linux: part of the write is taken without an error, and only the next write fails.
    onWrites(
      (file) => file === destination,
      (real, call, data, offset, length) =>
        call === 0
          ? real(data, offset, Math.ceil(length / 2))
          : Promise.reject(systemError('ENOSPC')),
    );

    await expect(exporter.export(destination, APP)).rejects.toThrow(
      'The tags export could not be saved: the disk is full.',
    );
    expect(existsSync(destination)).toBe(false);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
  });

  it('says the export cannot be written when the data folder fills up within its last line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    // The header, the page of files, then the trailer, of which only a part is taken.
    onWrites(inExports, (real, call, data, offset, length) => {
      if (call > 2) {
        return Promise.reject(systemError('ENOSPC'));
      }
      return real(data, offset, call === 2 ? Math.ceil(length / 2) : length);
    });

    await expect(exporter.export(destination, APP)).rejects.toThrow(
      'The tags export could not be written: the disk of SG Tag’s data folder is full.',
    );
    expect(await readFile(destination, 'utf8')).toBe(EARLIER);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
  });

  it('deletes the destination rather than leave it cut short when saving fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    failWrites((file) => file === destination, 'ENOSPC');

    await expect(exporter.export(destination, APP)).rejects.toThrow(
      'The tags export could not be saved: the disk is full.',
    );
    expect(existsSync(destination)).toBe(false);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[tag-transfer]',
      `Cannot save the tags export to ${destination}:`,
      'ENOSPC',
    );
  });

  it('leaves the destination as it was when it cannot be opened, and says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    const reasons = {
      EACCES: 'SG Tag is not allowed to write there',
      EPERM: 'SG Tag is not allowed to write there',
      ENOSPC: 'the disk is full',
      EROFS: 'that disk is read-only',
      EIO: 'the file could not be written',
    };

    const isDestination = (file: string): boolean => file === destination;
    for (const [code, reason] of Object.entries(reasons)) {
      failOpen(isDestination, code);
      await expect(exporter.export(destination, APP)).rejects.toThrow(
        `The tags export could not be saved: ${reason}.`,
      );
      expect(await readFile(destination, 'utf8')).toBe(EARLIER);
    }
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
  });

  it('stops while writing the export, leaving nothing and the destination as it was', async () => {
    const ids = Array.from({ length: 1_002 }, (_, index) => library.addFile(`${index}.jpg`));
    library.tags.addToFiles(ids, ['t']);
    await writeFile(destination, EARLIER);
    let stopping: Promise<void> | undefined;
    let left: string[] | undefined;
    onProgress = () => {
      if (exporter.progress?.done === 1_000) {
        stopping = exporter.stop().then(() => {
          left = readdirSync(exportsDir);
        });
      }
    };

    const exporting = exporter.export(destination, APP);
    const outcome = exporting.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(stopping).toBeDefined();
    });
    await stopping;

    // Done by the time `stop` resolves.
    expect(left).toEqual([]);
    expect(exporter.busy).toBe(false);
    expect(await outcome).toEqual(new Error(STOPPED));
    expect(await readFile(destination, 'utf8')).toBe(EARLIER);
    expect(settings.lastTagExport()).toBeNull();
    expect(progress.at(-1)).toBeNull();
  });

  it('stops while saving, deleting the destination it opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    await writeFile(destination, EARLIER);
    let stopping: Promise<void> | undefined;
    onWrites(
      (file) => file === destination,
      (real, _call, data, offset, length) => {
        stopping ??= exporter.stop();
        return real(data, offset, length);
      },
    );

    await expect(exporter.export(destination, APP)).rejects.toThrow(STOPPED);
    await stopping;
    expect(existsSync(destination)).toBe(false);
    expect(await readdir(exportsDir)).toEqual([]);
    expect(settings.lastTagExport()).toBeNull();
    // Not a failure to report.
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops at once when no export runs, and exports again after a stop', async () => {
    await exporter.stop();
    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    const first = exporter.export(path.join(dir, 'first.jsonl'), APP);
    await exporter.stop();
    await expect(first).rejects.toThrow(STOPPED);

    expect(await exporter.export(destination, APP)).toMatchObject({ files: 1 });
    await exporter.stop();
    expect(await entriesOf()).toHaveLength(1);
    expect(settings.lastTagExport()?.path).toBe(destination);
  });

  it('exports a file renamed between two pages once', async () => {
    // More than a page of 1,000 files.
    const ids = Array.from({ length: 1_002 }, (_, index) => library.addFile(`${index}.jpg`));
    library.tags.addToFiles(ids, ['t']);
    onProgress = () => {
      if (exporter.progress?.done === 1_000) {
        rename(ids[0] ?? 0, 'first-renamed.jpg');
        rename(ids.at(-1) ?? 0, 'last-renamed.jpg');
      }
    };

    expect(await exporter.export(destination, APP)).toMatchObject({ files: 1_002 });

    const rels = (await entriesOf()).map((entry) => entry['rel']);
    expect(rels).toHaveLength(1_002);
    expect(new Set(rels).size).toBe(1_002);
    // Written before it was renamed, and after.
    expect(rels[0]).toBe('0.jpg');
    expect(rels.at(-1)).toBe('last-renamed.jpg');
  });

  it('cleans up exports left by an earlier run, but not the one being written', async () => {
    await exporter.cleanUp();
    await mkdir(exportsDir, { recursive: true });
    await writeFile(path.join(exportsDir, `${randomUUID()}.jsonl`), 'left over');
    await exporter.cleanUp();
    expect(await readdir(exportsDir)).toEqual([]);

    const photo = library.addFile('photo.jpg');
    library.tags.addToFiles([photo], ['t']);
    let cleaning = Promise.resolve();
    onProgress = () => {
      if (exporter.progress?.done === 1) {
        cleaning = exporter.cleanUp();
      }
    };
    await exporter.export(destination, APP);
    await cleaning;
    expect(await entriesOf()).toHaveLength(1);
  });
});

/** A failure as the file system reports it. */
function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

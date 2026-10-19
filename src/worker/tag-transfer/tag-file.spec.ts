import { mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import type { TaggedFileRow } from '../library/files-repository';
import { Slicer } from './slices';
import type { ParsedTagFile } from './tag-file';
import {
  endLine,
  entryLine,
  exportedPath,
  exportedTags,
  headerLine,
  MAX_DISTINCT_TAGS,
  MAX_HEADER_BYTES,
  MAX_LINE_BYTES,
  MAX_TAG_FILE_BYTES,
  nfcOf,
  readsHeader,
  readTagFile,
} from './tag-file';

const NOT_AN_EXPORT = 'This is not an SG Tag tags export.';
const INCOMPLETE =
  'This tags export is incomplete: it may have been cut short while being copied. Export the tags again.';

const HEADER = {
  app: '2026.10.0-alpha.1',
  exportedAt: '2026-10-19T08:30:00.000Z',
  platform: 'darwin',
  fingerprint: FINGERPRINT_SCHEME,
  roots: ['/Users/seb/Pictures', '/Volumes/Archive'],
};
const PRINT = '9f86d081884c7d659a2feaa0c55ad015';
const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('tags export files', () => {
  let dir: string;
  let file: string;

  /** A header line, with one library folder at `/a` and `fields` changed. */
  const header = (fields: Record<string, unknown> = {}): string =>
    JSON.stringify({
      format: 'sg-tag/tags',
      version: 1,
      ...HEADER,
      roots: [{ path: '/a' }],
      ...fields,
    });
  /** A file line, with `fields` changed. */
  const entry = (fields: Record<string, unknown> = {}): string =>
    JSON.stringify({ root: 0, rel: 'a.jpg', size: 10, mtimeMs: 5, tags: ['t'], ...fields });
  const trailer = (files: number): string => JSON.stringify({ end: true, files });
  /** Writes `lines`, each followed by `ending`. */
  const write = (lines: readonly (string | Buffer)[], ending = '\n'): Promise<void> =>
    writeFile(
      file,
      Buffer.concat(lines.flatMap((text) => [Buffer.from(text), Buffer.from(ending)])),
    );
  /** Writes a tags export of these file lines. */
  const exportOf = (...lines: (string | Buffer)[]): Promise<void> =>
    write([header(), ...lines, trailer(lines.length)]);
  const read = (
    options: {
      readonly chunkSize?: number;
      readonly onBytes?: (read: number, total: number) => void;
    } = {},
  ): Promise<ParsedTagFile> =>
    readTagFile(file, {
      signal: new AbortController().signal,
      onBytes: () => undefined,
      ...options,
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-tag-file-'));
    file = path.join(dir, 'SG Tag tags 2026-10-19.jsonl');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a header, a line per file and a trailer that read back as the same files', async () => {
    const photo: TaggedFileRow = {
      id: 7,
      rootId: 3,
      path: '/Users/seb/Pictures/2024/Japan/IMG_1234.JPG',
      dir: '2024/Japan',
      name: 'IMG_1234.JPG',
      size: 4_718_233,
      mtimeMs: 1_717_171_717_000,
      fingerprint: PRINT,
      contentHash: null,
      missing: false,
    };
    const scan: TaggedFileRow = {
      ...photo,
      id: 9,
      path: '/Volumes/Archive/scan.tif',
      dir: '',
      name: 'scan.tif',
      size: 0,
      fingerprint: null,
      contentHash: HASH,
      missing: true,
    };
    const text = [
      headerLine(HEADER),
      entryLine(photo, 0, ['people/Ana', 'trips/2024/japan']),
      entryLine(scan, 1, ['family']),
      endLine(2),
    ].join('');

    expect(text.split('\n')).toEqual([
      '{"format":"sg-tag/tags","version":1,"app":"2026.10.0-alpha.1","exportedAt":"2026-10-19T08:30:00.000Z","platform":"darwin","fingerprint":"sha256(size,head64k,tail64k)/32","roots":[{"path":"/Users/seb/Pictures"},{"path":"/Volumes/Archive"}]}',
      `{"root":0,"rel":"2024/Japan/IMG_1234.JPG","path":"/Users/seb/Pictures/2024/Japan/IMG_1234.JPG","size":4718233,"mtimeMs":1717171717000,"fingerprint":"${PRINT}","sha256":null,"missing":false,"tags":["people/Ana","trips/2024/japan"]}`,
      `{"root":1,"rel":"scan.tif","path":"/Volumes/Archive/scan.tif","size":0,"mtimeMs":1717171717000,"fingerprint":null,"sha256":"${HASH}","missing":true,"tags":["family"]}`,
      '{"end":true,"files":2}',
      '',
    ]);
    await writeFile(file, text);
    expect(await read()).toEqual({
      header: {
        app: HEADER.app,
        exportedAt: HEADER.exportedAt,
        platform: 'darwin',
        roots: HEADER.roots,
      },
      entries: [
        {
          root: 0,
          segments: ['2024', 'Japan', 'IMG_1234.JPG'],
          path: photo.path,
          size: photo.size,
          mtimeMs: photo.mtimeMs,
          fingerprint: PRINT,
          sha256: null,
          missing: false,
          tags: ['people/Ana', 'trips/2024/japan'],
        },
        {
          root: 1,
          segments: ['scan.tif'],
          path: scan.path,
          size: 0,
          mtimeMs: scan.mtimeMs,
          fingerprint: null,
          sha256: HASH,
          missing: true,
          tags: ['family'],
        },
      ],
      invalid: 0,
      problems: [],
      // people, people/Ana, trips, trips/2024, trips/2024/japan and family.
      tagCount: 6,
    });
  });

  it('refuses a file larger than the cap without reading it', async () => {
    await writeFile(file, '');
    await truncate(file, MAX_TAG_FILE_BYTES + 1);
    const onBytes = vi.fn();

    await expect(read({ onBytes })).rejects.toThrow(
      'This file is too large to be an SG Tag tags export.',
    );
    expect(onBytes).not.toHaveBeenCalled();
  });

  it('refuses a file it cannot read', async () => {
    file = path.join(dir, 'gone.jsonl');
    await expect(read()).rejects.toThrow('Cannot read this file.');
    file = dir;
    await expect(read()).rejects.toThrow('Cannot read this file.');
  });

  it('refuses a binary file after its first line, or once its first line is too long', async () => {
    const video = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < video.length; index++) {
      video[index] = (index * 7) & 0xff;
    }
    await writeFile(file, video);
    const onBytes = vi.fn();
    await expect(read({ onBytes })).rejects.toThrow(NOT_AN_EXPORT);
    expect(onBytes).not.toHaveBeenCalled();

    await writeFile(file, Buffer.alloc(MAX_HEADER_BYTES + video.length, 'a'));
    let bytesRead = 0;
    await expect(
      read({
        onBytes: (bytes) => {
          bytesRead = bytes;
        },
      }),
    ).rejects.toThrow(NOT_AN_EXPORT);
    expect(bytesRead).toBeLessThanOrEqual(MAX_HEADER_BYTES);
  });

  it('refuses a header of another format, or without library folders', async () => {
    for (const fields of [
      { format: 'other' },
      { version: 0 },
      { version: '1' },
      { roots: { path: '/a' } },
      { roots: [] },
      { roots: [{ path: '' }] },
      { roots: ['/a'] },
    ]) {
      await write([header(fields), entry(), trailer(1)]);
      await expect(read()).rejects.toThrow(NOT_AN_EXPORT);
    }
    for (const first of ['', '[]', 'null', '{"format":"sg-tag/tags"']) {
      await write([first, entry(), trailer(1)]);
      await expect(read()).rejects.toThrow(NOT_AN_EXPORT);
    }
    await writeFile(file, '');
    await expect(read()).rejects.toThrow(NOT_AN_EXPORT);
  });

  it('reads the library folders of a header as written, whatever their combining marks', async () => {
    const folders = [
      // A name pasted from a "Zalgo" generator: 32 marks in a row.
      `/Volumes/Memes h${'\u0316\u0301'.repeat(16)}ello`,
      // Marks in the reverse of the order NFC puts them in, which it sorts in a time that grows
      // as the square of their number, up to the longest path: 650 ms to normalise.
      `/${'\u0301'.repeat(16_383)}${'\u0316'.repeat(16_383)}`,
    ];
    await write([
      header({ roots: folders.map((folder) => ({ path: folder })) }),
      entry(),
      trailer(1),
    ]);
    const normalize = vi.spyOn(String.prototype, 'normalize');

    expect((await read()).header.roots).toEqual(folders);
    // Matching normalises them, through `nfcOf`.
    expect(normalize.mock.contexts.map(String).filter((text) => folders.includes(text))).toEqual(
      [],
    );

    // Past the longest path a computer takes.
    await write([header({ roots: [{ path: `/${'x'.repeat(32_767)}` }] }), entry(), trailer(1)]);
    await expect(read()).rejects.toThrow(NOT_AN_EXPORT);
  });

  it('normalises a path unless it has a longer run of combining marks than a name holds', () => {
    // Out of the order NFC puts them in.
    const marks = (count: number): string =>
      `${'\u0301'.repeat(Math.ceil(count / 2))}${'\u0316'.repeat(Math.floor(count / 2))}`;
    const zalgo = `/Volumes/Memes h${marks(32)}ello`;
    const fullName = `/a/${marks(255)}/b`;
    expect(nfcOf(zalgo)).toBe(zalgo.normalize('NFC'));
    expect(nfcOf(zalgo)).not.toBe(zalgo);
    expect(nfcOf(fullName)).toBe(fullName.normalize('NFC'));
    expect(nfcOf('/Users/seb/E\u0301te\u0301')).toBe('/Users/seb/\u00c9t\u00e9');

    // No name holds these: each is kept as written, without trying.
    const pasted = `/a/${marks(256)}`;
    const longest = `/${marks(32_766)}`;
    const normalize = vi.spyOn(String.prototype, 'normalize');
    expect(nfcOf(pasted)).toBe(pasted);
    expect(nfcOf(longest)).toBe(longest);
    expect(normalize).not.toHaveBeenCalled();
    // The NFC of a name may have such a run, two marks for each U+0344: it is NFC already.
    const decomposed = `/a/${'\u0344'.repeat(255)}`.normalize('NFC');
    expect(decomposed).toHaveLength(3 + 510);
    expect(nfcOf(decomposed)).toBe(decomposed);
  });

  it('tells whether an import reads a header, by its size, folders and paths', () => {
    expect(readsHeader(headerLine(HEADER))).toBe(true);
    const many = Array.from({ length: 10_000 }, (_, index) => `/${index}`);
    expect(readsHeader(headerLine({ ...HEADER, roots: many }))).toBe(true);
    expect(readsHeader(headerLine({ ...HEADER, roots: [...many, '/more'] }))).toBe(false);
    // 32,767 characters JSON escapes: 37 of them fit, not 38.
    const longest = (index: number): string => `/${index}`.padEnd(32_767, '\u0001');
    const fits = Array.from({ length: 37 }, (_, index) => longest(index));
    const line = headerLine({ ...HEADER, roots: fits });
    expect(Buffer.byteLength(line) - 1).toBeLessThanOrEqual(MAX_HEADER_BYTES);
    expect(readsHeader(line)).toBe(true);
    expect(readsHeader(headerLine({ ...HEADER, roots: [...fits, longest(37)] }))).toBe(false);
    expect(readsHeader(headerLine({ ...HEADER, roots: [`/${'x'.repeat(32_767)}`] }))).toBe(false);
  });

  it('reads a header and a line at their limits, made slow to normalise, a little at a time', async () => {
    // Library folders at the longest path, of marks NFC would take 650 ms each to sort, as many as
    // the longest header holds.
    const roots: string[] = [];
    let first = headerLine(HEADER);
    for (let index = 0; ; index++) {
      const next = [...roots, `/${index}${'\u0301'.repeat(16_380)}${'\u0316'.repeat(16_380)}`];
      const line = headerLine({ ...HEADER, roots: next });
      if (Buffer.byteLength(line) - 1 > MAX_HEADER_BYTES) {
        break;
      }
      roots.push(next.at(-1) as string);
      first = line;
    }
    expect(roots.length).toBeGreaterThan(100);
    // And `rel` at its longest, of segments of marks NFC would take 6 s to sort as one.
    const segment = `${'\u0301'.repeat(383)}${'\u0316'.repeat(382)}`;
    const rel = [...Array.from({ length: 128 }, () => segment), segment.slice(0, 253)].join('/');
    expect(rel).toHaveLength(98_301);
    await writeFile(file, [first, `${entry({ rel })}\n`, endLine(1)].join(''));
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const parse = vi.spyOn(JSON, 'parse');

    const parsed = await read();
    // None normalised whole: a segment of `rel` takes well under a millisecond.
    const normalised = normalize.mock.contexts.map((text) => String(text).length);
    expect(Math.max(...normalised)).toBe(765);
    // Each line parsed once.
    expect(parse).toHaveBeenCalledTimes(3);
    expect(parsed.header.roots).toEqual(roots);
    expect(parsed.entries[0]?.segments.join('/')).toBe(rel.normalize('NFC'));

    // A header of nested arrays, which would take JSON.parse 200 ms, is not parsed.
    const depth = Math.floor((MAX_HEADER_BYTES - 1_000) / 2);
    const nested = header({ roots: `${'['.repeat(depth)}${']'.repeat(depth)}` }).replace(
      /"(\[+\]+)"/,
      '$1',
    );
    expect(Buffer.byteLength(nested)).toBeLessThanOrEqual(MAX_HEADER_BYTES);
    await write([nested, entry(), trailer(1)]);
    parse.mockClear();
    await expect(read()).rejects.toThrow(NOT_AN_EXPORT);
    expect(parse).not.toHaveBeenCalled();
  });

  it('asks to update SG Tag for a newer version', async () => {
    await write([header({ version: 2, roots: 'another shape' }), entry(), trailer(1)]);
    await expect(read()).rejects.toThrow(
      'This tags export was made by a newer version of SG Tag. Update SG Tag to import it.',
    );
  });

  it('refuses a tags export that was cut short', async () => {
    await write([header(), entry(), entry({ rel: 'b.jpg' })]);
    await expect(read()).rejects.toThrow(INCOMPLETE);

    await write([header(), entry(), entry({ rel: 'b.jpg' }), trailer(1)]);
    await expect(read()).rejects.toThrow(INCOMPLETE);

    await write([header(), entry(), trailer(1), entry({ rel: 'b.jpg' })]);
    await expect(read()).rejects.toThrow(INCOMPLETE);

    // Lines that cannot be read count among its files.
    await write([header(), entry(), '{', trailer(2)]);
    expect((await read()).invalid).toBe(1);
  });

  it('refuses a tags export that lists no file it can read', async () => {
    await exportOf(entry({ tags: [] }));
    await expect(read()).rejects.toThrow('This tags export lists no tagged file that can be read.');
  });

  it('accepts a BOM and CRLF, and ignores blank lines and unknown keys', async () => {
    await write(
      [`\uFEFF${header({ comment: 'hi' })}`, '', entry({ colour: 'red' }), '   ', trailer(1), ''],
      '\r\n',
    );

    const parsed = await read();
    expect(parsed.entries).toEqual([expect.objectContaining({ segments: ['a.jpg'], tags: ['t'] })]);
    expect(parsed.invalid).toBe(0);
  });

  it('keeps the platform it was exported from only when Node knows it', async () => {
    for (const [platform, kept] of [
      ['constructor', null],
      ['toString', null],
      ['plan9', null],
      ['freebsd', 'freebsd'],
      ['win32', 'win32'],
    ] as const) {
      await write([header({ platform }), entry(), trailer(1)]);
      expect((await read()).header.platform).toBe(kept);
    }
  });

  it('ignores malformed header details', async () => {
    await write([
      header({
        app: 'x'.repeat(65),
        exportedAt: 'the day before yesterday',
        platform: 'Darwin; rm -rf',
        fingerprint: 42,
      }),
      entry(),
      trailer(1),
    ]);
    expect((await read()).header).toEqual({
      app: null,
      exportedAt: null,
      platform: null,
      roots: ['/a'],
    });

    await write([header({ exportedAt: '2026-10-19T10:30:00+02:00' }), entry(), trailer(1)]);
    expect((await read()).header.exportedAt).toBe('2026-10-19T08:30:00.000Z');
  });

  it('writes the path of a file from its library folder when its line does not say', async () => {
    await exportOf(entry({ rel: '2024/a.jpg', path: undefined }));
    const parsed = await read();
    // Built on demand only: a library folder's path may be long, and entries many.
    expect(parsed.entries[0]?.path).toBeNull();
    expect(parsed.entries.map((each) => exportedPath(parsed.header, each))).toEqual([
      '/a/2024/a.jpg',
    ]);

    await write([
      header({ platform: 'win32', roots: [{ path: 'C:\\' }, { path: 'D:\\Photos' }] }),
      entry({ rel: '2024/a.jpg', path: 42 }),
      entry({ root: 1, rel: '2024/a.jpg', path: 'x'.repeat(32_768) }),
      // The longest path a computer takes, kept.
      entry({ root: 1, rel: '2024/b.jpg', path: 'x'.repeat(32_767) }),
      trailer(3),
    ]);
    const windows = await read();
    expect(windows.entries.map((each) => exportedPath(windows.header, each))).toEqual([
      'C:\\2024\\a.jpg',
      'D:\\Photos\\2024\\a.jpg',
      'x'.repeat(32_767),
    ]);
  });

  it('counts the lines it cannot read, with problems that never quote the file', async () => {
    const secret = 'Secret Holiday';
    const tooLong = entry({ rel: `${secret}.jpg`, padding: 'x'.repeat(MAX_LINE_BYTES) });
    await exportOf(
      entry({ rel: `${secret}/../a.jpg` }),
      entry({ rel: `${secret}//a.jpg` }),
      entry({ rel: `${secret}/a\0.jpg` }),
      entry({ root: 1 }),
      entry({ root: 0.5 }),
      entry({ size: -1 }),
      entry({ mtimeMs: 'yesterday' }),
      entry({ tags: [' / ', '  '] }),
      entry({ tags: secret }),
      `{"rel": "${secret}"`,
      tooLong,
      entry({ rel: 'kept.jpg' }),
    );

    const parsed = await read();
    expect(parsed.entries.map((each) => each.segments)).toEqual([['kept.jpg']]);
    expect(parsed.invalid).toBe(11);
    expect(parsed.problems).toEqual([
      'Line 2: invalid path.',
      'Line 3: invalid path.',
      'Line 4: invalid path.',
      'Line 5: unknown library folder.',
      'Line 6: unknown library folder.',
    ]);

    await exportOf(
      entry({ size: -1 }),
      entry({ mtimeMs: 1.5 }),
      entry({ tags: [' / '] }),
      `{"rel": "${secret}"`,
      Buffer.from([0x7b, 0xff, 0x7d]),
      tooLong,
      entry({ rel: 'kept.jpg', mtimeMs: null }),
    );
    const others = await read();
    expect(others.problems).toEqual([
      'Line 2: invalid size or date.',
      'Line 3: invalid size or date.',
      'Line 4: no valid tag.',
      'Line 5: not a valid entry.',
      'Line 6: not a valid entry.',
    ]);
    expect(others.invalid).toBe(6);
    expect(others.entries).toEqual([expect.objectContaining({ mtimeMs: null })]);
  });

  it('reports a line too long to be read, and reads on', async () => {
    await exportOf(
      entry({ rel: 'long.jpg', padding: 'x'.repeat(MAX_LINE_BYTES) }),
      entry({ rel: 'kept.jpg' }),
    );

    const parsed = await read({ chunkSize: 4096 });
    expect(parsed.problems).toEqual(['Line 2: too long.']);
    expect(parsed.entries.map((each) => each.segments)).toEqual([['kept.jpg']]);
  });

  it('reads back the longest line of a file within the limits on its tags and paths', async () => {
    // Characters JSON writes as `\u00XX`, 6 bytes, the most a character takes; none is blank.
    const sixBytes = Array.from({ length: 31 }, (_, at) => String.fromCharCode(at + 1)).filter(
      (character) => JSON.stringify(character).length === 8 && character.trim() !== '',
    );
    const base = sixBytes.length;
    /** `length` of them, the first three telling `index` apart. */
    const escaped = (index: number, length: number): string =>
      [index % base, Math.floor(index / base) % base, Math.floor(index / base ** 2)]
        .map((digit) => sixBytes[digit])
        .join('')
        .padEnd(length, sixBytes[0]);
    const tags = Array.from({ length: 1_000 }, (_, index) => escaped(index, 1_024));
    // 98,301 units, the most `rel` takes, of segments of 765, the most one takes.
    const segments = [
      ...Array.from({ length: 128 }, (_, index) => escaped(index, 765)),
      escaped(128, 253),
    ];
    const rel = segments.join('/');
    expect(rel).toHaveLength(98_301);
    const row: TaggedFileRow = {
      id: 1,
      rootId: 1,
      path: escaped(1, 32_767),
      dir: segments.slice(0, -1).join('/'),
      name: segments.at(-1) as string,
      size: Number.MAX_SAFE_INTEGER,
      mtimeMs: Number.MIN_SAFE_INTEGER,
      fingerprint: PRINT,
      contentHash: HASH,
      missing: false,
    };
    const roots = Array.from({ length: 10_000 }, (_, index) => `/${index}`);
    const longest = entryLine(row, 9_999, tags);
    // As `MAX_LINE_BYTES` reckons it, without the `\n`, less 5 bytes for each `/` of `rel`.
    expect(Buffer.byteLength(longest) - 1).toBe(6_933_642 - 5 * 128);
    expect(Buffer.byteLength(longest) - 1).toBeLessThanOrEqual(MAX_LINE_BYTES);
    await writeFile(file, [headerLine({ ...HEADER, roots }), longest, endLine(1)].join(''));

    const parsed = await read();
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        root: 9_999,
        segments,
        path: row.path,
        size: row.size,
        mtimeMs: row.mtimeMs,
        tags,
      }),
    ]);
  });

  it('reads the path of any file a computer holds, in NFC, and leaves out longer ones', async () => {
    // A name of 255 units, the most Windows takes, that NFC makes 765 (U+FB2C is 3 in NFC).
    const name = '\uFB2C'.repeat(255).normalize('NFC');
    expect(name).toHaveLength(765);
    // In a path of 32,767 units, the most Windows takes: 98,301 in NFC.
    const longest = [...Array.from({ length: 128 }, () => name), 'x'.repeat(253)].join('/');
    expect(longest).toHaveLength(98_301);
    await exportOf(
      entry({ rel: longest }),
      entry({ rel: `${longest}x` }),
      entry({ rel: `a/${name}x` }),
      entry({ rel: `b/${name}` }),
    );

    const parsed = await read();
    expect(parsed.entries.map((each) => each.segments)).toEqual([longest.split('/'), ['b', name]]);
    expect(parsed.problems).toEqual(['Line 3: invalid path.', 'Line 4: invalid path.']);
  });

  it('lets the event loop run while it normalises the segments of one long path', async () => {
    const segments = Array.from({ length: 100 }, (_, index) => `E\u0301te\u0301 ${index}`);
    await exportOf(entry({ rel: segments.join('/') }));
    // Each look at the clock takes 1 ms, so a slice is spent every few segments.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    const slices = vi.spyOn(Slicer.prototype, 'yield');
    const normalize = vi.spyOn(String.prototype, 'normalize');

    const parsed = await read();
    const named = new Set(segments);
    const normalised = normalize.mock.invocationCallOrder.filter((_, at) =>
      named.has(String(normalize.mock.contexts[at])),
    );
    expect(normalised).toHaveLength(100);
    expect(parsed.entries[0]?.segments).toEqual(segments.map((each) => each.normalize('NFC')));
    const first = Math.min(...normalised);
    const last = Math.max(...normalised);
    // Several times between the first segment and the last.
    expect(
      slices.mock.invocationCallOrder.filter((order) => order > first && order < last).length,
    ).toBeGreaterThan(3);
  });

  it('does not parse a line of far more arrays, objects and keys than a file needs', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    /** A file line, with `padding` as written. */
    const padded = (rel: string, padding: string): string =>
      `{"root":0,"rel":"${rel}","size":10,"tags":["t"],"padding":${padding}}`;
    // Each of these holds 10,000 more than its 7: a line of 6 MiB of them would take JSON.parse
    // up to 200 ms.
    const nested = padded('nested.jpg', `${'['.repeat(10_000)}${']'.repeat(10_000)}`);
    const objects = padded(
      'objects.jpg',
      JSON.stringify(Array.from({ length: 10_000 }, () => ({}))),
    );
    const keys = padded(
      'keys.jpg',
      JSON.stringify(Object.fromEntries(Array.from({ length: 10_000 }, (_, at) => [`k${at}`, 0]))),
    );
    await exportOf(
      nested,
      objects,
      keys,
      // Within strings, they are text, escaped quotes and backslashes included.
      padded('text.jpg', JSON.stringify('[{"a":\\'.repeat(10_000))),
      // Other values cost little.
      padded('values.jpg', JSON.stringify(Array.from({ length: 30_000 }, (_, at) => at))),
      // 10,000 in all.
      padded('most.jpg', `${'['.repeat(9_993)}${']'.repeat(9_993)}`),
    );

    const parsed = await read();
    expect(parsed.problems).toEqual([
      'Line 2: not a valid entry.',
      'Line 3: not a valid entry.',
      'Line 4: not a valid entry.',
    ]);
    expect(parsed.entries.map((each) => each.segments)).toEqual([
      ['text.jpg'],
      ['values.jpg'],
      ['most.jpg'],
    ]);
    const texts = parse.mock.calls.map(([text]) => text);
    for (const line of [nested, objects, keys]) {
      expect(texts).not.toContain(line);
    }
  });

  it('normalises tags and keeps each once, in its first spelling', async () => {
    await exportOf(entry({ tags: [' Trips / 2024 ', 'trips/2024', 'Été', 'été'] }));

    const parsed = await read();
    // `NOCASE` folds ASCII letters only, so `Été` and `été` are two tags.
    expect(parsed.entries[0]?.tags).toEqual(['Trips/2024', 'Été', 'été']);
    expect(parsed.tagCount).toBe(4);
  });

  it('leaves out only the tags it cannot take, and says so', async () => {
    const deepest = `ok${'/level'.repeat(63)}`;
    const many = Array.from({ length: 1_001 }, (_, index) => `tag ${index}`);
    await exportOf(
      entry({
        tags: [
          'people/Ana',
          12,
          'x'.repeat(1_025),
          'trips/2024',
          `deep${'/level'.repeat(64)}`,
          // A tag of 1,024 characters and 512 levels, the shape that used to take a second.
          `Q${'/A'.repeat(511)}`,
          deepest,
        ],
      }),
      entry({ rel: 'many.jpg', tags: many }),
      // A blank tag holds nothing to leave out.
      entry({ rel: 'blank.jpg', tags: ['kept', ' / '] }),
      entry({ rel: 'none.jpg', tags: [12, 'x'.repeat(1_025)] }),
    );

    const parsed = await read();
    expect(parsed.entries.map((each) => each.tags)).toEqual([
      ['people/Ana', 'trips/2024', deepest],
      many.slice(0, 1_000),
      ['kept'],
    ]);
    expect(parsed.problems).toEqual([
      'Line 2: a tag was left out.',
      'Line 3: a tag was left out.',
      'Line 5: no valid tag.',
    ]);
    expect(parsed.invalid).toBe(3);
  });

  it('leaves out, without normalising it, a tag of more than 30 combining marks in a row', async () => {
    // Marks in the reverse of the order NFC puts them in, which it sorts in a time that grows as
    // the square of their number: 1,000 such tags held the worker for a second.
    const reversed = `a${'́'.repeat(512)}${'̖'.repeat(511)}`;
    // 30 of them, sorted in no time.
    const thirty = `b${'́'.repeat(15)}${'̖'.repeat(15)}`;
    const sorted = thirty.normalize('NFC');
    await exportOf(
      entry({
        tags: ['people/Ana', ...Array.from({ length: 998 }, () => reversed), thirty],
      }),
    );
    const normalize = vi.spyOn(String.prototype, 'normalize');

    const parsed = await read();
    expect(parsed.entries[0]?.tags).toEqual(['people/Ana', sorted]);
    expect(sorted).not.toBe(thirty);
    expect(parsed.problems).toEqual(['Line 2: a tag was left out.']);
    const longRun = /\p{M}{31}/u;
    expect(normalize.mock.contexts.filter((text) => longRun.test(String(text)))).toEqual([]);
  });

  it('lets the event loop run while it normalises the tags of one long line', async () => {
    const tags = Array.from({ length: 100 }, (_, index) => `tag ${index}`);
    await exportOf(entry({ tags }));
    // Each look at the clock takes 1 ms, so a slice is spent every few tags.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    const slices = vi.spyOn(Slicer.prototype, 'yield');
    const normalize = vi.spyOn(String.prototype, 'normalize');

    await read();
    const named = new Set(tags);
    const normalised = normalize.mock.invocationCallOrder.filter((_, at) =>
      named.has(String(normalize.mock.contexts[at])),
    );
    expect(normalised).toHaveLength(100);
    const first = Math.min(...normalised);
    const last = Math.max(...normalised);
    // Several times between the first tag of the line and its last.
    expect(
      slices.mock.invocationCallOrder.filter((order) => order > first && order < last).length,
    ).toBeGreaterThan(3);
  });

  it('exports the tags of a file it reads back, and those only, up to 1,000', async () => {
    // Each at a limit, then just past it.
    const limits = [
      'x'.repeat(1_024),
      'x'.repeat(1_025),
      `ok${'/level'.repeat(63)}`,
      `deep${'/level'.repeat(64)}`,
      // Combining marks in a row.
      `q${'̖'.repeat(30)}`,
      `q${'̖'.repeat(31)}`,
    ];
    const kept = limits.filter((_, index) => index % 2 === 0);
    const many = Array.from({ length: 1_000 }, (_, index) => `tag ${index}`);

    const held = exportedTags([...limits, ...many]);
    expect(held).toEqual([...kept, ...many.slice(0, 997)]);
    // As the import reads them: the same are left out.
    await exportOf(entry({ tags: limits }));
    expect((await read()).entries[0]?.tags).toEqual(kept);
    // And the line of those exported is read whole, with nothing to say.
    const row: TaggedFileRow = {
      id: 1,
      rootId: 1,
      path: '/a/a.jpg',
      dir: '',
      name: 'a.jpg',
      size: 1,
      mtimeMs: 1,
      fingerprint: null,
      contentHash: null,
      missing: false,
    };
    await writeFile(file, [headerLine(HEADER), entryLine(row, 0, held), endLine(1)].join(''));
    const parsed = await read();
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries[0]?.tags).toEqual(held);
  });

  it('counts each tag once with its ancestors, whatever their case and depth', async () => {
    await exportOf(
      entry({ tags: ['Trips/2024/Japan', 'trips/2025', 'TRIPS', 'a/x'] }),
      entry({ rel: 'b.jpg', tags: ['trips/2024/japan/Kyoto', 'b/x', 'Été/x'] }),
    );

    // trips, trips/2024, trips/2024/japan, trips/2025, a, a/x, trips/2024/japan/kyoto, b, b/x, Été
    // and Été/x.
    expect((await read()).tagCount).toBe(11);
  });

  it('refuses a tags export that lists too many tags', async () => {
    /** 1,000 tags of 64 levels, all new. */
    const deepTags = (line: number): string[] =>
      Array.from({ length: 1_000 }, (_, index) => `${line}-${index}${'/l'.repeat(63)}`);
    const lines = Math.ceil((MAX_DISTINCT_TAGS + 1) / 64_000);
    await exportOf(
      ...Array.from({ length: lines }, (_, line) =>
        entry({ rel: `${line}.jpg`, tags: deepTags(line) }),
      ),
    );

    await expect(read()).rejects.toThrow('This tags export lists too many tags to be imported.');
  });

  it('lets the event loop run while it counts the tags of one long line', async () => {
    await exportOf(entry({ tags: Array.from({ length: 100 }, (_, index) => `a/b/tag ${index}`) }));
    // Each look at the clock takes 1 ms, so a slice is spent every few tags.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    const slices = vi.spyOn(Slicer.prototype, 'yield');

    expect((await read()).tagCount).toBe(102);
    // More than once a line: within the line of tags.
    expect(slices.mock.calls.length).toBeGreaterThan(3);
  });

  it('merges the lines of one file', async () => {
    await write([
      header({ roots: [{ path: '/a' }, { path: '/b' }] }),
      entry({ rel: 'E\u0301te\u0301/a.jpg', tags: ['beach', 'Family'] }),
      entry({ rel: 'other.jpg' }),
      entry({ rel: '\u00c9t\u00e9/a.jpg', size: 99, tags: ['family', 'kids'] }),
      entry({ root: 1, rel: '\u00c9t\u00e9/a.jpg' }),
      trailer(4),
    ]);

    const parsed = await read();
    expect(
      parsed.entries.map(({ root, segments, size, tags }) => ({ root, segments, size, tags })),
    ).toEqual([
      {
        root: 0,
        segments: ['\u00c9t\u00e9', 'a.jpg'],
        size: 10,
        tags: ['beach', 'Family', 'kids'],
      },
      { root: 0, segments: ['other.jpg'], size: 10, tags: ['t'] },
      { root: 1, segments: ['\u00c9t\u00e9', 'a.jpg'], size: 10, tags: ['t'] },
    ]);
    expect(parsed.invalid).toBe(0);
  });

  it('merges the lines of one file up to 1,000 tags', async () => {
    const tags = (from: number, count: number): string[] =>
      Array.from({ length: count }, (_, index) => `tag ${from + index}`);
    await exportOf(
      entry({ tags: tags(0, 400) }),
      entry({ tags: tags(400, 400) }),
      // 200 more fit.
      entry({ tags: [...tags(0, 10), ...tags(800, 400)] }),
      // All known already.
      entry({ tags: tags(0, 1_000) }),
    );

    const parsed = await read();
    expect(parsed.entries.map((each) => each.tags)).toEqual([tags(0, 1_000)]);
    expect(parsed.problems).toEqual(['Line 4: a tag was left out.']);
    expect(parsed.tagCount).toBe(1_000);
  });

  it('drops malformed fingerprints and hashes', async () => {
    await exportOf(
      entry({ fingerprint: PRINT.toUpperCase(), sha256: `${HASH}0` }),
      entry({ rel: 'b.jpg', fingerprint: PRINT.slice(1), sha256: 42, missing: 'yes' }),
    );

    expect(
      (await read()).entries.map(({ fingerprint, sha256, missing }) => ({
        fingerprint,
        sha256,
        missing,
      })),
    ).toEqual([
      { fingerprint: null, sha256: null, missing: false },
      { fingerprint: null, sha256: null, missing: false },
    ]);
  });

  it('ignores fingerprints computed another way', async () => {
    await write([
      header({ fingerprint: 'sha1(head)' }),
      entry({ fingerprint: PRINT, sha256: HASH }),
      trailer(1),
    ]);
    expect((await read()).entries[0]).toMatchObject({ fingerprint: null, sha256: HASH });

    await write([header({ fingerprint: undefined }), entry({ fingerprint: PRINT }), trailer(1)]);
    expect((await read()).entries[0]?.fingerprint).toBeNull();
  });

  it('gives `__proto__` keys no effect', async () => {
    await exportOf(
      '{"__proto__":{"missing":true,"polluted":true},"root":0,"rel":"a.jpg","size":1,"tags":["t"]}',
    );

    const [parsed] = (await read()).entries;
    expect(parsed?.missing).toBe(false);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('reads chunk by chunk, never holding more than one line', async () => {
    const lines = Array.from({ length: 10_000 }, (_, index) =>
      entry({ rel: `2024/${index}.jpg`, tags: [`batch/${index % 10}`] }),
    );
    await exportOf(...lines);
    const longest = Math.max(...[header(), ...lines].map((text) => Buffer.byteLength(text)));
    const concat = vi.spyOn(Buffer, 'concat');
    const progress: number[] = [];

    const parsed = await read({ chunkSize: 100, onBytes: (bytes) => progress.push(bytes) });

    expect(parsed.entries).toHaveLength(10_000);
    expect(parsed.entries[9_999]?.segments).toEqual(['2024', '9999.jpg']);
    expect(parsed.tagCount).toBe(11);
    expect(progress.length).toBeGreaterThan(5_000);
    expect(progress.at(-1)).toBe((await stat(file)).size);
    expect(concat).toHaveBeenCalled();
    for (const result of concat.mock.results) {
      expect((result.value as Buffer).length).toBeLessThanOrEqual(longest);
    }
  });

  it('stops reading once aborted', async () => {
    await exportOf(...Array.from({ length: 100 }, (_, index) => entry({ rel: `${index}.jpg` })));
    const controller = new AbortController();
    let chunks = 0;

    await expect(
      readTagFile(file, {
        signal: controller.signal,
        chunkSize: 64,
        onBytes: () => {
          chunks++;
          controller.abort(new Error('Canceled.'));
        },
      }),
    ).rejects.toThrow('Canceled.');
    expect(chunks).toBe(1);
  });
});

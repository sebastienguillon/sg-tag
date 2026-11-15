import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatalogue, readCatalogue } from './catalogue-file';

const HEADER =
  'Sample ID,Source path,Suggested category,Subcategory,Topic detail,Confidence in category,' +
  'Original size bytes,Original mtime nanoseconds,Format and secondary tags,Needs further review,' +
  'Review status,Visible content,Review notes';

/** A row under `HEADER`. */
function row(fields: {
  readonly path: string;
  readonly category?: string;
  readonly subcategory?: string;
  readonly topic?: string;
  readonly confidence?: string;
  readonly size?: string;
  readonly mtime?: string;
  readonly formats?: string;
  readonly flagged?: string;
  readonly status?: string;
  readonly visible?: string;
  readonly notes?: string;
}): string {
  const quoted = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  return [
    '001',
    fields.path,
    fields.category ?? 'Animals',
    fields.subcategory ?? 'Wildlife pets and animal interactions',
    fields.topic ?? '',
    fields.confidence ?? 'high',
    fields.size ?? '',
    fields.mtime ?? '',
    fields.formats ?? '',
    fields.flagged ?? '',
    fields.status ?? '',
    fields.visible ?? '',
    fields.notes ?? '',
  ]
    .map(quoted)
    .join(',');
}

const parse = (lines: readonly string[], platform = 'linux') =>
  parseCatalogue(lines.join('\r\n'), { platform });

describe('parseCatalogue', () => {
  it('reads the columns used, as a catalogue writes them', async () => {
    const parsed = await parse([
      HEADER,
      row({
        path: '/media/cat.jpg',
        topic: 'A cat on a sofa',
        confidence: 'medium',
        size: '324163',
        mtime: '1788806773715072300',
        formats: 'phone video; selfie;;',
        flagged: 'True',
        status: 'Reviewed; context caveat',
        visible: 'A grey cat.',
        notes: 'Says "meow".',
      }),
    ]);

    expect(parsed).toEqual({
      rows: [
        {
          row: 2,
          path: '/media/cat.jpg',
          segments: ['media', 'cat.jpg'],
          size: 324_163,
          mtimeMs: 1_788_806_773_715,
          category: 'Animals',
          subcategory: 'Wildlife pets and animal interactions',
          formats: ['phone video', 'selfie'],
          confidence: 'medium',
          flagged: true,
          reviewStatus: 'Reviewed; context caveat',
          topic: 'A cat on a sofa',
          visibleContent: 'A grey cat.',
          reviewNotes: 'Says "meow".',
        },
      ],
      invalid: 0,
      problems: [],
      renamed: 0,
      leftOut: 0,
    });
  });

  it('reads a catalogue with only the required columns, the others as unknown', async () => {
    const parsed = await parse([
      'Subcategory,Source path,Suggested category',
      'Sketches animation and parody,/media/a.mp4,Humor skits and entertainment',
    ]);

    expect(parsed.rows).toEqual([
      expect.objectContaining({
        path: '/media/a.mp4',
        category: 'Humor skits and entertainment',
        subcategory: 'Sketches animation and parody',
        size: null,
        mtimeMs: null,
        formats: [],
        confidence: null,
        flagged: false,
        topic: null,
      }),
    ]);
  });

  it('refuses a file without one of the required columns, saying which', async () => {
    await expect(parse(['Source path,Suggested category', '/a.jpg,Animals'])).rejects.toThrow(
      'This file is not a classification catalogue: it has no “Subcategory” column.',
    );
    await expect(parse([])).rejects.toThrow('it has no “Source path” column.');
  });

  it('leaves out rows that cannot be read, naming the first few by row number', async () => {
    const parsed = await parse([
      HEADER,
      row({ path: '' }),
      row({ path: 'relative/a.jpg' }),
      row({ path: '/media/../etc/a.jpg' }),
      row({ path: '/media/b.jpg', category: '' }),
      row({ path: '/media/c.jpg', subcategory: ' ' }),
      row({ path: '/media/d.jpg' }),
      row({ path: '/media/d.jpg' }),
      row({ path: '/media/e.jpg', notes: 'x'.repeat(32_768) }),
    ]);

    expect(parsed.rows.map((each) => each.path)).toEqual(['/media/d.jpg']);
    expect(parsed.invalid).toBe(7);
    expect(parsed.problems).toEqual([
      'Row 2: no source path.',
      'Row 3: its source path cannot be read.',
      'Row 4: its source path cannot be read.',
      'Row 5: no category.',
      'Row 6: no subcategory.',
    ]);
  });

  it('refuses a catalogue without a row that can be read', async () => {
    await expect(parse([HEADER, row({ path: 'a.jpg' })])).rejects.toThrow(
      'This catalogue lists no file that can be read.',
    );
  });

  it('reads Windows paths, with a drive letter or on a network share', async () => {
    const parsed = await parse(
      [
        HEADER,
        row({ path: 'D:\\Drama\\!Unsorted\\a.mp4' }),
        row({ path: '\\\\nas\\media\\b.jpg' }),
        row({ path: '\\no-drive\\c.jpg' }),
        row({ path: 'D:relative.jpg' }),
      ],
      'win32',
    );

    expect(parsed.rows.map((each) => each.segments)).toEqual([
      ['D:', 'Drama', '!Unsorted', 'a.mp4'],
      ['nas', 'media', 'b.jpg'],
    ]);
    expect(parsed.invalid).toBe(2);
  });

  it('rewrites labels a tag name cannot be, and counts them', async () => {
    const parsed = await parse([
      HEADER,
      row({
        path: '/media/a.jpg',
        category: 'Arts, history',
        subcategory: '="Visual" arts',
        formats: 'caption, bold;\u0007',
      }),
      row({ path: '/media/b.jpg', category: 'Arts, history' }),
    ]);

    expect(
      parsed.rows.map(({ category, subcategory, formats }) => ({
        category,
        subcategory,
        formats,
      })),
    ).toEqual([
      { category: 'Arts history', subcategory: "'Visual' arts", formats: ['caption bold'] },
      {
        category: 'Arts history',
        subcategory: 'Wildlife pets and animal interactions',
        formats: [],
      },
    ]);
    expect(parsed.renamed).toBe(4);
    expect(parsed.leftOut).toBe(1);
  });

  it('keeps each format tag once, leaving out those that are the category or subcategory', async () => {
    const parsed = await parse([
      HEADER,
      row({ path: '/media/a.jpg', formats: 'Selfie;selfie;  SELFIE ;animals;crowd' }),
    ]);

    expect(parsed.rows[0]?.formats).toEqual(['Selfie', 'crowd']);
  });

  it('reads a size or a date that is not a whole number as unknown', async () => {
    const parsed = await parse([
      HEADER,
      row({ path: '/media/a.jpg', size: '12.5', mtime: '-3' }),
      row({ path: '/media/b.jpg', size: '1e6', mtime: '17888067737150723001234567' }),
    ]);

    expect(parsed.rows.map(({ size, mtimeMs }) => [size, mtimeMs])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
});

describe('readCatalogue', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-catalogue-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a file in UTF-8 with a byte order mark, and tells its size and date', async () => {
    const file = path.join(dir, 'media_catalog.csv');
    const text = `\uFEFF${HEADER}\r\n${row({ path: '/média/été.jpg' })}\r\n`;
    await writeFile(file, text);

    const catalogue = await readCatalogue(file, { platform: 'linux' });

    expect(catalogue.rows.map((each) => each.path)).toEqual(['/média/été.jpg']);
    expect(catalogue.path).toBe(file);
    expect(catalogue.size).toBe(Buffer.byteLength(text));
    expect(catalogue.mtimeMs).toBeGreaterThan(0);
  });

  it('refuses a file that is not UTF-8, a folder, and a file that is not there', async () => {
    const latin1 = path.join(dir, 'latin1.csv');
    await writeFile(latin1, Buffer.concat([Buffer.from(`${HEADER}\n/m/`), Buffer.from([0xe9])]));

    await expect(readCatalogue(latin1)).rejects.toThrow(
      'This file is not a classification catalogue: it is not text in UTF-8.',
    );
    await expect(readCatalogue(dir)).rejects.toThrow('Cannot read this file.');
    await expect(readCatalogue(path.join(dir, 'none.csv'))).rejects.toThrow(
      'Cannot read this file.',
    );
  });
});

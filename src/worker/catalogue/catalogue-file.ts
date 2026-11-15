import type { TagNameProblem } from '@shared/tag-names';
import { normalizeTagName, tagKey } from '@shared/tag-names';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { pathSegments } from '../library/paths';
import { Slicer } from '../tag-transfer/slices';
import { MAX_TAGS } from '../tag-transfer/tag-file';
import { rewrite } from '../tag-transfer/tagstudio-library';
import { eachCsvRecord } from './csv';

/** Largest catalogue read: the one it was made for is 7.6 MB, for 5,770 files. */
export const MAX_CATALOGUE_BYTES = 256 * 1024 * 1024;
/** Rows read, at most. */
export const MAX_CATALOGUE_ROWS = 1_000_000;
/** Longest field of a row read, in UTF-16 units: the longest path Windows allows. */
export const MAX_FIELD_UNITS = 32_767;
const MAX_PROBLEMS = 5;
/** Bytes read at a time, each chunk decoded before the next is read. */
const CHUNK_BYTES = 1024 * 1024;

/** The headers of the columns read, as the `media-classification` skill writes them. */
export const COLUMNS = {
  path: 'Source path',
  category: 'Suggested category',
  subcategory: 'Subcategory',
  size: 'Original size bytes',
  mtime: 'Original mtime nanoseconds',
  formats: 'Format and secondary tags',
  confidence: 'Confidence in category',
  flagged: 'Needs further review',
  reviewStatus: 'Review status',
  topic: 'Topic detail',
  visibleContent: 'Visible content',
  reviewNotes: 'Review notes',
} as const;

type Column = keyof typeof COLUMNS;

const REQUIRED: readonly Column[] = ['path', 'category', 'subcategory'];

/** Problems of a label that are rewritten rather than refused, as the TagStudio import does. */
const REWRITTEN: ReadonlySet<TagNameProblem> = new Set(['comma', 'quote', 'equals', 'control']);

const CANNOT_READ = 'Cannot read this file.';
const TOO_LARGE = 'This catalogue is too large to be read.';
const NOT_TEXT = 'This file is not a classification catalogue: it is not text in UTF-8.';
const TOO_MANY_ROWS = 'This catalogue has too many rows to be read.';
const NO_ROW = 'This catalogue lists no file that can be read.';

/** A refusal whose message is what the user is told. */
export class CatalogueError extends Error {
  override readonly name = 'CatalogueError';
}

/** A row of a classification catalogue, checked: one file and what the catalogue says of it. */
export interface CatalogueRow {
  /** Its number as a spreadsheet shows it, the header being row 1. */
  readonly row: number;
  /** As the catalogue writes it: an absolute path on this computer. */
  readonly path: string;
  /** The segments of `path`, NFC. */
  readonly segments: readonly string[];
  /** In bytes; `null` when the catalogue does not say. */
  readonly size: number | null;
  /** Modification time in milliseconds; `null` when the catalogue does not say. */
  readonly mtimeMs: number | null;
  /** Tag names (`normalizeTagName`). */
  readonly category: string;
  readonly subcategory: string;
  /** Tag names, each once (`tagKey`), the subcategory and the category left out. */
  readonly formats: readonly string[];
  readonly confidence: string | null;
  readonly flagged: boolean;
  readonly reviewStatus: string | null;
  readonly topic: string | null;
  readonly visibleContent: string | null;
  readonly reviewNotes: string | null;
}

/** A classification catalogue, read. */
export interface Catalogue {
  readonly path: string;
  /** Of the file when it was read, to tell whether it changed since. */
  readonly size: number;
  readonly mtimeMs: number;
  /** In the order of the file, each path once. */
  readonly rows: readonly CatalogueRow[];
  /** Rows left out because they could not be read. */
  readonly invalid: number;
  readonly problems: readonly string[];
  /** Labels rewritten to be tag names (a comma, a double quote…), each time one is read. */
  readonly renamed: number;
  /** Format labels left out because no tag name can be made of them. */
  readonly leftOut: number;
}

export interface CatalogueReadOptions {
  readonly signal?: AbortSignal;
  /** `process.platform` by default; tests pass another to read paths as it writes them. */
  readonly platform?: string;
}

/**
 * Reads the classification catalogue at `filePath`, a CSV file written by the `media-classification`
 * skill, keeping only the columns used (`COLUMNS`). Throws a `CatalogueError`, saying why, when it
 * cannot be used: too large, not UTF-8, without one of the required columns, or without a row
 * that can be read. A row that cannot be read is left out and counted.
 *
 * Reads and parses a slice at a time, so that the indexer keeps answering. The file is only read:
 * the paths it lists are never opened, and none of its text is run.
 */
export async function readCatalogue(
  filePath: string,
  options: CatalogueReadOptions = {},
): Promise<Catalogue> {
  const { text, size, mtimeMs } = await readText(filePath, options.signal);
  const parsed = await parseCatalogue(text, options);
  return { path: filePath, size, mtimeMs, ...parsed };
}

/** The text of the file at `filePath`, decoded as UTF-8 a chunk at a time. */
async function readText(
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; size: number; mtimeMs: number }> {
  const handle = await open(filePath, 'r').catch((error: unknown) => {
    throw new CatalogueError(CANNOT_READ, { cause: error });
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new CatalogueError(CANNOT_READ);
    }
    if (info.size > MAX_CATALOGUE_BYTES) {
      throw new CatalogueError(TOO_LARGE);
    }
    // `fatal`: a byte that is not UTF-8 refuses the file rather than turn into a replacement
    // character. A byte order mark at the start is dropped.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = new Uint8Array(CHUNK_BYTES);
    const parts: string[] = [];
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      // It may have grown since `stat`.
      if (total > MAX_CATALOGUE_BYTES) {
        throw new CatalogueError(TOO_LARGE);
      }
      parts.push(decodeChunk(decoder, buffer.subarray(0, bytesRead), true));
    }
    parts.push(decodeChunk(decoder, new Uint8Array(0), false));
    return { text: parts.join(''), size: total, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    throw error instanceof CatalogueError
      ? error
      : new CatalogueError(CANNOT_READ, { cause: error });
  } finally {
    await handle.close();
  }
}

function decodeChunk(decoder: TextDecoder, bytes: Uint8Array, stream: boolean): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch (error) {
    throw new CatalogueError(NOT_TEXT, { cause: error });
  }
}

/**
 * The rows of `text`, the content of a classification catalogue, as `readCatalogue` reads them.
 * Throws a `CatalogueError` as it does.
 */
export async function parseCatalogue(
  text: string,
  options: CatalogueReadOptions = {},
): Promise<Omit<Catalogue, 'path' | 'size' | 'mtimeMs'>> {
  const reader = new RowReader(options.platform ?? process.platform);
  await eachCsvRecord(
    // A byte order mark, when the text did not come through `readText`.
    text.startsWith(String.fromCodePoint(0xfeff)) ? text.slice(1) : text,
    (fields, record) => {
      reader.read(fields, record);
    },
    new Slicer(options.signal),
  );
  return reader.result();
}

class RowReader {
  private readonly platform: string;
  /** The index of each column read, once the header is read. */
  private columns: Readonly<Record<Column, number>> | null = null;
  private readonly rows: CatalogueRow[] = [];
  private readonly paths = new Set<string>();
  /** Each label as written, made a tag name once: thousands of rows share a few dozen. */
  private readonly labels = new Map<string, Label | null>();
  private invalid = 0;
  private readonly problems: string[] = [];
  private renamed = 0;
  private leftOut = 0;

  constructor(platform: string) {
    this.platform = platform;
  }

  read(fields: readonly string[], record: number): void {
    if (this.columns === null) {
      this.columns = columnsOf(fields);
      return;
    }
    if (this.rows.length + this.invalid >= MAX_CATALOGUE_ROWS) {
      throw new CatalogueError(TOO_MANY_ROWS);
    }
    if (fields.some((field) => field.length > MAX_FIELD_UNITS)) {
      this.problem(record, 'a field is too long');
      return;
    }
    const field = (column: Column): string => {
      const index = (this.columns as Record<Column, number>)[column];
      return index === -1 ? '' : (fields[index] ?? '').trim();
    };
    const written = field('path');
    const segments = written === '' ? null : this.segmentsOf(written);
    if (segments === null) {
      this.problem(record, written === '' ? 'no source path' : 'its source path cannot be read');
      return;
    }
    const category = this.label(field('category'));
    const subcategory = this.label(field('subcategory'));
    if (category === null || subcategory === null) {
      this.problem(record, category === null ? 'no category' : 'no subcategory');
      return;
    }
    const path = segments.join('/');
    if (this.paths.has(path)) {
      this.problem(record, 'a file listed twice');
      return;
    }
    this.paths.add(path);
    this.rows.push({
      row: record,
      path: written,
      segments,
      size: integerOf(field('size'), /^\d{1,15}$/),
      mtimeMs: millisecondsOf(field('mtime')),
      category,
      subcategory,
      formats: this.formatsOf(field('formats'), [category, subcategory]),
      confidence: optional(field('confidence')),
      flagged: field('flagged').toLowerCase() === 'true',
      reviewStatus: optional(field('reviewStatus')),
      topic: optional(field('topic')),
      visibleContent: optional(field('visibleContent')),
      reviewNotes: optional(field('reviewNotes')),
    });
  }

  result(): Omit<Catalogue, 'path' | 'size' | 'mtimeMs'> {
    if (this.columns === null || this.rows.length === 0) {
      throw new CatalogueError(
        this.columns === null ? missingColumn(REQUIRED[0] as Column) : NO_ROW,
      );
    }
    return {
      rows: this.rows,
      invalid: this.invalid,
      problems: this.problems,
      renamed: this.renamed,
      leftOut: this.leftOut,
    };
  }

  /**
   * The NFC segments of `written`, an absolute path on this computer: with a drive letter or a
   * network share on Windows, from `/` elsewhere. `null` for any other path, and for one that
   * holds `.`, `..` or a NUL character, which could lead elsewhere than it reads.
   */
  private segmentsOf(written: string): string[] | null {
    const absolute =
      this.platform === 'win32'
        ? /^[a-zA-Z]:[\\/]/.test(written) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(written)
        : written.startsWith('/');
    if (!absolute || written.includes('\0')) {
      return null;
    }
    const segments = pathSegments(written, this.platform).map((segment) =>
      segment.normalize('NFC'),
    );
    return segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')
      ? null
      : segments;
  }

  /** `input` as a tag name (`labelOf`), each rewrite counted; `null` when none can be made. */
  private label(input: string): string | null {
    if (input === '') {
      return null;
    }
    let label = this.labels.get(input);
    if (label === undefined) {
      label = labelOf(input);
      this.labels.set(input, label);
    }
    if (label?.rewritten === true) {
      this.renamed++;
    }
    return label?.name ?? null;
  }

  /** The format tags of `input`, separated by `;`, each once, none of `subject`. */
  private formatsOf(input: string, subject: readonly string[]): string[] {
    const seen = new Set(subject.map((name) => tagKey(name)));
    const formats: string[] = [];
    for (const part of input.split(';')) {
      const written = part.trim();
      if (written === '') {
        continue;
      }
      const name = this.label(written);
      if (name === null) {
        this.leftOut++;
        continue;
      }
      const key = tagKey(name);
      // A file has at most `MAX_TAGS` tags in a tags import: the subcategory is one.
      if (!seen.has(key) && formats.length < MAX_TAGS - 1) {
        seen.add(key);
        formats.push(name);
      }
    }
    return formats;
  }

  /** Never quotes the file. */
  private problem(record: number, reason: string): void {
    this.invalid++;
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push(`Row ${String(record)}: ${reason}.`);
    }
  }
}

/** A label of the catalogue as a tag name. */
interface Label {
  readonly name: string;
  /** It held what a name cannot, and was rewritten. */
  readonly rewritten: boolean;
}

/**
 * `input` as a tag name: rewritten when it holds what a name cannot (a comma, a double quote, a
 * leading `=`, a control character); `null` when no name can be made of it.
 */
function labelOf(input: string): Label | null {
  const check = normalizeTagName(input);
  if (check.ok) {
    return { name: check.name, rewritten: false };
  }
  if (!REWRITTEN.has(check.problem)) {
    return null;
  }
  const again = normalizeTagName(rewrite(input));
  return again.ok ? { name: again.name, rewritten: true } : null;
}

/** The index of each column in `header`, `-1` for one it lacks; throws if a required one lacks. */
function columnsOf(header: readonly string[]): Record<Column, number> {
  const trimmed = header.map((name) => name.trim());
  const columns = Object.fromEntries(
    Object.entries(COLUMNS).map(([column, name]) => [column, trimmed.indexOf(name)]),
  ) as Record<Column, number>;
  const missing = REQUIRED.find((column) => columns[column] === -1);
  if (missing !== undefined) {
    throw new CatalogueError(missingColumn(missing));
  }
  return columns;
}

function missingColumn(column: Column): string {
  return `This file is not a classification catalogue: it has no “${COLUMNS[column]}” column.`;
}

/** `text`, or `null` when it is empty. */
function optional(text: string): string | null {
  return text === '' ? null : text;
}

/** `text` as a whole number when it is one `pattern` accepts; `null` otherwise. */
function integerOf(text: string, pattern: RegExp): number | null {
  return pattern.test(text) ? Number(text) : null;
}

/** `text`, a time in nanoseconds, in milliseconds; `null` when it is not a whole number. */
function millisecondsOf(text: string): number | null {
  return /^\d{1,24}$/.test(text) ? Number(BigInt(text) / 1_000_000n) : null;
}

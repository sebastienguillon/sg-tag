import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import type { TaggedFileRow } from '../library/files-repository';
import { normalizeTagPath, tagKey } from '../library/tags-repository';
import { Slicer } from './slices';

export const TAG_FILE_FORMAT = 'sg-tag/tags';
/**
 * Bumped only for changes an older reader would misread (a field renamed, retyped or given another
 * meaning). New fields keep it: readers ignore fields they do not know.
 */
export const TAG_FILE_VERSION = 1;
/**
 * Largest tags export read, and so written (the exporter refuses a larger one). The file is read a
 * line at a time, but its files are held until it is imported: an entry takes 1.4 times the bytes
 * of its line (550 for a line of 400, a file with 4 tags as the exporter writes it), 1.8 times with
 * accented names, and up to 4 times for the shortest lines a file can have. At 256 MiB, measured
 * with Electron's V8:
 * - 670,000 files of 400 bytes are held in 351 MiB, 529 MiB once previewed, and the preview fits
 *   in a heap of 1.25 GiB;
 * - 5.7 million of the shortest lines are held in 809 MiB, and their preview fits in 2 GiB;
 * where V8 gives the process 4 GiB at most, and less on a computer with less memory. That is
 * 670,000 tagged files with long paths, and near a million with short ones.
 */
export const MAX_TAG_FILE_BYTES = 256 * 1024 * 1024;
/**
 * Longest path a computer takes, in UTF-16 units: Windows' long paths (macOS takes 1,024 bytes,
 * Linux 4,096). A library folder of a header and the `path` of a line are read up to it.
 */
const MAX_PATH_LENGTH = 32_767;
/**
 * Longest file or folder name, in UTF-16 units: macOS and Windows take 255, Linux file systems
 * 255 bytes.
 */
const MAX_NAME_LENGTH = 255;
/** NFC makes a text up to 3 times as long, in UTF-16 units (U+FB2C; UAX #15). */
const NFC_GROWTH = 3;
/** Longest `rel` read, 98,301 units: `rel` is the NFC of the end of a path. */
const MAX_REL_LENGTH = NFC_GROWTH * MAX_PATH_LENGTH;
/**
 * Longest segment of `rel` read, 765 units: the NFC of a name. Normalising one takes well under a
 * millisecond, whatever it holds.
 */
const MAX_SEGMENT_LENGTH = NFC_GROWTH * MAX_NAME_LENGTH;
/**
 * Longest file line read: a longer one is left out whole (`too long`). It holds the longest line a
 * file within the limits on its tags and paths can take, and the exporter writes no tag past them
 * (`exportedTags`), so that a tags export never loses a file whole for its tags on import (in a
 * file made otherwise, tags past the limits are left out one by one). As JSON, a UTF-16 unit
 * takes 6 bytes at most (`\u0001`), so:
 * - `tags`, 1,000 of 1,024 units, quoted and comma-separated: 1,000 × (1,024 × 6 + 3) + 1 =
 *   6,147,001 bytes;
 * - `rel`, 98,301 units (`MAX_REL_LENGTH`), and `path`, 32,767 (`MAX_PATH_LENGTH`), quoted:
 *   (98,301 + 32,767) × 6 + 4 = 786,412 bytes;
 * - the keys and the other values at their longest: 229 bytes;
 * 6,933,642 bytes in all, within 7 MiB. Parsing a line this long takes about 20 ms, however it is
 * made (`MAX_LINE_NODES`); its `rel` and its tags are normalised in slices (`segmentsOf`,
 * `tagsOf`).
 */
export const MAX_LINE_BYTES = 7 * 1024 * 1024;
/**
 * Longest first line read: a file whose first line goes on past it (a video) is refused without
 * reading on, and a library whose header would be longer is not exported (`readsHeader`). As long
 * as a file line, it lists 10,000 library folders (`MAX_ROOTS`) of 700 characters, or 37 at the
 * longest path (`MAX_PATH_LENGTH`) of characters JSON escapes, 196,614 bytes each. Reading one this
 * long holds the worker about 20 ms: it is parsed once (`MAX_HEADER_NODES`), and its library
 * folders are not normalised (`rootsOf`).
 */
export const MAX_HEADER_BYTES = MAX_LINE_BYTES;
/**
 * Arrays, objects and keys of a file line; an exported one has 2 arrays and objects, and 9 keys.
 * They make a line slow to parse far more than its length does (`MAX_LINE_BYTES` of nested arrays
 * take JSON.parse about 200 ms), so a line with more is left out unparsed.
 */
const MAX_LINE_NODES = 10_000;
/**
 * Arrays, objects and keys of a header: an exported one has 9, and 2 for each library folder, so
 * 20,009 at most (`MAX_ROOTS`); the rest leaves room for fields added within a version. A header
 * with more is refused unparsed, as a file line is left out (`MAX_LINE_NODES`).
 */
const MAX_HEADER_NODES = 50_000;

const CHUNK_BYTES = 64 * 1024;
const MAX_ROOTS = 10_000;
/** Tags of one file: those of a line past it, or merged from other lines past it, are left out. */
const MAX_TAGS = 1_000;
const MAX_TAG_LENGTH = 1_024;
/** Levels of one tag as written (`a/b/c` has 3): a deeper tag is left out. */
const MAX_TAG_DEPTH = 64;
/**
 * Combining marks in a row in one tag as written, at most, as UAX #15's Stream-Safe Text Format
 * allows: a tag with a longer run is left out. NFC sorts each run of them, in time that grows as
 * the square of its length, and every character it reorders is a mark (`\p{M}`). 1,000 tags of
 * 1,024 marks out of order took a second to normalise; within this bound they take about 50 ms.
 */
const MAX_MARK_RUN = 30;
/**
 * A run of more than `MAX_MARK_RUN` marks, matched from the first mark of a run only: tried from
 * each of them, it took longer than NFC itself.
 */
const LONG_MARK_RUN = new RegExp(`(?<!\\p{M})\\p{M}{${MAX_MARK_RUN + 1}}`, 'u');
/**
 * A run of more combining marks than a name holds (`MAX_NAME_LENGTH`), matched as `LONG_MARK_RUN`
 * is: no path a computer writes has one.
 */
const LONG_PATH_MARK_RUN = new RegExp(`(?<!\\p{M})\\p{M}{${MAX_NAME_LENGTH + 1}}`, 'u');
/**
 * Distinct tags of a tags export, ancestors included: far more than any library holds. Past it the
 * file is refused, so what it can make the worker hold and count stays bounded.
 */
export const MAX_DISTINCT_TAGS = 1_000_000;
const MAX_APP_LENGTH = 64;
const MAX_PROBLEMS = 5;
/** The values of `process.platform`: any other is not shown. */
const PLATFORMS: ReadonlySet<string> = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);
const FINGERPRINT = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Character codes of JSON text that `cheapToParse` looks for. */
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const OPEN_OBJECT = 0x7b;
const COLON = 0x3a;

const TOO_LARGE = 'This file is too large to be an SG Tag tags export.';
const CANNOT_READ = 'Cannot read this file.';
const NOT_AN_EXPORT = 'This is not an SG Tag tags export.';
const NEWER = 'This tags export was made by a newer version of SG Tag. Update SG Tag to import it.';
const INCOMPLETE =
  'This tags export is incomplete: it may have been cut short while being copied. Export the tags again.';
const NOTHING_TO_READ = 'This tags export lists no tagged file that can be read.';
const TOO_MANY_TAGS = 'This tags export lists too many tags to be imported.';

export interface TagFileHeader {
  readonly app: string | null;
  readonly exportedAt: string | null;
  /** `process.platform` of the exporting computer: `null` unless it is one Node knows. */
  readonly platform: string | null;
  /**
   * Library folders on the exporting computer, as stored there. Normalise them with `nfcOf`: one
   * may hold a run of combining marks far too long for NFC.
   */
  readonly roots: readonly string[];
}

/** A file of a tags export, checked and normalised. */
export interface ImportEntry {
  readonly root: number;
  /** `rel` split on `/`, NFC. */
  readonly segments: readonly string[];
  /**
   * Absolute path on the exporting computer, as its line gives it; `null` when it does not (see
   * `exportedPath`).
   */
  readonly path: string | null;
  readonly size: number;
  readonly mtimeMs: number | null;
  /** `null` when unknown, or computed another way (`FINGERPRINT_SCHEME` differs). */
  readonly fingerprint: string | null;
  readonly sha256: string | null;
  readonly missing: boolean;
  /**
   * Normalised (`normalizeTagPath`), without duplicates (`tagKey`): at most `MAX_TAGS`, each read
   * from a tag that `holdsTag`.
   */
  readonly tags: readonly string[];
}

export interface ParsedTagFile {
  readonly header: TagFileHeader;
  readonly entries: readonly ImportEntry[];
  readonly invalid: number;
  readonly problems: readonly string[];
  /** Distinct tags of `entries`, ancestors included (`tagKey`). */
  readonly tagCount: number;
}

/** The first line of a tags export. Each line writer returns its line, `\n` included. */
export function headerLine(header: TagFileHeader & { readonly fingerprint: string }): string {
  return line({
    format: TAG_FILE_FORMAT,
    version: TAG_FILE_VERSION,
    app: header.app,
    exportedAt: header.exportedAt,
    platform: header.platform,
    fingerprint: header.fingerprint,
    roots: header.roots.map((path) => ({ path })),
  });
}

/** The line of a tagged file, in library folder `rootIndex` of the header's `roots`. */
export function entryLine(row: TaggedFileRow, rootIndex: number, tags: readonly string[]): string {
  return line({
    root: rootIndex,
    rel: row.dir === '' ? row.name : `${row.dir}/${row.name}`,
    path: row.path,
    size: row.size,
    mtimeMs: row.mtimeMs,
    fingerprint: row.fingerprint,
    sha256: row.contentHash,
    missing: row.missing,
    tags,
  });
}

/** The last line: a tags export without it, or with another count, was cut short. */
export function endLine(files: number): string {
  return line({ end: true, files });
}

/**
 * Whether a tags export holds `tag`, as written: the importer leaves out a tag longer than
 * `MAX_TAG_LENGTH`, deeper than `MAX_TAG_DEPTH` or with more than `MAX_MARK_RUN` combining marks
 * in a row, and the exporter does not write one (`exportedTags`).
 */
export function holdsTag(tag: string): boolean {
  return tag.length <= MAX_TAG_LENGTH && levelsOf(tag) <= MAX_TAG_DEPTH && !LONG_MARK_RUN.test(tag);
}

/**
 * Whether an import reads `header`, the first line of a tags export (`headerLine`), rather than
 * refuse the file: it refuses one longer than `MAX_HEADER_BYTES`, or listing more than `MAX_ROOTS`
 * library folders or a library folder at a path longer than any computer takes. Only a library of
 * thousands of library folders, or of tens at the longest paths, has a header it refuses.
 */
export function readsHeader(header: string): boolean {
  const text = header.endsWith('\n') ? header.slice(0, -1) : header;
  if (Buffer.byteLength(text) > MAX_HEADER_BYTES) {
    return false;
  }
  try {
    headerOf(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * `value`, a path or part of one, in Unicode NFC; as written when it has a run of more combining
 * marks than a name holds (`MAX_NAME_LENGTH`). No path a computer writes has such a run; the NFC
 * of a path may have one (NFC makes two marks of U+0344), but is NFC already. NFC sorts each run in
 * a time that grows as the square of its length: a library folder of 32,767 such marks, which a
 * header can list, took 650 ms, where within this bound a path of 32,767 units takes 6 ms at most.
 * Compare the library folders of a tags export through it: one with such a run is compared as
 * written, and names no folder of any computer.
 */
export function nfcOf(value: string): string {
  return value.length > MAX_NAME_LENGTH && LONG_PATH_MARK_RUN.test(value)
    ? value
    : value.normalize('NFC');
}

/**
 * The tags of a file that its line holds, in order: the first `MAX_TAGS` that `holdsTag`. The
 * importer leaves none of them out, and their line fits `MAX_LINE_BYTES`.
 */
export function exportedTags(tags: readonly string[]): string[] {
  const held: string[] = [];
  for (const tag of tags) {
    if (held.length === MAX_TAGS) {
      break;
    }
    if (holdsTag(tag)) {
      held.push(tag);
    }
  }
  return held;
}

/**
 * Reads and checks a tags export line by line, never holding more than one line: the worker stays
 * responsive whatever the size. Throws, saying why in words fit to show, when it cannot be
 * imported; lines that cannot be read, and tags past the limits, are left out and counted instead.
 */
export async function readTagFile(
  filePath: string,
  options: {
    readonly signal: AbortSignal;
    readonly onBytes: (read: number, total: number) => void;
    /** Bytes read at a time; tests make it small. */
    readonly chunkSize?: number;
    /** Largest file read, `MAX_TAG_FILE_BYTES`; tests make it small. */
    readonly maxBytes?: number;
  },
): Promise<ParsedTagFile> {
  const { signal, onBytes, chunkSize = CHUNK_BYTES, maxBytes = MAX_TAG_FILE_BYTES } = options;
  let total: number;
  try {
    total = (await stat(filePath)).size;
  } catch (error) {
    throw new Error(CANNOT_READ, { cause: error });
  }
  signal.throwIfAborted();
  if (total > maxBytes) {
    throw new Error(TOO_LARGE);
  }
  const lines = new LineSplitter();
  const slicer = new Slicer(signal);
  const parser = new TagFileParser(slicer);
  let read = 0;
  for await (const chunk of chunksOf(filePath, chunkSize)) {
    signal.throwIfAborted();
    read += chunk.length;
    for (const bytes of lines.push(chunk)) {
      // Between two lines, as the parser does between two tags of a line.
      if (slicer.due) {
        await slicer.yield();
      }
      await parser.add(bytes);
    }
    // A first line that does not end soon (a video…) is refused without reading on.
    if (!parser.hasHeader && lines.overflowing) {
      throw new Error(NOT_AN_EXPORT);
    }
    onBytes(read, total);
  }
  const last = lines.end();
  if (last !== undefined) {
    await parser.add(last);
  }
  return parser.result();
}

function line(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

/** The content of `filePath`, chunk by chunk; any error while reading says it cannot be read. */
async function* chunksOf(filePath: string, chunkSize: number): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: chunkSize })) {
      yield chunk as Buffer;
    }
  } catch (error) {
    throw new Error(CANNOT_READ, { cause: error });
  }
}

/**
 * Cuts chunks into lines on `\n`, dropping a trailing `\r`. It holds the line being read only: one
 * longer than `MAX_HEADER_BYTES` for the first, `MAX_LINE_BYTES` for the others, is let go as it
 * comes, and handed out as `null`.
 */
class LineSplitter {
  private parts: Buffer[] = [];
  private length = 0;
  private tooLong = false;
  /** Lines handed out. */
  private lines = 0;

  /** The line being read is already too long. */
  get overflowing(): boolean {
    return this.tooLong;
  }

  /** Longest the line being read can be. */
  private get limit(): number {
    return this.lines === 0 ? MAX_HEADER_BYTES : MAX_LINE_BYTES;
  }

  /** The lines that `chunk` ends. */
  push(chunk: Buffer): (Buffer | null)[] {
    const lines: (Buffer | null)[] = [];
    let start = 0;
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      this.append(chunk.subarray(start, end));
      lines.push(this.take());
      start = end + 1;
    }
    this.append(chunk.subarray(start));
    return lines;
  }

  /** The last line, if the file does not end with `\n`. */
  end(): Buffer | null | undefined {
    return this.length > 0 || this.tooLong ? this.take() : undefined;
  }

  private append(piece: Buffer): void {
    if (this.tooLong) {
      return;
    }
    this.length += piece.length;
    // One byte of leeway for a `\r`, which is not part of the line.
    if (this.length > this.limit + 1) {
      this.parts = [];
      this.tooLong = true;
    } else if (piece.length > 0) {
      this.parts.push(piece);
    }
  }

  private take(): Buffer | null {
    const { limit } = this;
    let taken: Buffer | null = null;
    if (!this.tooLong) {
      taken = this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts);
      if (taken.at(-1) === 0x0d) {
        taken = taken.subarray(0, -1);
      }
    }
    this.parts = [];
    this.length = 0;
    this.tooLong = false;
    this.lines++;
    return taken !== null && taken.length <= limit ? taken : null;
  }
}

interface ReadHeader {
  readonly header: TagFileHeader;
  /** Fingerprints were computed as `fingerprint()` computes them. */
  readonly sameScheme: boolean;
}

type ReadEntry = Omit<ImportEntry, 'tags'> & { readonly tags: string[] };

/** A file line, checked. */
interface ReadLine {
  readonly entry: ReadEntry;
  /** `tagKey` of each of `entry.tags`, in order. */
  readonly keys: readonly string[];
  /** Some of its tags were left out. */
  readonly leftOut: boolean;
}

/** Checks the lines of a tags export one at a time, and keeps what it needs of them. */
class TagFileParser {
  private header: ReadHeader | null = null;
  private lineNumber = 0;
  /** Lines between the header and the trailer, blank ones excepted. */
  private fileLines = 0;
  private ended = false;
  private invalid = 0;
  private readonly problems: string[] = [];
  private readonly entries: ReadEntry[] = [];
  /** Entries by library folder and `rel`, to merge the lines of one file. */
  private readonly byPlace = new Map<string, ReadEntry>();
  /** `tagKey` of the tags of each entry that other lines merged into, made at the first merge. */
  private readonly mergedKeys = new Map<ReadEntry, Set<string>>();
  /**
   * Every tag of the entries and its ancestors, each once, as a tree: by its parent's number and
   * the `tagKey` of its last level, its own number. A tag takes one lookup per level to count,
   * rather than a copy of each of its ancestors.
   */
  private readonly tagTree = new Map<string, number>();
  /** Shared with the reading loop: reading the tags of a line can take more than a slice. */
  private readonly slicer: Slicer;

  constructor(slicer: Slicer) {
    this.slicer = slicer;
  }

  get hasHeader(): boolean {
    return this.header !== null;
  }

  /** Takes the next line: `null` when it was too long to be read. */
  async add(bytes: Buffer | null): Promise<void> {
    this.lineNumber++;
    const text = bytes && decode(bytes);
    if (this.header === null) {
      this.header = headerOf(text);
      return;
    }
    if (text?.trim() === '') {
      return;
    }
    if (this.ended) {
      throw new Error(INCOMPLETE);
    }
    const value = text === null || !cheapToParse(text, MAX_LINE_NODES) ? null : objectOf(text);
    if (value?.['end'] === true) {
      if (value['files'] !== this.fileLines) {
        throw new Error(INCOMPLETE);
      }
      this.ended = true;
      return;
    }
    this.fileLines++;
    if (bytes === null) {
      this.problem('too long');
      return;
    }
    const read = value ? await readLine(value, this.header, this.slicer) : 'not a valid entry';
    if (typeof read === 'string') {
      this.problem(read);
      return;
    }
    const { added, leftOut } = this.keep(read);
    if (leftOut) {
      this.problem('a tag was left out');
    }
    await this.count(added);
  }

  result(): ParsedTagFile {
    if (this.header === null) {
      throw new Error(NOT_AN_EXPORT);
    }
    if (!this.ended) {
      throw new Error(INCOMPLETE);
    }
    if (this.entries.length === 0) {
      throw new Error(NOTHING_TO_READ);
    }
    return {
      header: this.header.header,
      entries: this.entries,
      invalid: this.invalid,
      problems: this.problems,
      tagCount: this.tagTree.size,
    };
  }

  /** Never quotes the line: problems are shown as they are. */
  private problem(reason: string): void {
    this.invalid++;
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push(`Line ${this.lineNumber}: ${reason}.`);
    }
  }

  /**
   * Adds the entry of `line`, or its tags to an earlier line of the same file, up to `MAX_TAGS`.
   * Tells the `tagKey` of the tags added, and whether any of the line's tags was left out.
   */
  private keep({ entry, keys, leftOut }: ReadLine): {
    readonly added: readonly string[];
    readonly leftOut: boolean;
  } {
    const place = `${entry.root}/${entry.segments.join('/')}`;
    const earlier = this.byPlace.get(place);
    if (earlier === undefined) {
      this.byPlace.set(place, entry);
      this.entries.push(entry);
      return { added: keys, leftOut };
    }
    let known = this.mergedKeys.get(earlier);
    if (known === undefined) {
      known = new Set(earlier.tags.map(tagKey));
      this.mergedKeys.set(earlier, known);
    }
    const added: string[] = [];
    let full = false;
    entry.tags.forEach((tag, index) => {
      const key = keys[index] as string;
      if (known.has(key)) {
        return;
      }
      if (earlier.tags.length >= MAX_TAGS) {
        full = true;
        return;
      }
      known.add(key);
      earlier.tags.push(tag);
      added.push(key);
    });
    return { added, leftOut: leftOut || full };
  }

  /**
   * Counts the tags of `keys` and their ancestors, yielding between two tags once a slice is spent.
   * Throws once there are too many.
   */
  private async count(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      let parent = 0;
      for (const level of key.split('/')) {
        const node = `${parent}/${level}`;
        let id = this.tagTree.get(node);
        if (id === undefined) {
          if (this.tagTree.size >= MAX_DISTINCT_TAGS) {
            throw new Error(TOO_MANY_TAGS);
          }
          id = this.tagTree.size + 1;
          this.tagTree.set(node, id);
        }
        parent = id;
      }
      if (this.slicer.due) {
        await this.slicer.yield();
      }
    }
  }
}

/** Decoding a whole line keeps no state, so one decoder serves every line. It drops a BOM. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `bytes` as text, or `null` when they are not UTF-8. */
function decode(bytes: Buffer): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether the JSON `text` holds `maxNodes` arrays, objects and keys or fewer, counted without
 * parsing it: the brackets, braces and colons outside its strings.
 */
function cheapToParse(text: string, maxNodes: number): boolean {
  let nodes = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === QUOTE) {
      // On to the closing quote, past escaped characters.
      for (at++; at < text.length && text.charCodeAt(at) !== QUOTE; at++) {
        if (text.charCodeAt(at) === BACKSLASH) {
          at++;
        }
      }
    } else if (
      (code === OPEN_ARRAY || code === OPEN_OBJECT || code === COLON) &&
      ++nodes > maxNodes
    ) {
      return false;
    }
  }
  return true;
}

/** The JSON object `text` holds, or `null`. */
function objectOf(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Its message quotes the line, so it is never passed on.
    return null;
  }
  return isObject(value) ? value : null;
}

/** Checks the first line, `null` when it is not UTF-8, as `readHeader` does. */
function headerOf(text: string | null): ReadHeader {
  return readHeader(text === null || !cheapToParse(text, MAX_HEADER_NODES) ? null : objectOf(text));
}

/** Checks the first line, or throws: nothing else is read from a file that is not a tags export. */
function readHeader(value: Record<string, unknown> | null): ReadHeader {
  const version = value?.['version'];
  if (
    value?.['format'] !== TAG_FILE_FORMAT ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new Error(NOT_AN_EXPORT);
  }
  if (version > TAG_FILE_VERSION) {
    throw new Error(NEWER);
  }
  const roots = rootsOf(value['roots']);
  if (roots === null) {
    throw new Error(NOT_AN_EXPORT);
  }
  const { app, exportedAt, platform } = value;
  return {
    header: {
      app: isText(app, MAX_APP_LENGTH) ? app : null,
      exportedAt: dateOf(exportedAt),
      platform: typeof platform === 'string' && PLATFORMS.has(platform) ? platform : null,
      roots,
    },
    sameScheme: value['fingerprint'] === FINGERPRINT_SCHEME,
  };
}

/**
 * The paths of the library folders a header lists, as written, or `null` unless each is a path a
 * computer can take (`MAX_PATH_LENGTH`). They are not normalised here, whatever runs of combining
 * marks they hold: matching does it, through `nfcOf`.
 */
function rootsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROOTS) {
    return null;
  }
  const roots: string[] = [];
  for (const root of value as unknown[]) {
    const path = isObject(root) ? root['path'] : undefined;
    if (!isText(path, MAX_PATH_LENGTH)) {
      return null;
    }
    roots.push(path);
  }
  return roots;
}

function dateOf(value: unknown): string | null {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * The file a line lists, copied field by field, or why it cannot be read. Yields to the event loop
 * on `slicer` while it normalises `rel` and the tags.
 */
async function readLine(
  value: Record<string, unknown>,
  { header, sameScheme }: ReadHeader,
  slicer: Slicer,
): Promise<ReadLine | string> {
  const { root, size, mtimeMs } = value;
  if (
    typeof root !== 'number' ||
    !Number.isInteger(root) ||
    root < 0 ||
    root >= header.roots.length
  ) {
    return 'unknown library folder';
  }
  const segments = await segmentsOf(value['rel'], slicer);
  if (segments === null) {
    return 'invalid path';
  }
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !(mtimeMs === undefined || mtimeMs === null || Number.isSafeInteger(mtimeMs))
  ) {
    return 'invalid size or date';
  }
  const tags = await tagsOf(value['tags'], slicer);
  if (tags === null || tags.byKey.size === 0) {
    return 'no valid tag';
  }
  const { path, fingerprint, sha256 } = value;
  return {
    entry: {
      root,
      segments,
      path: isText(path, MAX_PATH_LENGTH) ? path : null,
      size,
      mtimeMs: (mtimeMs as number | null | undefined) ?? null,
      fingerprint: sameScheme ? matching(fingerprint, FINGERPRINT) : null,
      sha256: matching(sha256, SHA256),
      missing: value['missing'] === true,
      tags: [...tags.byKey.values()],
    },
    keys: [...tags.byKey.keys()],
    leftOut: tags.leftOut,
  };
}

/**
 * `rel` split on `/`, NFC, or `null` when it does not name a file within its library folder that a
 * computer can hold: longer than the NFC of the longest path, or with a segment longer than that of
 * the longest name. NFC neither makes nor joins a `/`, so each segment is normalised on its own, in
 * well under a millisecond (`MAX_SEGMENT_LENGTH`), the event loop running between two of them once
 * a slice is spent.
 */
async function segmentsOf(rel: unknown, slicer: Slicer): Promise<string[] | null> {
  if (!isText(rel, MAX_REL_LENGTH)) {
    return null;
  }
  const written = rel.split('/');
  if (written.some((segment) => segment.length > MAX_SEGMENT_LENGTH)) {
    return null;
  }
  const segments: string[] = [];
  for (const each of written) {
    const segment = each.normalize('NFC');
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\0')) {
      return null;
    }
    segments.push(segment);
    if (slicer.due) {
      await slicer.yield();
    }
  }
  return segments;
}

/** The tags of a line, each once. */
interface LineTags {
  /** Normalised, by `tagKey`, in their first spelling. */
  readonly byKey: ReadonlyMap<string, string>;
  /** Some were not text, were not held (`holdsTag`), or came past the first `MAX_TAGS`. */
  readonly leftOut: boolean;
}

/**
 * The tags of a line, or `null` when it holds no list of tags. Only the first `MAX_TAGS` are
 * looked at, only those that `holdsTag` are normalised, each in a time bound by its length, and
 * the event loop runs between two of them once a slice is spent: whatever a line holds, its tags
 * hold the worker a slice at a time. An offending tag is left out on its own.
 */
async function tagsOf(value: unknown, slicer: Slicer): Promise<LineTags | null> {
  if (!Array.isArray(value)) {
    return null;
  }
  const inputs = value as unknown[];
  const byKey = new Map<string, string>();
  let leftOut = inputs.length > MAX_TAGS;
  for (let index = 0; index < Math.min(inputs.length, MAX_TAGS); index++) {
    const input = inputs[index];
    if (typeof input !== 'string' || !holdsTag(input)) {
      leftOut = true;
    } else {
      // A blank tag (`' / '`) is dropped without a word: it holds nothing.
      const path = normalizeTagPath(input);
      if (path !== null && !byKey.has(tagKey(path))) {
        byKey.set(tagKey(path), path);
      }
    }
    if (slicer.due) {
      await slicer.yield();
    }
  }
  return { byKey, leftOut };
}

/** Levels of a tag as written, blank ones included: `a/b/c` has 3. */
function levelsOf(tag: string): number {
  let levels = 1;
  for (let at = tag.indexOf('/'); at !== -1; at = tag.indexOf('/', at + 1)) {
    levels++;
  }
  return levels;
}

/**
 * Where `entry` was on the exporting computer, for display: as its line gives it, or else from its
 * library folder, as that computer writes paths. Built on demand, for the few entries shown: a
 * library folder's path may be long, and entries many.
 */
export function exportedPath(header: TagFileHeader, entry: ImportEntry): string {
  if (entry.path !== null) {
    return entry.path;
  }
  const root = header.roots[entry.root] ?? '';
  const separator = header.platform === 'win32' ? '\\' : '/';
  return [root.endsWith(separator) ? root.slice(0, -1) : root, ...entry.segments].join(separator);
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

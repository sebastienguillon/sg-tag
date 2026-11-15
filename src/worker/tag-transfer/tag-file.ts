import { MAX_TAG_ALIASES, MAX_TAG_PARENTS, normalizeTagName, tagKey } from '@shared/tag-names';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import type { TaggedFileRow } from '../library/files-repository';
import type { TagDefinition } from '../library/tags-repository';
import { Slicer } from './slices';

export const TAG_FILE_FORMAT = 'sg-tag/tags';
/**
 * Bumped only for changes an older reader would misread (a field renamed, retyped or given another
 * meaning). New fields keep it: readers ignore fields they do not know.
 *
 * In version 2, each string of `tags` is the name of a tag, in which `/` is an ordinary character.
 * In version 1 it was a path, each `/` of which led one level down: read as names, its tags would
 * not be the tags that were exported, so a version 1 file is refused (`EARLIER`).
 *
 * Version 2 also has tag lines (`tagLine`), written before the file lines: each describes a tag
 * made or edited on purpose, with its aliases and parent tags. The kind of a line comes from its
 * keys: a tag line has `tag`, the last line `end`, and every other line is a file line.
 */
export const TAG_FILE_VERSION = 2;
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
export const MAX_REL_LENGTH = NFC_GROWTH * MAX_PATH_LENGTH;
/**
 * Longest segment of `rel` read, 765 units: the NFC of a name. Normalising one takes well under a
 * millisecond, whatever it holds.
 */
export const MAX_SEGMENT_LENGTH = NFC_GROWTH * MAX_NAME_LENGTH;
/**
 * Longest file line read: a longer one is left out whole (`too long`). It holds the longest line a
 * file within the limits on its tags and paths can take, and the exporter writes no more tags of a
 * file than a line holds (`exportedTags`), so that a tags export never loses a file whole for its
 * tags on import (in a file made otherwise, tags past the limits are left out one by one). As
 * JSON, a UTF-16 unit takes 6 bytes at most (`\u0001`, or any character that its writer escapes),
 * so:
 * - `tags`, 1,000 names (`MAX_TAGS`) of 1,024 units (`MAX_TAG_NAME_LENGTH`), quoted and
 *   comma-separated: 1,000 × (1,024 × 6 + 3) + 1 = 6,147,001 bytes;
 * - `rel`, 98,301 units (`MAX_REL_LENGTH`), and `path`, 32,767 (`MAX_PATH_LENGTH`), quoted:
 *   (98,301 + 32,767) × 6 + 4 = 786,412 bytes;
 * - the keys and the other values at their longest: 229 bytes;
 * 6,933,642 bytes in all, within 7 MiB. A name counts by its length alone, whatever characters it
 * holds. The exporter itself writes a name in 3 bytes a unit at most, since a name holds no
 * control character, and so no line longer than 3,861,642 bytes: the bound is that of a tags
 * export written by another program, which may escape every character. Parsing a line this long
 * takes about 20 ms, however it is made (`MAX_LINE_NODES`); its `rel` and its tags are normalised
 * in slices (`segmentsOf`, `tagsOf`).
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
export const MAX_TAGS = 1_000;
/**
 * Names of the tag lines, at most, counting each tag, alias and parent of each line: as many as
 * distinct tags may be (`MAX_DISTINCT_TAGS`), far more than any library describes. Past it the file
 * is refused, so that what its tag lines make the worker hold, and look up, stays bounded.
 */
export const MAX_DEFINED_NAMES = 1_000_000;
/**
 * A run of more combining marks than a file or folder name holds (`MAX_NAME_LENGTH`): no path a
 * computer writes has one. It is matched from the first mark of a run only: tried from each of
 * them, it took longer than the normalisation it guards.
 */
const LONG_PATH_MARK_RUN = new RegExp(`(?<!\\p{M})\\p{M}{${MAX_NAME_LENGTH + 1}}`, 'u');
/**
 * Distinct tags of a tags export, at most: far more than any library holds. Names that differ only
 * in letter case, or by characters nobody sees, are one tag (`tagKey`). Past
 * it the file is refused, so what a tags export can make the worker hold (an entry of a map for
 * each tag), look up in the library for each preview, and create when it is imported, stays
 * bounded.
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
const EARLIER =
  'This tags export was made by an earlier version of SG Tag: it can no longer be imported.';
const INCOMPLETE =
  'This tags export is incomplete: it may have been cut short while being copied. Export the tags again.';
const NOTHING_TO_READ = 'This tags export lists no tag that can be read.';
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
   * The names of its tags, as `normalizeTagName` leaves them, each tag once (`tagKey`): at most
   * `MAX_TAGS`.
   */
  readonly tags: readonly string[];
}

export interface ParsedTagFile {
  readonly header: TagFileHeader;
  readonly entries: readonly ImportEntry[];
  /**
   * The tags its tag lines describe, in order, their names as `normalizeTagName` leaves them: the
   * aliases of each at most `MAX_TAG_ALIASES`, its parents at most `MAX_TAG_PARENTS`.
   */
  readonly definitions: readonly TagDefinition[];
  /**
   * Distinct tags: those its tag lines describe, a name and its aliases being one tag, and those of
   * its files that none of them is.
   */
  readonly tagCount: number;
  readonly invalid: number;
  readonly problems: readonly string[];
  /**
   * The tags of `entries`, each once: by `tagKey`, its name as the tags export first spells it. At
   * most `MAX_DISTINCT_TAGS`.
   */
  readonly tags: ReadonlyMap<string, string>;
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

/**
 * The line of a tag made or edited on purpose: its name, and its aliases and the names of its parent
 * tags when it has any.
 */
export function tagLine(definition: TagDefinition): string {
  const { name, aliases, parents } = definition;
  return line({
    tag: name,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(parents.length > 0 ? { parents } : {}),
  });
}

/** The last line: a tags export without it, or with other counts, was cut short. */
export function endLine(files: number, tags: number): string {
  return line({ end: true, files, tags });
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
 * Of the names of the tags of a file, in order, those that its line holds: the first `MAX_TAGS`.
 * The importer leaves none of them out, and their line fits `MAX_LINE_BYTES`: the library holds
 * each name as `normalizeTagName` leaves it, which is how the importer reads one, and no two of its
 * tags share a `tagKey`.
 */
export function exportedTags(names: readonly string[]): readonly string[] {
  return names.slice(0, MAX_TAGS);
}

/**
 * Reads and checks a tags export line by line, never holding more than one line: the worker stays
 * responsive whatever the size. Throws, saying why in words fit to show, when it cannot be
 * imported; lines that cannot be read, tags that cannot be the name of a tag and tags past the
 * limits are left out and counted instead.
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
  /** File lines read, blank ones excepted. */
  private fileLines = 0;
  /** Tag lines read. */
  private tagLines = 0;
  /** Names of the tag lines kept, counting each tag, alias and parent of each. */
  private definedNames = 0;
  private readonly definitions: TagDefinition[] = [];
  private ended = false;
  private invalid = 0;
  private readonly problems: string[] = [];
  private readonly entries: ReadEntry[] = [];
  /** Entries by library folder and `rel`, to merge the lines of one file. */
  private readonly byPlace = new Map<string, ReadEntry>();
  /** `tagKey` of the tags of each entry that other lines merged into, made at the first merge. */
  private readonly mergedKeys = new Map<ReadEntry, Set<string>>();
  /** The tags of the entries, each once: by `tagKey`, its name as it is first spelled. */
  private readonly tags = new Map<string, string>();
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
      // A file written by hand may have no tag line, and leave their count out.
      if (value['files'] !== this.fileLines || (value['tags'] ?? 0) !== this.tagLines) {
        throw new Error(INCOMPLETE);
      }
      this.ended = true;
      return;
    }
    if (value !== null && 'tag' in value) {
      this.tagLines++;
      await this.define(value);
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
    if (this.keep(read)) {
      this.problem('a tag was left out');
    }
  }

  result(): ParsedTagFile {
    if (this.header === null) {
      throw new Error(NOT_AN_EXPORT);
    }
    if (!this.ended) {
      throw new Error(INCOMPLETE);
    }
    if (this.entries.length === 0 && this.definitions.length === 0) {
      throw new Error(NOTHING_TO_READ);
    }
    return {
      header: this.header.header,
      entries: this.entries,
      definitions: this.definitions,
      tagCount: this.tagCount(),
      invalid: this.invalid,
      problems: this.problems,
      tags: this.tags,
    };
  }

  /**
   * Keeps the tag that a tag line describes, or says why it cannot. Throws once the tag lines hold
   * too many names.
   */
  private async define(value: Record<string, unknown>): Promise<void> {
    const read = await definitionOf(value, this.slicer);
    if (typeof read === 'string') {
      this.problem(read);
      return;
    }
    const { definition, leftOut } = read;
    this.definedNames += 1 + definition.aliases.length + definition.parents.length;
    if (this.definedNames > MAX_DEFINED_NAMES) {
      throw new Error(TOO_MANY_TAGS);
    }
    this.definitions.push(definition);
    if (leftOut) {
      this.problem('an alias or a parent tag was left out');
    }
  }

  /**
   * Distinct tags (`ParsedTagFile.tagCount`): those of the tag lines, by the keys of their names,
   * and those of the file lines that no name or alias of a tag line is. A tag line whose name is a
   * name of an earlier one describes the same tag.
   */
  private tagCount(): number {
    const described = new Set<string>();
    let count = 0;
    for (const { name, aliases } of this.definitions) {
      const key = tagKey(name);
      if (!described.has(key)) {
        count++;
        described.add(key);
      }
      for (const alias of aliases) {
        described.add(tagKey(alias));
      }
    }
    for (const key of this.tags.keys()) {
      if (!described.has(key)) {
        count++;
      }
    }
    return count;
  }

  /** Never quotes the line: problems are shown as they are. */
  private problem(reason: string): void {
    this.invalid++;
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push(`Line ${this.lineNumber}: ${reason}.`);
    }
  }

  /**
   * Adds the entry of `line`, or its tags to an earlier line of the same file, up to `MAX_TAGS`,
   * and counts the tags added. Tells whether any of the line's tags was left out. Throws once the
   * tags export lists too many tags.
   */
  private keep({ entry, keys, leftOut }: ReadLine): boolean {
    const place = `${entry.root}/${entry.segments.join('/')}`;
    const earlier = this.byPlace.get(place);
    if (earlier === undefined) {
      this.byPlace.set(place, entry);
      this.entries.push(entry);
      entry.tags.forEach((tag, index) => {
        this.count(keys[index] as string, tag);
      });
      return leftOut;
    }
    let known = this.mergedKeys.get(earlier);
    if (known === undefined) {
      known = new Set(earlier.tags.map(tagKey));
      this.mergedKeys.set(earlier, known);
    }
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
      this.count(key, tag);
    });
    return leftOut || full;
  }

  /**
   * Counts the tag of `key`, named `name`, unless it was counted. Throws once there are too many.
   * A tag takes one lookup, so those of a line, `MAX_TAGS` at most, are counted in no time.
   */
  private count(key: string, name: string): void {
    if (this.tags.has(key)) {
      return;
    }
    if (this.tags.size >= MAX_DISTINCT_TAGS) {
      throw new Error(TOO_MANY_TAGS);
    }
    this.tags.set(key, name);
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
  // Before the rest is looked at: another version may write it another way.
  if (version > TAG_FILE_VERSION) {
    throw new Error(NEWER);
  }
  if (version < TAG_FILE_VERSION) {
    throw new Error(EARLIER);
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
  /** Their names, as `normalizeTagName` leaves them, by `tagKey`, in their first spelling. */
  readonly byKey: ReadonlyMap<string, string>;
  /** Some were not text, cannot be the name of a tag, or came past the first `MAX_TAGS`. */
  readonly leftOut: boolean;
}

/**
 * The tags of a line, or `null` when it holds no list of tags. Only the first `MAX_TAGS` are
 * looked at, and each is checked and normalised as any name is (`normalizeTagName`), in a time
 * bound by its length: one that is too long, or has a long run of combining marks, is refused
 * before it is normalised. The event loop runs between two of them once a slice is spent: whatever
 * a line holds, its tags hold the worker a slice at a time. A tag that cannot be a name is left out
 * on its own.
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
    const check = typeof input === 'string' ? normalizeTagName(input) : null;
    if (check === null) {
      leftOut = true;
    } else if (check.ok) {
      const key = tagKey(check.name);
      if (!byKey.has(key)) {
        byKey.set(key, check.name);
      }
    } else if (check.problem !== 'empty') {
      // A blank tag is dropped without a word: it holds nothing to leave out.
      leftOut = true;
    }
    if (slicer.due) {
      await slicer.yield();
    }
  }
  return { byKey, leftOut };
}

/**
 * The tag that a tag line describes, or why it cannot be read: its name must be one
 * (`normalizeTagName`). Of its aliases and parents, those that cannot be names, and those past the
 * first `MAX_TAG_ALIASES` aliases and `MAX_TAG_PARENTS` parents, are left out one by one
 * (`leftOut`); a blank one is dropped without a word, and so is one named twice, or an alias that
 * is the name itself.
 */
async function definitionOf(
  value: Record<string, unknown>,
  slicer: Slicer,
): Promise<{ readonly definition: TagDefinition; readonly leftOut: boolean } | string> {
  const tag = value['tag'];
  const check = typeof tag === 'string' ? normalizeTagName(tag) : null;
  if (check?.ok !== true) {
    return 'invalid tag';
  }
  const { name } = check;
  const aliases = await namesOf(value['aliases'], MAX_TAG_ALIASES, slicer, tagKey(name));
  const parents = await namesOf(value['parents'], MAX_TAG_PARENTS, slicer, null);
  return {
    definition: { name, aliases: aliases.names, parents: parents.names },
    leftOut: aliases.leftOut || parents.leftOut,
  };
}

/**
 * The names a tag line lists under one key, each once by `tagKey` and other than `exclude`: none
 * when the key is left out. Only the first `max` are looked at, each in a time bound by its length
 * (`normalizeTagName`), the event loop running between two of them once a slice is spent.
 */
async function namesOf(
  value: unknown,
  max: number,
  slicer: Slicer,
  exclude: string | null,
): Promise<{ readonly names: string[]; readonly leftOut: boolean }> {
  if (value === undefined || value === null) {
    return { names: [], leftOut: false };
  }
  if (!Array.isArray(value)) {
    return { names: [], leftOut: true };
  }
  const inputs = value as unknown[];
  const keys = new Set<string>(exclude === null ? [] : [exclude]);
  const names: string[] = [];
  let leftOut = inputs.length > max;
  for (let index = 0; index < Math.min(inputs.length, max); index++) {
    const input = inputs[index];
    const check = typeof input === 'string' ? normalizeTagName(input) : null;
    if (check === null) {
      leftOut = true;
    } else if (check.ok) {
      const key = tagKey(check.name);
      if (!keys.has(key)) {
        keys.add(key);
        names.push(check.name);
      }
    } else if (check.problem !== 'empty') {
      leftOut = true;
    }
    if (slicer.due) {
      await slicer.yield();
    }
  }
  return { names, leftOut };
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

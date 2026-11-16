import type { FilesRepository, ImportCandidate } from '../library/files-repository';
import { formatOf } from '../library/formats';
import { extensionOf, pathSegments } from '../library/paths';
import type { RootRecord } from '../library/roots-repository';
import type { Outcome } from '../tag-transfer/tag-matcher';
import { MTIME_TOLERANCE_MS } from '../tag-transfer/tag-matcher';

/** A file as a row of a classification catalogue places it. */
export interface CataloguePlace {
  /** Its absolute path, in segments. */
  readonly segments: readonly string[];
  /** `null` when the catalogue does not say. */
  readonly size: number | null;
  readonly mtimeMs: number | null;
}

export interface CatalogueLocatorOptions {
  readonly files: FilesRepository;
  /** The library folders. */
  readonly roots: readonly RootRecord[];
  /** Whether names that differ only in case name one file (macOS, Windows). */
  readonly caseInsensitive: boolean;
  /** `process.platform` by default; tests pass another to read paths as it writes them. */
  readonly platform?: string;
}

/** A library folder, its path in segments as `fold` leaves them. */
interface Root {
  readonly record: RootRecord;
  readonly segments: readonly string[];
}

/**
 * Finds the files that the rows of a classification catalogue name, from the index alone: no file
 * is read. A row is the file:
 *
 * 1. at its path, present or missing from disk, when its size and date agree, or when the row
 *    gives neither (`samePlace`): the date within `MTIME_TOLERANCE_MS`, as the indexer compares
 *    them;
 * 2. at its path, with another size or date (`changed`);
 * 3. else the one file on disk, in any library folder, with its name, size and date (`moved`), as
 *    after sorting the files into other folders; several are `ambiguous`;
 * 4. else not found: `notMedia` when SG Tag does not index files of its kind, `folder` when no
 *    library folder holds its path, `notFound` otherwise.
 *
 * Names are compared as this computer compares them.
 */
export class CatalogueLocator {
  private readonly options: CatalogueLocatorOptions;
  private readonly roots: readonly Root[];

  constructor(options: CatalogueLocatorOptions) {
    this.options = options;
    this.roots = options.roots.map((record) => ({
      record,
      segments: this.segmentsOf(record.path),
    }));
  }

  locate(place: CataloguePlace): Outcome {
    const name = place.segments.at(-1) ?? '';
    if (formatOf(extensionOf(name)) === undefined) {
      return { kind: 'notFound', reason: 'notMedia' };
    }
    const target = this.atPath(place);
    if (target !== null && target !== 'outside') {
      return agrees(target, place)
        ? { kind: 'samePlace', target, shared: false }
        : { kind: 'changed', target };
    }
    const found = this.byName(place);
    const [only] = found;
    if (found.length === 1 && only !== undefined) {
      return { kind: 'moved', target: only, shared: false };
    }
    if (found.length > 1) {
      return { kind: 'notFound', reason: 'ambiguous' };
    }
    return { kind: 'notFound', reason: target === 'outside' ? 'folder' : 'notFound' };
  }

  /**
   * The key of a path for comparing it with others on this computer: its segments as `fold` leaves
   * them.
   */
  keyOf(segments: readonly string[]): string {
    return segments.map((segment) => this.fold(segment)).join('/');
  }

  /** A name as this computer compares it: NFC, and lower-cased where case names one file. */
  fold(name: string): string {
    const nfc = name.normalize('NFC');
    return this.options.caseInsensitive ? nfc.toLowerCase() : nfc;
  }

  /** The segments of an absolute path written on this computer. */
  segmentsOf(value: string): string[] {
    return pathSegments(value, this.options.platform ?? process.platform).map((segment) =>
      this.fold(segment),
    );
  }

  /**
   * The file at the path of `place`: in the deepest library folder holding it, in its folder and
   * under its name. `null` when none is indexed there, `outside` when no library folder holds it.
   * Of several, which only a computer that tells case apart can have, the one with its very name,
   * then on disk, then the first indexed.
   */
  private atPath(place: CataloguePlace): ImportCandidate | 'outside' | null {
    const folded = place.segments.map((segment) => this.fold(segment));
    let holder: Root | null = null;
    for (const root of this.roots) {
      if (
        root.segments.length < folded.length &&
        startsWith(folded, root.segments) &&
        root.segments.length > (holder?.segments.length ?? -1)
      ) {
        holder = root;
      }
    }
    if (holder === null) {
      return 'outside';
    }
    const name = place.segments.at(-1) ?? '';
    const dir = folded.slice(holder.segments.length, -1).join('/');
    const found = this.options.files
      .named(name, holder.record.id)
      .filter(
        (candidate) =>
          this.fold(candidate.name) === folded.at(-1) && this.dirKey(candidate.dir) === dir,
      );
    const rank = (candidate: ImportCandidate): number =>
      (candidate.name.normalize('NFC') === name ? 0 : 2) + (candidate.missing ? 1 : 0);
    found.sort((a, b) => {
      const order = rank(a) - rank(b);
      return order === 0 ? a.id - b.id : order;
    });
    return found[0] ?? null;
  }

  /**
   * The files on disk, in every library folder, with the name, size and date of `place`, each
   * once; none when the catalogue does not give its size and date.
   */
  private byName(place: CataloguePlace): ImportCandidate[] {
    const { size, mtimeMs } = place;
    if (size === null || mtimeMs === null) {
      return [];
    }
    const name = place.segments.at(-1) ?? '';
    const folded = this.fold(name);
    const found = new Map<number, ImportCandidate>();
    for (const root of this.roots) {
      for (const candidate of this.options.files.named(name, root.record.id)) {
        if (
          !candidate.missing &&
          this.fold(candidate.name) === folded &&
          candidate.size === size &&
          Math.abs(candidate.mtimeMs - mtimeMs) <= MTIME_TOLERANCE_MS
        ) {
          found.set(candidate.id, candidate);
        }
      }
    }
    return [...found.values()];
  }

  /** `dir`, a folder relative to its library folder as the index stores it, as a key. */
  private dirKey(dir: string): string {
    return dir
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => this.fold(segment))
      .join('/');
  }
}

/** The file has the size and date of `place`, as far as the catalogue gives them. */
function agrees(file: ImportCandidate, place: CataloguePlace): boolean {
  return (
    (place.size === null || file.size === place.size) &&
    (place.mtimeMs === null || Math.abs(file.mtimeMs - place.mtimeMs) <= MTIME_TOLERANCE_MS)
  );
}

/** `path` starts with every segment of `prefix`. */
function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

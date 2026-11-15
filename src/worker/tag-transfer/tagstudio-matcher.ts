import { createLogger } from '@shared/log';
import type { TagImportFolder } from '@shared/model';
import type { FilesRepository, ImportCandidate } from '../library/files-repository';
import { formatOf } from '../library/formats';
import { extensionOf, pathSegments } from '../library/paths';
import type { RootRecord } from '../library/roots-repository';
import { eachInSlices, Slicer } from './slices';
import type { ImportEntry, ParsedTagFile } from './tag-file';
import type { MatchResult, Outcome } from './tag-matcher';

const log = createLogger('tag-transfer');

/** Library folders listed for the TagStudio library's folder, most files first. */
const MAX_FOUND_IN = 3;

export interface TagStudioMatchOptions {
  readonly files: FilesRepository;
  /** The library folders; files of a folder added meanwhile are left out. */
  readonly roots: readonly RootRecord[];
  /** Whether names that differ only in case name one file (macOS, Windows); injected for tests. */
  readonly caseInsensitive: boolean;
  readonly signal: AbortSignal;
  /** The slices the caller's work runs in; a new one on `signal` by default. */
  readonly slicer?: Slicer;
  readonly onProgress: (step: 'matching', done: number, total: number) => void;
  /** `process.platform` by default; tests pass another to read paths as it writes them. */
  readonly platform?: string;
}

/** A library folder, its path in segments as `fold` leaves them. */
interface Root {
  readonly record: RootRecord;
  readonly segments: readonly string[];
}

/**
 * The file each entry of `parsed`, a TagStudio library read by `readTagStudioLibrary`, is in this
 * library, from the index alone: TagStudio knows a file by its path only, with no size or content
 * to compare, so no file is read.
 *
 * An entry is the file at its path, below the library's folder (present, or missing from disk with
 * its tags kept): `samePlace`. Else, as TagStudio's "Fix Unlinked Entries" relinks a file, it is
 * the one file on disk with its name below the library's folder: `moved`, even when another entry
 * is at that file's path, or takes it by name too, as TagStudio then merges the two entries (the
 * file gets the tags of each). Several such files make it `ambiguous`. A file SG Tag does not
 * index (not an image or a video) is `notMedia`; one outside every library folder, and not found
 * by its name in one, `folder`. Names are compared as this computer compares them.
 */
export async function matchTagStudioEntries(
  parsed: ParsedTagFile,
  options: TagStudioMatchOptions,
): Promise<MatchResult> {
  const started = performance.now();
  const result = await new Matching(parsed, options).run();
  log.info(
    `Matched ${String(parsed.entries.length)} files of a TagStudio library in ` +
      `${String(Math.round(performance.now() - started))} ms`,
  );
  return result;
}

class Matching {
  private readonly parsed: ParsedTagFile;
  private readonly options: TagStudioMatchOptions;
  private readonly slicer: Slicer;
  private readonly platform: string;
  /** The library's folder, in folded segments. */
  private readonly folder: readonly string[];
  private readonly roots: readonly Root[];

  constructor(parsed: ParsedTagFile, options: TagStudioMatchOptions) {
    this.parsed = parsed;
    this.options = options;
    this.slicer = options.slicer ?? new Slicer(options.signal);
    this.platform = options.platform ?? process.platform;
    this.folder = this.segmentsOf(parsed.header.roots[0] ?? '');
    this.roots = options.roots.map((record) => ({
      record,
      segments: this.segmentsOf(record.path),
    }));
  }

  async run(): Promise<MatchResult> {
    const { entries } = this.parsed;
    const total = entries.length;
    const outcomes: (Outcome | null)[] = entries.map(() => null);
    /** Entries at the path of each file, by file id. */
    const atPath = new Map<number, number[]>();
    /** Entries outside every library folder: found by name only if moved into one. */
    const outside = new Set<number>();
    const report = (done: number): void => {
      this.options.onProgress('matching', done, total * 2);
    };

    // At their path.
    await eachInSlices(
      entries,
      (entry, index) => {
        const name = entry.segments.at(-1) ?? '';
        if (formatOf(extensionOf(name)) === undefined) {
          outcomes[index] = { kind: 'notFound', reason: 'notMedia' };
          return;
        }
        const target = this.atPath(entry);
        if (target === null) {
          return;
        }
        if (target === 'outside') {
          outside.add(index);
          return;
        }
        outcomes[index] = { kind: 'samePlace', target, shared: false };
        const others = atPath.get(target.id);
        if (others) {
          others.push(index);
        } else {
          atPath.set(target.id, [index]);
        }
      },
      { slicer: this.slicer, onSlice: report },
    );
    // Two entries at the path of one file (names this computer takes as one): it gets the tags of
    // each.
    for (const indexes of atPath.values()) {
      if (indexes.length > 1) {
        for (const index of indexes) {
          const outcome = outcomes[index] as Outcome & { kind: 'samePlace' };
          outcomes[index] = { ...outcome, shared: true };
        }
      }
    }

    // By name, for those not at their path. A file that another entry is at the path of, or that
    // another entry takes by name too, gets the tags of each, as TagStudio merges the two entries.
    await eachInSlices(
      entries,
      (entry, index) => {
        if (outcomes[index] !== null) {
          return;
        }
        const found = this.byName(entry);
        const [target] = found;
        if (found.length === 1 && target !== undefined) {
          outcomes[index] = { kind: 'moved', target, shared: false };
        } else if (found.length > 1) {
          outcomes[index] = { kind: 'notFound', reason: 'ambiguous' };
        } else {
          outcomes[index] = {
            kind: 'notFound',
            reason: outside.has(index) ? 'folder' : 'notFound',
          };
        }
      },
      { slicer: this.slicer, onSlice: (done) => report(total + done) },
    );

    const settled = outcomes as Outcome[];
    return {
      outcomes: settled,
      folders: [total === 0 ? null : this.folderSummary(settled)],
      samePathRoots: [this.roots.find((root) => same(root.segments, this.folder))?.record ?? null],
      reads: 0,
    };
  }

  /**
   * The file at the path of `entry`: in the deepest library folder holding it, in its folder and
   * under its name. `null` when none is indexed there, `outside` when no library folder holds it.
   * Of several, which only a computer that tells case apart can have, the one with its very name,
   * then on disk, then the first indexed.
   */
  private atPath(entry: ImportEntry): ImportCandidate | 'outside' | null {
    const place = [...this.folder, ...entry.segments.map((segment) => this.fold(segment))];
    let holder: Root | null = null;
    for (const root of this.roots) {
      if (
        root.segments.length < place.length &&
        startsWith(place, root.segments) &&
        root.segments.length > (holder?.segments.length ?? -1)
      ) {
        holder = root;
      }
    }
    if (holder === null) {
      return 'outside';
    }
    const name = entry.segments.at(-1) ?? '';
    const dir = place.slice(holder.segments.length, -1).join('/');
    const found = this.options.files.named(name, holder.record.id).filter(
      (candidate) =>
        this.fold(candidate.name) === place.at(-1) &&
        candidate.dir
          .split('/')
          .filter((segment) => segment !== '')
          .map((segment) => this.fold(segment))
          .join('/') === dir,
    );
    const rank = (candidate: ImportCandidate): number =>
      (candidate.name === name ? 0 : 2) + (candidate.missing ? 1 : 0);
    found.sort((a, b) => {
      const order = rank(a) - rank(b);
      return order === 0 ? a.id - b.id : order;
    });
    return found[0] ?? null;
  }

  /**
   * Files on disk named as `entry` below the library's folder, in every library folder that holds
   * part of it, each once.
   */
  private byName(entry: ImportEntry): ImportCandidate[] {
    const name = entry.segments.at(-1) ?? '';
    const folded = this.fold(name);
    const found = new Map<number, ImportCandidate>();
    for (const root of this.roots) {
      if (!startsWith(this.folder, root.segments) && !startsWith(root.segments, this.folder)) {
        continue;
      }
      for (const candidate of this.options.files.named(name, root.record.id)) {
        if (candidate.missing || this.fold(candidate.name) !== folded) {
          continue;
        }
        const place = [
          ...root.segments,
          ...candidate.dir
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => this.fold(segment)),
          folded,
        ];
        if (startsWith(place, this.folder)) {
          found.set(candidate.id, candidate);
        }
      }
    }
    return [...found.values()];
  }

  /** What is said of the library's folder: how many files were found, and in which folders. */
  private folderSummary(outcomes: readonly Outcome[]): Omit<TagImportFolder, 'addable'> {
    const counts = new Map<string, number>();
    let found = 0;
    for (const outcome of outcomes) {
      if (outcome.kind === 'samePlace' || outcome.kind === 'moved') {
        found++;
        const root = this.roots.find((each) => each.record.id === outcome.target.rootId);
        if (root) {
          counts.set(root.record.path, (counts.get(root.record.path) ?? 0) + 1);
        }
      }
    }
    return {
      exported: this.parsed.header.roots[0] ?? '',
      files: outcomes.length,
      found,
      foundIn: [...counts]
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_FOUND_IN)
        .map(([folder]) => folder),
      inLibrary: this.roots.some((root) => same(root.segments, this.folder)),
      suspicious: false,
    };
  }

  /** The segments of an absolute path, as `fold` leaves them. */
  private segmentsOf(value: string): string[] {
    return pathSegments(value, this.platform).map((segment) => this.fold(segment));
  }

  /** A name as this computer compares it: NFC, and lower-cased where case names one file. */
  private fold(name: string): string {
    const nfc = name.normalize('NFC');
    return this.options.caseInsensitive ? nfc.toLowerCase() : nfc;
  }
}

/** `path` starts with every segment of `prefix`. */
function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

import { mapLimit } from '@shared/async';
import { createLogger } from '@shared/log';
import type { TagImportFolder, TagImportMissReason } from '@shared/model';
import type {
  FilesRepository,
  FingerprintTarget,
  ImportCandidate,
} from '../library/files-repository';
import { commonTail, pathSegments, samePath } from '../library/paths';
import type { RootRecord } from '../library/roots-repository';
import { eachInSlices, Slicer } from './slices';
import type { ImportEntry, ParsedTagFile, TagFileHeader } from './tag-file';
import { exportedPath, nfcOf } from './tag-file';

const log = createLogger('tag-transfer');

/** How far apart modification times may be and still be one: FAT, exFAT and SMB round them. */
export const MTIME_TOLERANCE_MS = 2_000;
const READ_CONCURRENCY = 4;
/** Sizes looked up per query. */
const SIZE_BATCH = 500;
/** Files of those sizes loaded per query, however many share one: about a millisecond's work. */
const FILE_BATCH = 2_000;
/** Library folders listed per folder of a tags export, most files first. */
const MAX_FOUND_IN = 3;

export interface MatchOptions {
  readonly files: FilesRepository;
  /** The library folders; files of a folder added meanwhile are left out. */
  readonly roots: readonly RootRecord[];
  readonly isOnline: (rootId: number) => boolean;
  /** Whether names that differ only in case name one file (macOS, Windows); injected for tests. */
  readonly caseInsensitive: boolean;
  /** Reads an indexed file's fingerprint; tests inject a counting fake. */
  readonly read: (target: FingerprintTarget) => Promise<string>;
  readonly signal: AbortSignal;
  /**
   * The slices the caller's work runs in: matching goes on with the slice of the work before it,
   * and the work after with matching's. A new one on `signal` by default.
   */
  readonly slicer?: Slicer;
  readonly onProgress: (step: 'matching' | 'comparing', done: number, total: number) => void;
}

/** What an entry of a tags export was found as here. */
export type Outcome =
  /**
   * A file with its content, `samePlace` when in the folder and under the name the entry had in its
   * library folder, in its own, or at its very path: `shared` when another entry was found as that
   * file too.
   */
  | {
      readonly kind: 'samePlace' | 'moved';
      readonly target: ImportCandidate;
      readonly shared: boolean;
    }
  /** The file at its very place, in a library folder its files confirm, whatever its content. */
  | { readonly kind: 'changed'; readonly target: ImportCandidate }
  | { readonly kind: 'notFound'; readonly reason: TagImportMissReason };

export interface MatchResult {
  /** By entry index. */
  readonly outcomes: readonly Outcome[];
  /** By exported root index; `null` for roots that list no files. */
  readonly folders: readonly (Omit<TagImportFolder, 'addable'> | null)[];
  /** Same-path library folders here, by exported root index (for `addable`). */
  readonly samePathRoots: readonly (RootRecord | null)[];
  /** Files whose fingerprint was read. */
  readonly reads: number;
}

/**
 * The file each entry of `parsed` is in this library. A file tagged wrongly would go unnoticed,
 * while an entry not found is listed: files are taken on evidence of their content, and on their
 * place alone only as the reconciler itself would. Entries are taken in file order and ties go to
 * the lower id, so the outcome depends on nothing else.
 *
 * Content is compared on what is known of both sides, only between files of the same size, above
 * 0: the same SHA-256, or else the same fingerprint (of the same scheme), or else the same name and
 * modification times within `MTIME_TOLERANCE_MS`, as the indexer takes a file to be unchanged. A
 * hash or fingerprint that differs rules a file out, whatever its name.
 *
 * An entry's exact counterpart is a file whose path ends with the entry's whole relative path,
 * whatever the folders above, names compared as this computer does: in any library folder, the one
 * at the same path as the entry's included. It is at the entry's very path when the folders above
 * are those of the entry's library folder, the tags export coming from a computer like this one,
 * whichever library folder holds it: one may have been replaced by its parent since. A file found
 * is `samePlace` when it is in the folder and under the name the entry had in its library folder,
 * whichever library folder holds it, or at its very path, and `moved` otherwise.
 *
 * A file is known identical by its hash or fingerprint, or by its name and date in the folder and
 * under the name the entry had in its library folder, in its own, or at its very path, as the
 * indexer would take it: anywhere else, a name and date alone may be those of another photo. An
 * entry is settled when one of its exact counterparts on a connected drive is known identical.
 *
 * The library folder holding most of a folder of the tags export is the one holding most of its
 * entries' identical exact counterparts, of each entry the one its place alone tells: at its own
 * place, else at its very path, else anywhere in the library folder at the same path, else at its
 * place in its library folder, else with the most alike path. Entries already missing when
 * exported say nothing of it. It is found from what is known before fingerprints are read, then
 * again.
 *
 * Fingerprints are read, each file once, from present files of connected library folders that have
 * none, for entries with a fingerprint and no identical file at their own place or at their very
 * path: from files of their size not compared yet, only exact counterparts for an entry with one,
 * else all of them; and from files taken as identical by their name and date alone, away from their
 * place, all of them for an entry not settled. A settled entry reads only those of its exact
 * counterparts that may come before all those known identical: anywhere when each of these is one
 * of another entry too, which may take it first; else in the library folder holding most of its
 * folder, unless one there is known identical, its file moved within it coming before a copy
 * elsewhere. What a read tells holds for every entry from then on: one whose exact counterparts
 * were all found to differ, its own file perhaps renamed since, then reads as one that had none.
 * Paths of the tags export are never opened.
 *
 * Entries take, in passes:
 * 1. an identical file at their own place: in the library folder at the same path, in the same
 *    folder and under the same name;
 * 2. an identical exact counterpart;
 * 3. an identical file elsewhere, the most alike;
 * 4. the file at their own place, whatever its content (`changed`), in a same-path library folder
 *    its files confirm: more of them were found identical at their place than found to differ
 *    there. Where more differ, another drive or card may be mounted at that path: it is suspicious.
 *    An entry already missing from disk when exported has no file at its place: nothing ties the
 *    file there now to it. Nor has one whose place holds several files with names this computer
 *    takes as one, unless one of them has its very path or name.
 *
 * In passes 2 and 3, a settled entry takes only files known identical, and an entry takes no copy
 * another entry took while a file no entry took is at its own place: that file is checked in pass
 * 4. A file two entries take is shared: an identical copy gets the tags of both.
 *
 * Files no entry took yet come first, then files on disk before files missing from it: those are
 * never taken on their place alone. Then come, among exact counterparts, those on a connected
 * drive, at the entry's very path, in the library folder holding most of their folder, at the
 * entry's place in their library folder, with the most alike path, then known by their hash or
 * fingerprint rather than by name and date: where an exact counterpart is says more than how its
 * content was found the same. Among other files, those known by their hash or fingerprint come
 * first, then on a connected drive, in that library folder, with the most alike path.
 */
export async function matchEntries(
  parsed: ParsedTagFile,
  options: MatchOptions,
): Promise<MatchResult> {
  const started = performance.now();
  const result = await new Matching(parsed, options).run();
  log.info(
    `Matched ${parsed.entries.length} entries in ${Math.round(performance.now() - started)} ms: ` +
      `${result.reads} files read`,
  );
  return result;
}

/** `same` on a hash or fingerprint; `unchanged` on the name, size and modification time alone. */
type Verdict = 'same' | 'unchanged' | 'different' | 'unknown';

/** An indexed file entries are compared with; a fingerprint read meanwhile is patched in. */
interface Candidate extends ImportCandidate {
  fingerprint: string | null;
  /** Its absolute path, segment by segment, folded. */
  readonly folded: readonly string[];
  /** Its absolute path, segment by segment, as `eqPlace` compares names. */
  readonly place: readonly string[];
  /** Segments of its path in its library folder: 1 for a file at the top. */
  readonly depth: number;
}

/** A file with the content of an entry, as far as known, and how alike their places are. */
interface Likeness {
  readonly candidate: Candidate;
  /** Known to have the entry's content by its hash or fingerprint, not only its name and date. */
  readonly verified: boolean;
  /** Trailing path segments they share (folded). */
  readonly tail: number;
  /** In the folder and under the name the entry had in its library folder, in its own. */
  readonly anchored: boolean;
  /** Its path ends with the entry's whole relative path, whatever the folders above. */
  readonly exact: boolean;
  /** At the entry's own place: same-path library folder, same folder and name. */
  readonly atPlace: boolean;
  /**
   * At the entry's very path, the tags export coming from a computer like this one, whichever
   * library folder holds it: the one exported may have been replaced by its parent since.
   */
  readonly atPath: boolean;
}

/** Path segments, folded for ranking and name evidence, and as `eqPlace` compares names. */
interface Segments {
  readonly folded: readonly string[];
  readonly place: readonly string[];
}

/** The entries a read may tell more about, and the files to read for them, each once, by id. */
interface ReadPlan {
  readonly pending: Set<number>;
  readonly unread: Map<number, Candidate>;
  /**
   * Entries with an exact counterpart, which read no other file of their size not compared yet
   * (see `readTargets`): left out once reads find all their exact counterparts to differ, and
   * planned again (see `Matching.planAgain`).
   */
  readonly narrowed: Set<number>;
}

/** Counts for one folder of a tags export. */
interface Tally {
  files: number;
  found: number;
  /** Files found, by the library folder holding them. */
  readonly foundIn: Map<number, number>;
}

/** One run of `matchEntries`: what is known of each entry, and the files taken so far. */
class Matching {
  private readonly entries: readonly ImportEntry[];
  private readonly header: TagFileHeader;
  private readonly exported: readonly string[];
  private readonly platform: string;
  private readonly options: MatchOptions;
  /** One for all steps: each going through a few entries only, they add up to many slices. */
  private readonly slicer: Slicer;
  private readonly rootsById: ReadonlyMap<number, RootRecord>;
  /** Segments of each library folder's path here, by id. */
  private readonly rootPaths: ReadonlyMap<number, Segments>;
  /** By exported root: the library folder at the same path here. */
  private readonly sameRoot: (RootRecord | null)[] = [];
  /** By exported root: segments of its path on the exporting computer. */
  private readonly exportedPaths: Segments[] = [];
  /** By exported root: the library folder its exact counterparts are in, if one prevails. */
  private mapped: readonly (number | null)[] = [];
  /**
   * By entry: its relative path, segment by segment, folded. With its exported library folder's
   * (`exportedPaths`), never copied per entry, it makes its absolute path on the exporting computer.
   */
  private readonly folded: (readonly string[])[] = [];
  /** By entry: its relative path, segment by segment, as `eqPlace` compares names. */
  private readonly rels: (readonly string[])[] = [];
  /** Files of the entries' sizes, by size, then id. */
  private readonly bySize = new Map<number, Candidate[]>();
  private readonly byId = new Map<number, Candidate>();
  /** By entry: files with its content, as far as known. */
  private readonly same: (readonly Likeness[])[];
  /** By file id: how many entries it is an exact counterpart known identical of, before reads. */
  private readonly knownFor = new Map<number, number>();
  /** By entry: files of its size it could not be compared with, offline or unreadable. */
  private readonly uncompared: boolean[];
  /** Files whose fingerprint could not be read: not tried again. */
  private readonly failed = new Set<number>();
  /** By entry: the present file at its own place, if one is, looked up once. */
  private readonly placed = new Map<number, Candidate | null>();
  private readonly outcomes: (Outcome | undefined)[];
  /** Files an entry was found as. */
  private readonly claimed = new Set<number>();
  private reads = 0;

  constructor(parsed: ParsedTagFile, options: MatchOptions) {
    this.entries = parsed.entries;
    this.header = parsed.header;
    this.exported = parsed.header.roots;
    // An export that does not say is taken as from a computer like this one.
    this.platform = parsed.header.platform ?? process.platform;
    this.options = options;
    this.slicer = options.slicer ?? new Slicer(options.signal);
    this.rootsById = new Map(options.roots.map((root) => [root.id, root]));
    this.rootPaths = new Map(
      options.roots.map((root) => [
        root.id,
        this.segments(pathSegments(root.path, process.platform)),
      ]),
    );
    this.same = this.entries.map(() => []);
    this.uncompared = this.entries.map(() => false);
    this.outcomes = this.entries.map(() => undefined);
  }

  async run(): Promise<MatchResult> {
    const { signal, onProgress } = this.options;
    signal.throwIfAborted();
    onProgress('matching', 0, this.entries.length);
    await this.findSameRoots();
    await this.loadCandidates();
    const plan = await this.judgeAll();
    this.mapped = await this.impliedRoots();
    await this.planByName(plan);
    await this.readFingerprints(plan);
    this.mapped = await this.impliedRoots();
    const agree = await this.takeOwnPlaces();
    await this.takeExactCounterparts();
    await this.takeElsewhere();
    const suspicious = await this.checkPlaces(agree);
    const tallies = await this.tally();
    await this.eachLeft((entry, index) => {
      this.outcomes[index] = { kind: 'notFound', reason: this.missReason(entry, index, tallies) };
    });
    return {
      // Every entry has one by now.
      outcomes: this.outcomes as Outcome[],
      folders: tallies.map((tally, root) =>
        tally.files === 0
          ? null
          : {
              exported: this.exported[root] ?? '',
              files: tally.files,
              found: tally.found,
              foundIn: this.foundIn(tally),
              inLibrary: (this.sameRoot[root] ?? null) !== null,
              suspicious: suspicious[root] === true,
            },
      ),
      samePathRoots: this.sameRoot,
      reads: this.reads,
    };
  }

  /**
   * Finds the library folder here at the path of each exported one, and the segments of the
   * exported paths. Each path is normalised once, through `nfcOf`: a library folder of a tags export
   * with a run of more combining marks than a name holds would take long to normalise, so it is
   * compared as written, and names no folder here.
   */
  private async findSameRoots(): Promise<void> {
    const { roots, caseInsensitive, signal } = this.options;
    // As `samePath` compares them.
    const comparable = (nfc: string): string => (caseInsensitive ? nfc.toLowerCase() : nfc);
    const here = roots.map((root) => ({ root, path: comparable(nfcOf(root.path)) }));
    await eachInSlices(
      this.exported,
      (exported) => {
        const nfc = nfcOf(exported);
        const path = comparable(nfc);
        this.sameRoot.push(here.find((each) => each.path === path)?.root ?? null);
        this.exportedPaths.push(this.segments(pathSegments(nfc, this.platform)));
      },
      { signal, slicer: this.slicer },
    );
  }

  /**
   * Step 1: the files of the entries' sizes, present or missing, empty ones never. They come by
   * size, then id, a page at a time however many share a size, the event loop running between two
   * slices.
   */
  private async loadCandidates(): Promise<void> {
    const { files } = this.options;
    const { slicer } = this;
    const sizes = [...new Set(this.entries.map((entry) => entry.size))].filter((size) => size > 0);
    for (let start = 0; start < sizes.length; start += SIZE_BATCH) {
      const batch = sizes.slice(start, start + SIZE_BATCH);
      let page: ImportCandidate[] = [];
      do {
        if (slicer.due) {
          await slicer.yield();
        }
        page = files.withSizes(batch, FILE_BATCH, page.at(-1) ?? null);
        for (const file of page) {
          if (slicer.due) {
            await slicer.yield();
          }
          this.addCandidate(file);
        }
      } while (page.length === FILE_BATCH);
    }
  }

  /**
   * Adds `file` to those entries are compared with, unless its library folder is not one of
   * `roots`, or it came already: its size changed meanwhile.
   */
  private addCandidate(file: ImportCandidate): void {
    const candidate = this.byId.has(file.id) ? undefined : this.candidateOf(file);
    if (candidate) {
      const group = this.bySize.get(candidate.size);
      if (group) {
        group.push(candidate);
      } else {
        this.bySize.set(candidate.size, [candidate]);
      }
      this.byId.set(candidate.id, candidate);
    }
  }

  /**
   * Step 2: compares every entry with the files of its size. Returns the entries files of their size
   * not compared yet may tell more about, those to read, each once (see `readTargets`), and the
   * entries with an exact counterpart.
   */
  private async judgeAll(): Promise<ReadPlan> {
    const { signal, onProgress } = this.options;
    const plan: ReadPlan = { pending: new Set(), unread: new Map(), narrowed: new Set() };
    await eachInSlices(
      this.entries,
      (entry, index) => {
        const rel = this.segments(entry.segments);
        this.folded[index] = rel.folded;
        this.rels[index] = rel.place;
        const { same, unknown } = this.judge(index);
        this.same[index] = same;
        for (const likeness of same) {
          if (likeness.exact && knownIdentical(likeness)) {
            const { id } = likeness.candidate;
            this.knownFor.set(id, (this.knownFor.get(id) ?? 0) + 1);
          }
        }
        if (same.some(({ exact }) => exact)) {
          plan.narrowed.add(index);
        }
        this.addReads(
          plan,
          index,
          readTargets(entry, same, unknown, (candidate) => this.isExact(index, candidate)),
        );
      },
      {
        signal,
        slicer: this.slicer,
        onSlice: (done) => {
          onProgress('matching', done, this.entries.length);
        },
      },
    );
    return plan;
  }

  /**
   * Step 2 for files taken as identical by their name and date alone, away from the entry's place,
   * once step 5 tells where most of each folder is: adds those to read (see `byNameTargets`).
   */
  private planByName(plan: ReadPlan): Promise<void> {
    return eachInSlices(
      this.entries,
      (entry, index) => {
        this.addReads(plan, index, this.byNameTargets(entry, index));
      },
      { signal: this.options.signal, slicer: this.slicer },
    );
  }

  /**
   * The files taken as identical to the entry by their name and date alone, away from its place,
   * to read for it: one may be another photo. None for an entry with no fingerprint, or one
   * identical to the file at its own place; all of them for an entry not settled. A settled entry
   * takes none of them unread (see `takable`): it reads only those of its exact counterparts that
   * may come before all those known identical. Anywhere when each of these is one of another entry
   * too, which may take it first; else in the library folder holding most of its folder, unless one
   * there is known identical: its file moved within it comes before a copy elsewhere.
   */
  private byNameTargets(entry: ImportEntry, index: number): Candidate[] {
    const same = this.same[index] ?? [];
    if (!wantsReads(entry, same)) {
      return [];
    }
    const unsure = same.filter((likeness) => !knownIdentical(likeness));
    if (!this.settled(same)) {
      return unsure.map(({ candidate }) => candidate);
    }
    const known = same.filter((likeness) => likeness.exact && knownIdentical(likeness));
    let ahead = unsure.filter((likeness) => likeness.exact);
    if (known.some(({ candidate }) => (this.knownFor.get(candidate.id) ?? 0) < 2)) {
      const mapped = this.mapped[entry.root] ?? null;
      ahead = known.some(({ candidate }) => candidate.rootId === mapped)
        ? []
        : ahead.filter(({ candidate }) => candidate.rootId === mapped);
    }
    return ahead.map(({ candidate }) => candidate);
  }

  /**
   * Adds the entry to `plan` when `targets` are files a read may tell it more about, with those
   * that can be read and were not tried yet.
   */
  private addReads(plan: ReadPlan, index: number, targets: readonly Candidate[]): void {
    if (targets.length === 0) {
      return;
    }
    plan.pending.add(index);
    for (const candidate of targets) {
      if (
        !candidate.missing &&
        candidate.fingerprint === null &&
        !this.failed.has(candidate.id) &&
        this.options.isOnline(candidate.rootId)
      ) {
        plan.unread.set(candidate.id, candidate);
      }
    }
  }

  /**
   * Steps 3 and 4: reads the fingerprints of the files `plan` holds, then compares its pending
   * entries again. Files read for one entry may be among those found the same for another, by name
   * and date: those are compared again, so that no entry takes a file a read found to differ. An
   * entry whose exact counterparts were all found to differ is planned again, as one that had none
   * (see `planAgain`), and the files it reads then are read in a round of their own. Those left with
   * no exact counterpart and files of their size that could not be read, or are offline, could not
   * be compared.
   */
  private async readFingerprints(plan: ReadPlan): Promise<void> {
    const { signal } = this.options;
    const { pending, unread, narrowed } = plan;
    do {
      const reading = [...unread.values()];
      unread.clear();
      const read = reading.length > 0;
      if (read) {
        await this.readAll(reading);
      }
      await eachInSlices(
        read ? this.entries : [],
        (_, index) => {
          if (!pending.has(index)) {
            this.same[index] = this.recheck(index);
          }
        },
        { signal, slicer: this.slicer },
      );
      await eachInSlices(
        [...pending],
        (index) => {
          const { same, unknown } = this.judge(index);
          this.same[index] = same;
          this.uncompared[index] = this.couldNotCompare(same, unknown);
        },
        { signal, slicer: this.slicer },
      );
      await eachInSlices(
        read ? [...narrowed] : [],
        (index) => {
          if (!(this.same[index] ?? []).some(({ exact }) => exact)) {
            narrowed.delete(index);
            this.planAgain(plan, index);
          }
        },
        { signal, slicer: this.slicer },
      );
    } while (unread.size > 0);
  }

  /**
   * Adds to `plan` the files to read for an entry whose exact counterparts were all found to differ,
   * as for one that had none (see `readTargets`, `byNameTargets`): its own file may have been
   * renamed since. It is compared again first, with what was read for other entries too.
   */
  private planAgain(plan: ReadPlan, index: number): void {
    const entry = this.entries[index];
    if (!entry || !wantsReads(entry, this.same[index] ?? [])) {
      return;
    }
    const { same, unknown } = this.judge(index);
    this.same[index] = same;
    this.uncompared[index] = this.couldNotCompare(same, unknown);
    this.addReads(
      plan,
      index,
      readTargets(entry, same, unknown, (candidate) => this.isExact(index, candidate)),
    );
    this.addReads(plan, index, this.byNameTargets(entry, index));
  }

  /**
   * Whether an entry with no exact counterpart among `same` has files of its size, among `unknown`,
   * that could not be read or are offline.
   */
  private couldNotCompare(same: readonly Likeness[], unknown: readonly Candidate[]): boolean {
    return (
      !same.some(({ exact }) => exact) &&
      unknown.some(
        (candidate) =>
          !candidate.missing &&
          (this.failed.has(candidate.id) || !this.options.isOnline(candidate.rootId)),
      )
    );
  }

  /**
   * Reads the fingerprints of `targets`, in id order, storing them as the background fingerprinter
   * would. Progress counts the files of rounds before too.
   */
  private async readAll(targets: readonly Candidate[]): Promise<void> {
    const { files, read, signal, onProgress } = this.options;
    const unread = [...targets].sort((a, b) => a.id - b.id);
    const total = this.reads + unread.length;
    onProgress('comparing', this.reads, total);
    await mapLimit(unread, READ_CONCURRENCY, async (candidate) => {
      signal.throwIfAborted();
      const print = await read(candidate).catch(() => null);
      signal.throwIfAborted();
      this.reads++;
      if (print === null) {
        this.failed.add(candidate.id);
      } else {
        files.setFingerprint(candidate, print);
        candidate.fingerprint = print;
      }
      onProgress('comparing', this.reads, total);
    });
  }

  /**
   * Step 5, by exported root: the library folder holding the most of its entries' identical exact
   * counterparts, of each entry the one its place alone tells (see `mostAlike`); `null` on a tie.
   * Entries already missing when exported say nothing of where their folder is now. It only ranks
   * candidates, a file moved since within the library folder at the export's path before an old
   * copy at its place in another, and tells which files taken as identical by their name and date
   * alone to read: found before reads, then again on what they told.
   */
  private async impliedRoots(): Promise<(number | null)[]> {
    const counts = this.exported.map(() => new Map<number, number>());
    await eachInSlices(
      this.entries,
      (entry, index) => {
        const vote = mostAlike(
          (this.same[index] ?? []).filter((likeness) => likeness.exact),
          this.sameRoot[entry.root]?.id,
        );
        const byRoot = counts[entry.root];
        if (!entry.missing && vote && byRoot) {
          const { rootId } = vote.candidate;
          byRoot.set(rootId, (byRoot.get(rootId) ?? 0) + 1);
        }
      },
      { signal: this.options.signal, slicer: this.slicer },
    );
    return counts.map((byRoot) => {
      let mapped: number | null = null;
      let most = 0;
      for (const [rootId, count] of byRoot) {
        if (count > most) {
          mapped = rootId;
          most = count;
        } else if (count === most) {
          mapped = null;
        }
      }
      return mapped;
    });
  }

  /**
   * Pass A1: entries take an identical file at their own place, without regard to claims: a place
   * belongs to one entry, duplicate lines being merged. Returns, by exported root, how many did.
   */
  private async takeOwnPlaces(): Promise<number[]> {
    const agree = this.exported.map(() => 0);
    await this.eachLeft((entry, index) => {
      const own = first(
        (this.same[index] ?? []).filter((likeness) => likeness.atPlace),
        this.counterpartOrder(entry),
      );
      if (own) {
        this.take(index, own);
        agree[entry.root] = (agree[entry.root] ?? 0) + 1;
      }
    });
    return agree;
  }

  /** Pass A2: before files elsewhere, so that no entry takes the exact counterpart of another. */
  private takeExactCounterparts(): Promise<void> {
    return this.eachLeft((entry, index) => {
      const exact = first(
        this.takable(index).filter((likeness) => likeness.exact),
        this.counterpartOrder(entry),
      );
      if (exact && !this.leavesOwnPlace(index, exact)) {
        this.take(index, exact);
      }
    });
  }

  /** Pass B: an identical file elsewhere, renamed or moved since. */
  private takeElsewhere(): Promise<void> {
    return this.eachLeft((entry, index) => {
      const found = first(this.takable(index), this.elsewhereOrder(entry));
      if (found && !this.leavesOwnPlace(index, found)) {
        this.take(index, found);
      }
    });
  }

  /**
   * The files of the entry's `same` passes A2 and B may take: for a settled entry (see `settled`),
   * only those known identical. A name and date alone, away from its place, were not read for it
   * and may be those of another photo.
   */
  private takable(index: number): readonly Likeness[] {
    const same = this.same[index] ?? [];
    return this.settled(same) ? same.filter(knownIdentical) : same;
  }

  /**
   * Whether an exact counterpart of the entry among `same`, on a connected drive, is known
   * identical (see `knownIdentical`).
   */
  private settled(same: readonly Likeness[]): boolean {
    return same.some(
      (likeness) =>
        likeness.exact && knownIdentical(likeness) && this.availability(likeness.candidate) === 0,
    );
  }

  /**
   * A copy another entry took is not where this one went while a file no entry took is at its own
   * place: that file is checked in step 9.
   */
  private leavesOwnPlace(index: number, { candidate }: Likeness): boolean {
    return this.claimed.has(candidate.id) && this.ownPlace(index) !== undefined;
  }

  /**
   * Step 9: an entry still not found may be the file at its own place, changed since, in a same-path
   * library folder its files confirm. Entries with no such file (see `fileAtPlace`) count neither
   * way. Returns, by exported root, whether the folder is suspicious.
   */
  private async checkPlaces(agree: readonly number[]): Promise<boolean[]> {
    const disagree = this.exported.map(() => 0);
    const atPlace = new Map<number, Candidate>();
    await this.eachLeft((entry, index) => {
      const file = this.ownPlace(index);
      if (file) {
        atPlace.set(index, file);
        if (
          file.size !== entry.size ||
          (entry.size > 0 && this.compareWith(index, file) === 'different')
        ) {
          disagree[entry.root] = (disagree[entry.root] ?? 0) + 1;
        }
      }
    });
    const confirmed = agree.map((count, root) => count >= 1 && count > (disagree[root] ?? 0));
    for (const [index, file] of atPlace) {
      const entry = this.entries[index];
      if (entry && confirmed[entry.root] === true && !this.claimed.has(file.id)) {
        this.outcomes[index] = { kind: 'changed', target: file };
        this.claimed.add(file.id);
      }
    }
    return disagree.map((count, root) => count > 0 && confirmed[root] !== true);
  }

  /** Step 11: the entries of each exported root, and those found by their content. */
  private async tally(): Promise<Tally[]> {
    const tallies = this.exported.map((): Tally => ({
      files: 0,
      found: 0,
      foundIn: new Map<number, number>(),
    }));
    await eachInSlices(
      this.entries,
      (entry, index) => {
        const tally = tallies[entry.root];
        if (!tally) {
          return;
        }
        const outcome = this.outcomes[index];
        tally.files++;
        if (outcome?.kind === 'samePlace' || outcome?.kind === 'moved') {
          const { rootId } = outcome.target;
          tally.found++;
          tally.foundIn.set(rootId, (tally.foundIn.get(rootId) ?? 0) + 1);
        }
      },
      { signal: this.options.signal, slicer: this.slicer },
    );
    return tallies;
  }

  /** Step 10: why an entry was not found. */
  private missReason(
    entry: ImportEntry,
    index: number,
    tallies: readonly Tally[],
  ): TagImportMissReason {
    if (entry.missing) {
      return 'missing';
    }
    if (this.uncompared[index] === true) {
      return 'uncompared';
    }
    if (this.sameRoot[entry.root] === null && tallies[entry.root]?.found === 0) {
      return 'folder';
    }
    return 'notFound';
  }

  /** Library folders holding the files found of a folder, most first, then in `roots` order. */
  private foundIn(tally: Tally): string[] {
    const order = this.options.roots.map((root) => root.id);
    return [...tally.foundIn]
      .sort(
        byKeys(
          ([, count]) => -count,
          ([rootId]) => order.indexOf(rootId),
        ),
      )
      .slice(0, MAX_FOUND_IN)
      .map(([rootId]) => this.rootsById.get(rootId)?.path ?? '');
  }

  /**
   * What is known of the content of each file of the entry's size: those with its content, and
   * those not compared yet.
   */
  private judge(index: number): { same: Likeness[]; unknown: Candidate[] } {
    const same: Likeness[] = [];
    const unknown: Candidate[] = [];
    const entry = this.entries[index];
    if (!entry) {
      return { same, unknown };
    }
    const rel = this.folded[index] ?? [];
    const above = this.exportedPaths[entry.root]?.folded ?? [];
    const name = rel.at(-1) ?? '';
    const sameRoot = this.sameRoot[entry.root];
    for (const candidate of this.bySize.get(entry.size) ?? []) {
      const verdict = compare(entry, name, candidate);
      if (verdict === 'unknown') {
        unknown.push(candidate);
      } else if (verdict !== 'different') {
        // Where a file is only matters for those with its content, which are few: files of its
        // size may be many.
        const exact = this.isExact(index, candidate);
        const anchored = exact && candidate.depth === entry.segments.length;
        same.push({
          candidate,
          verified: verdict === 'same',
          tail: commonTailOf(above, rel, candidate.folded),
          anchored,
          exact,
          atPlace: anchored && sameRoot?.id === candidate.rootId,
          atPath: exact && this.isAtPath(entry, candidate),
        });
      }
    }
    return { same, unknown };
  }

  /** The entry's `same`, compared again since fingerprints were read: some may differ now. */
  private recheck(index: number): Likeness[] {
    return (this.same[index] ?? []).flatMap((likeness) => {
      const verdict = this.compareWith(index, likeness.candidate);
      if (verdict === 'different' || verdict === 'unknown') {
        return [];
      }
      const verified = verdict === 'same';
      return [verified === likeness.verified ? likeness : { ...likeness, verified }];
    });
  }

  /** Whether `candidate`'s path ends with the entry's whole relative path (see `Likeness`). */
  private isExact(index: number, candidate: Candidate): boolean {
    const rel = this.rels[index] ?? [];
    return commonTail(rel, candidate.place) === rel.length;
  }

  /**
   * Whether `candidate`, an exact counterpart of `entry`, is at its very path (see `Likeness`): the
   * folders above the entry's relative path are those of its exported library folder.
   */
  private isAtPath(entry: ImportEntry, candidate: Candidate): boolean {
    const root = this.exportedPaths[entry.root]?.place;
    return (
      this.platform === process.platform &&
      root !== undefined &&
      candidate.place.length === root.length + entry.segments.length &&
      root.every((segment, at) => candidate.place[at] === segment)
    );
  }

  /**
   * What is known of whether `file`, of the entry's size, has its content, without reading
   * anything.
   */
  private compareWith(index: number, file: Candidate): Verdict {
    const entry = this.entries[index];
    return entry ? compare(entry, this.folded[index]?.at(-1) ?? '', file) : 'unknown';
  }

  /** The present file no entry took at the entry's own place, in the same-path library folder. */
  private ownPlace(index: number): Candidate | undefined {
    let file = this.placed.get(index);
    if (file === undefined) {
      file = this.fileAtPlace(index) ?? null;
      this.placed.set(index, file);
    }
    return file === null || this.claimed.has(file.id) ? undefined : file;
  }

  /**
   * The present file at the entry's own place. Where names this computer takes as one name several
   * files there, the disk tells them apart: only the one at the entry's very path counts, or else
   * the one with its very name. An entry already missing when exported has none: nothing ties the
   * file now at its place to it.
   */
  private fileAtPlace(index: number): Candidate | undefined {
    const entry = this.entries[index];
    const root = entry && this.sameRoot[entry.root];
    if (!entry || !root || entry.missing) {
      return undefined;
    }
    const name = entry.segments.at(-1) ?? '';
    const dir = entry.segments.slice(0, -1).join('/');
    const files = this.options.files
      .named(name, root.id)
      .filter(
        (file) => !file.missing && this.eqPlace(file.name, name) && this.eqPlace(file.dir, dir),
      );
    let file = files[0];
    if (files.length > 1) {
      const exported = exportedPath(this.header, entry);
      file =
        only(files.filter((each) => each.path === exported)) ??
        only(files.filter((each) => each.name === name && each.dir === dir));
    }
    return file && (this.byId.get(file.id) ?? this.candidateOf(file));
  }

  /**
   * Pass A2's order, also among files at an entry's own place. Every one has the entry's whole
   * relative path: where it is says more than whether its content was found the same by its
   * fingerprint or by its name and date, as the indexer itself would. The file at the entry's very
   * path comes before the others, then the library folder holding most of its folder before the
   * place in a library folder: a file moved within the library folder at the entry's path is not
   * left for an old copy at that place in a backup.
   */
  private counterpartOrder(entry: ImportEntry): (a: Likeness, b: Likeness) => number {
    const mapped = this.mapped[entry.root] ?? null;
    return byKeys(
      ({ candidate }) => this.taken(candidate),
      ({ candidate }) => this.availability(candidate),
      ({ atPath }) => (atPath ? 0 : 1),
      ({ candidate }) => outside(candidate, mapped),
      ({ anchored }) => (anchored ? 0 : 1),
      ({ tail }) => -tail,
      ({ verified }) => (verified ? 0 : 1),
      ({ candidate }) => candidate.id,
    );
  }

  /**
   * Pass B's order. A name and date are the only evidence of some, which another file may have:
   * those known by their content come first.
   */
  private elsewhereOrder(entry: ImportEntry): (a: Likeness, b: Likeness) => number {
    const mapped = this.mapped[entry.root] ?? null;
    return byKeys(
      ({ candidate }) => this.taken(candidate),
      ({ candidate }) => (candidate.missing ? 1 : 0),
      ({ verified }) => (verified ? 0 : 1),
      ({ candidate }) => this.availability(candidate),
      ({ candidate }) => outside(candidate, mapped),
      ({ tail }) => -tail,
      ({ candidate }) => candidate.id,
    );
  }

  /** 1 for a file an entry was found as already, 0 otherwise. */
  private taken(file: Candidate): number {
    return this.claimed.has(file.id) ? 1 : 0;
  }

  /** 0 for a file on a connected drive, 1 on a drive that is not connected, 2 missing from disk. */
  private availability(file: Candidate): number {
    if (file.missing) {
      return 2;
    }
    return this.options.isOnline(file.rootId) ? 0 : 1;
  }

  /**
   * `samePlace` when the file is where the entry was in its library folder, or at its very path,
   * `moved` otherwise.
   */
  private take(index: number, { candidate, anchored, atPath }: Likeness): void {
    this.outcomes[index] = {
      kind: anchored || atPath ? 'samePlace' : 'moved',
      target: candidate,
      shared: this.claimed.has(candidate.id),
    };
    this.claimed.add(candidate.id);
  }

  /** Runs `step` on the entries not found yet, in slices. */
  private eachLeft(step: (entry: ImportEntry, index: number) => void): Promise<void> {
    return eachInSlices(
      this.entries,
      (entry, index) => {
        if (this.outcomes[index] === undefined) {
          step(entry, index);
        }
      },
      { signal: this.options.signal, slicer: this.slicer },
    );
  }

  /** NFC equality, in any case where names that differ only in case name one file. */
  private eqPlace(a: string, b: string): boolean {
    return samePath(a, b, this.options.caseInsensitive);
  }

  /** A copy of `file` to compare, unless its library folder is not one of `roots`. */
  private candidateOf(file: ImportCandidate): Candidate | undefined {
    const root = this.rootPaths.get(file.rootId);
    if (root === undefined) {
      return undefined;
    }
    const rel = this.segments([...(file.dir === '' ? [] : file.dir.split('/')), file.name]);
    return {
      ...file,
      folded: [...root.folded, ...rel.folded],
      place: [...root.place, ...rel.place],
      depth: rel.place.length,
    };
  }

  /** `segments` folded, and as `eqPlace` compares them: the same where case does not matter. */
  private segments(segments: readonly string[]): Segments {
    const folded = segments.map(fold);
    return {
      folded,
      place: this.options.caseInsensitive ? folded : segments.map(nfcOf),
    };
  }
}

/**
 * What is known of whether `file`, of the same size, has the content of `entry`, whose name folded
 * is `name`, without reading anything.
 */
/** `commonTail` of `above` followed by `rel`, and `other`, without joining the first two. */
function commonTailOf(
  above: readonly string[],
  rel: readonly string[],
  other: readonly string[],
): number {
  const tail = commonTail(rel, other);
  if (tail < rel.length) {
    return tail;
  }
  let same = 0;
  while (
    same < above.length &&
    tail + same < other.length &&
    above[above.length - 1 - same] === other[other.length - 1 - tail - same]
  ) {
    same++;
  }
  return tail + same;
}

function compare(entry: ImportEntry, name: string, file: Candidate): Verdict {
  if (entry.sha256 !== null && file.contentHash !== null) {
    return entry.sha256 === file.contentHash ? 'same' : 'different';
  }
  if (entry.fingerprint !== null && file.fingerprint !== null) {
    return entry.fingerprint === file.fingerprint ? 'same' : 'different';
  }
  // What the indexer itself takes as unchanged: the same name, size and modification time.
  if (
    entry.mtimeMs !== null &&
    Math.abs(entry.mtimeMs - file.mtimeMs) <= MTIME_TOLERANCE_MS &&
    name === file.folded.at(-1)
  ) {
    return 'unchanged';
  }
  return 'unknown';
}

/**
 * The files of `entry`'s size not compared yet whose fingerprint may tell where it is, given what
 * is known of it (`same`, `unknown`; see `wantsReads`). With an exact counterpart, its exact
 * counterparts (`isExact`): one may be a better place for its tags than those known, or the only
 * one no other entry takes. Otherwise all of them. One known by its name and date alone, away from
 * the entry's place, may be another photo, the entry's own file renamed since: once reads find all
 * its exact counterparts to differ, it is planned again (see `Matching.planAgain`).
 */
function readTargets(
  entry: ImportEntry,
  same: readonly Likeness[],
  unknown: readonly Candidate[],
  isExact: (candidate: Candidate) => boolean,
): readonly Candidate[] {
  if (!wantsReads(entry, same)) {
    return [];
  }
  return same.some(({ exact }) => exact) ? unknown.filter(isExact) : unknown;
}

/**
 * Whether a read may tell where `entry` is, given the files with its content as far as known:
 * not for an entry with no fingerprint, or one identical to the file at its own place or at its
 * very path.
 */
function wantsReads(entry: ImportEntry, same: readonly Likeness[]): boolean {
  return (
    entry.fingerprint !== null &&
    entry.size > 0 &&
    !same.some(({ atPlace, atPath }) => atPlace || atPath)
  );
}

/**
 * Known to have the entry's content by its hash or fingerprint, or by its name and date in the
 * folder and under the name the entry had in its library folder, in its own, or at its very path,
 * as the indexer would.
 */
function knownIdentical({ verified, anchored, atPath }: Likeness): boolean {
  return verified || anchored || atPath;
}

/**
 * Of an entry's exact counterparts, the one its place alone tells, if one does: at its own place,
 * else at its very path, else anywhere in the library folder at its path (`sameRoot`), where it may
 * have been moved since, else at its place in its library folder, else with the most alike path.
 */
function mostAlike(exact: readonly Likeness[], sameRoot: number | undefined): Likeness | undefined {
  const order = byKeys<Likeness>(
    ({ atPlace }) => (atPlace ? 0 : 1),
    ({ atPath }) => (atPath ? 0 : 1),
    ({ candidate }) => (candidate.rootId === sameRoot ? 0 : 1),
    ({ anchored }) => (anchored ? 0 : 1),
    ({ tail }) => -tail,
  );
  const best = first(exact, order);
  return best && only(exact.filter((likeness) => order(likeness, best) === 0));
}

/** The one item of `items`, if there is exactly one. */
function only<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** The first of `items` in `order`. */
function first<T>(items: readonly T[], order: (a: T, b: T) => number): T | undefined {
  let chosen: T | undefined;
  for (const item of items) {
    if (chosen === undefined || order(item, chosen) < 0) {
      chosen = item;
    }
  }
  return chosen;
}

/** Orders by `keys`, lower first: the first key that differs decides. */
function byKeys<T>(...keys: ((item: T) => number)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const difference = key(a) - key(b);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  };
}

/** 1 for a file outside library folder `mapped`, 0 inside. */
function outside(file: ImportCandidate, mapped: number | null): number {
  return file.rootId === mapped ? 0 : 1;
}

/** A name or path segment as ranking and name evidence compare it: NFC (`nfcOf`), in any case. */
function fold(value: string): string {
  return nfcOf(value).toLowerCase();
}

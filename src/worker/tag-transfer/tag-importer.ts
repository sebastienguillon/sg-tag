import { createLogger } from '@shared/log';
import type {
  TagImportAdditions,
  TagImportFolder,
  TagImportItem,
  TagImportMissedItem,
  TagImportMissReason,
  TagImportPreview,
  TagImportResult,
  TagImportSource,
  TagTransferProgress,
} from '@shared/model';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDirectory } from '../indexer/crawler';
import { fingerprint } from '../indexer/fingerprint';
import type {
  FileSnapshot,
  FilesRepository,
  FingerprintTarget,
  ImportCandidate,
} from '../library/files-repository';
import { caseInsensitive, pathSegments, rootsOverlap } from '../library/paths';
import type { RootRecord, RootsRepository } from '../library/roots-repository';
import type { TagsRepository } from '../library/tags-repository';
import { tagKey } from '../library/tags-repository';
import { eachInSlices, Slicer, yieldNow } from './slices';
import type { ImportEntry, ParsedTagFile } from './tag-file';
import { exportedPath, readTagFile } from './tag-file';
import type { MatchResult } from './tag-matcher';
import { matchEntries } from './tag-matcher';

const log = createLogger('tag-transfer');

/** Files per transaction when applying, and per tags query when planning. */
const CHUNK_SIZE = 1_000;
/** Files a preview lists, by kind. */
const MAX_MOVED_ITEMS = 100;
const MAX_CHANGED_ITEMS = 100;
const MAX_MISSED_ITEMS = 500;

/** Top folders where macOS and Linux mount, on demand, the network share a path names. */
const NETWORK_MOUNTS = new Set(['net', 'network']);

const NOT_OPEN = 'This tags export is no longer open: choose it again.';
const OUT_OF_DATE = 'This preview is out of date: check again.';
const APPLYING = 'Tags are being imported: wait until that is done.';

export interface TagImporterOptions {
  readonly files: FilesRepository;
  readonly tags: TagsRepository;
  readonly roots: RootsRepository;
  readonly isOnline: (rootId: number) => boolean;
  /** Resolves once indexing is idle, so that every file on disk is in the index. */
  readonly whenIndexed: () => Promise<void>;
  /** Tags were added to these files (once per chunk). */
  readonly onTagged: (ids: readonly number[]) => void;
  /**
   * An import that added tags ended, tagging these files; also when it failed part-way, since the
   * chunks added before the error stay.
   */
  readonly onImported: (ids: readonly number[]) => void;
  /** `progress` changed. */
  readonly onProgress: () => void;
  /** Whether names that differ only in case name one file (macOS, Windows); tests set it. */
  readonly caseInsensitive?: boolean;
  /** Reads an indexed file's fingerprint; tests inject a counting fake. */
  readonly read?: (target: FingerprintTarget) => Promise<string>;
}

/** A file that importing adds tags to. */
interface Target {
  /** Where it was and what it was at the preview: if that changed, it is left out. */
  readonly snapshot: FileSnapshot;
  /** Tags of its files in the tags export that it lacked then. */
  readonly additions: readonly string[];
  /** Found at its place only: its content changed since the export, or could not be compared. */
  readonly changed: boolean;
}

/** What applying a preview adds. */
interface Plan {
  readonly id: number;
  /** Files of the tags export not found. */
  readonly notFound: number;
  /** By file id; files that lacked no tag are left out. */
  readonly targets: ReadonlyMap<number, Target>;
}

/** The open tags export. */
interface Session {
  readonly token: string;
  readonly parsed: ParsedTagFile;
  /** The latest preview; none while another is being made. */
  plan: Plan | null;
}

/** A file that files of the tags export were found as, and their tags. */
interface Found {
  readonly file: ImportCandidate;
  readonly changed: boolean;
  /** By `tagKey`, first spelling kept. */
  readonly tags: Map<string, string>;
}

/** What a preview says of the files of a tags export, by what they were found as. */
type Summary = Pick<
  TagImportPreview,
  'found' | 'changed' | 'notFound' | 'movedItems' | 'changedItems' | 'missedItems'
>;

/**
 * Imports a tags export in two steps, adding tags and never removing any: `plan` matches its files
 * against the library and keeps what importing would add; `apply` adds exactly that, to the files
 * still where and what they were then. One tags export is open at a time.
 */
export class TagImporter {
  private readonly options: TagImporterOptions;
  private readonly caseInsensitive: boolean;
  private readonly read: (target: FingerprintTarget) => Promise<string>;
  private session: Session | null = null;
  /** Reading or planning: a newer one aborts it. */
  private task: AbortController | null = null;
  private applying = false;
  private lastPlanId = 0;
  private current: TagTransferProgress | null = null;

  constructor(options: TagImporterOptions) {
    this.options = options;
    this.caseInsensitive = options.caseInsensitive ?? caseInsensitive;
    this.read = options.read ?? ((target) => fingerprint(target.path, target.size));
  }

  /** Progress of reading, matching or applying, `null` when none is running. */
  get progress(): TagTransferProgress | null {
    return this.current;
  }

  /** Reading, matching or applying. */
  get busy(): boolean {
    return this.task !== null || this.applying;
  }

  /**
   * Reads the tags export at `filePath`, chosen in an open dialog, and keeps it open instead of any
   * other. Throws, saying why, when it cannot be imported.
   */
  async open(filePath: string): Promise<TagImportSource> {
    this.refuseWhileApplying();
    this.session = null;
    const task = this.start({ step: 'reading', done: 0, total: 0 });
    try {
      const started = performance.now();
      const parsed = await readTagFile(filePath, {
        signal: task.signal,
        onBytes: (done, total) => {
          this.report({ step: 'reading', done, total });
        },
      });
      task.signal.throwIfAborted();
      const { header, entries, tagCount, invalid, problems } = parsed;
      log.info(
        `Read a tags export of ${entries.length} files in ` +
          `${Math.round(performance.now() - started)} ms (${invalid} lines not read in full)`,
      );
      const token = randomUUID();
      this.session = { token, parsed, plan: null };
      return {
        token,
        name: path.basename(filePath),
        exportedAt: header.exportedAt,
        platform: header.platform,
        files: entries.length,
        tags: tagCount,
        invalid,
        problems,
      };
    } finally {
      this.settle(task);
    }
  }

  /**
   * Matches the open tags export against the library once indexing is idle, and tells what
   * importing it would add. Adds no tags. `open`, `close` or a newer call cancels it.
   */
  async plan(token: string): Promise<TagImportPreview> {
    const session = this.sessionOf(token);
    this.refuseWhileApplying();
    // Only the latest preview can be applied.
    session.plan = null;
    const task = this.start({ step: 'waiting', done: 0, total: 0 });
    const { signal } = task;
    try {
      await Promise.race([this.options.whenIndexed(), aborted(signal)]);
      signal.throwIfAborted();
      const { parsed } = session;
      const roots = this.options.roots.list();
      // One for all steps, so that each goes on with the slice of the one before.
      const slicer = new Slicer(signal);
      const match = await matchEntries(parsed, {
        files: this.options.files,
        roots,
        isOnline: this.options.isOnline,
        caseInsensitive: this.caseInsensitive,
        read: this.read,
        signal,
        slicer,
        onProgress: (step, done, total) => {
          this.report({ step, done, total });
        },
      });
      const folders = await this.foldersOf(parsed, match, roots, signal);
      const { summary, found } = await summarize(parsed, match, slicer);
      const { targets, additions, additionsWithChanged } = await this.targetsOf(found, slicer);
      const plan: Plan = {
        id: ++this.lastPlanId,
        notFound: Object.values(summary.notFound).reduce((sum, count) => sum + count, 0),
        targets,
      };
      session.plan = plan;
      return { planId: plan.id, ...summary, folders, additions, additionsWithChanged };
    } finally {
      this.settle(task);
    }
  }

  /**
   * Adds the tags of preview `planId`, with its changed files if `includeChanged`, then forgets the
   * tags export. Files that moved, changed, went missing from disk or left the library since the
   * preview are left out.
   * If adding fails part-way, the tags added so far stay and the tags export stays open, to be
   * checked again.
   */
  async apply(token: string, planId: number, includeChanged: boolean): Promise<TagImportResult> {
    const session = this.sessionOf(token);
    const { plan } = session;
    if (plan?.id !== planId) {
      throw new Error(OUT_OF_DATE);
    }
    this.refuseWhileApplying();
    this.applying = true;
    try {
      const result = await this.add(plan, includeChanged);
      // Importing again means opening the tags export again.
      this.session = null;
      return result;
    } catch (error) {
      // Only a new preview can tell what is left to add.
      session.plan = null;
      throw error;
    } finally {
      this.applying = false;
      this.report(null);
    }
  }

  /** Stops reading or matching and forgets the tags export; an import being applied finishes. */
  close(): void {
    this.session = null;
    if (this.task !== null) {
      this.task.abort(canceled());
      this.task = null;
      this.report(null);
    }
  }

  /**
   * The folders of the tags export that list files. One that nothing was found of can be added to
   * the library when it was exported from the same kind of computer and a folder at its very path
   * exists here, on a local disk and apart from the library folders: the only path of a tags
   * export ever looked at, and only to tell whether it is a folder.
   */
  private async foldersOf(
    parsed: ParsedTagFile,
    match: MatchResult,
    roots: readonly RootRecord[],
    signal: AbortSignal,
  ): Promise<TagImportFolder[]> {
    const sameKind = parsed.header.platform === process.platform;
    const folders: TagImportFolder[] = [];
    for (const [index, folder] of match.folders.entries()) {
      if (folder === null) {
        continue;
      }
      const { exported } = folder;
      const addable =
        folder.found === 0 &&
        match.samePathRoots[index] === null &&
        sameKind &&
        isLocalPath(exported) &&
        !roots.some((root) => rootsOverlap(root.path, exported)) &&
        (await isDirectory(exported));
      signal.throwIfAborted();
      folders.push({ ...folder, addable });
    }
    return folders;
  }

  /**
   * The tags each file found lacks, and what adding them adds, without the changed files and with
   * them. Yields between two tags once a slice of `slicer` is spent: a chunk of files can bring a
   * million tags, and a file found for many files of the tags export the tags of all of them.
   */
  private async targetsOf(
    found: readonly Found[],
    slicer: Slicer,
  ): Promise<{
    targets: Map<number, Target>;
    additions: TagImportAdditions;
    additionsWithChanged: TagImportAdditions;
  }> {
    const { tags } = this.options;
    const existing = new Set(tags.list().map((tag) => tagKey(tag.path)));
    const additions = new AdditionsCount(existing);
    const withChanged = new AdditionsCount(existing);
    const targets = new Map<number, Target>();
    for (let start = 0; start < found.length; start += CHUNK_SIZE) {
      // The work before may have spent the slice.
      if (slicer.due) {
        await slicer.yield();
      }
      const batch = found.slice(start, start + CHUNK_SIZE);
      const current = tags.pathsForFiles(batch.map(({ file }) => file.id));
      for (const { file, changed, tags: brought } of batch) {
        const has = new Set((current.get(file.id) ?? []).map(tagKey));
        const lacking: string[] = [];
        for (const [key, tag] of brought) {
          if (!has.has(key)) {
            lacking.push(tag);
            withChanged.tag(key);
            if (!changed) {
              additions.tag(key);
            }
          }
          if (slicer.due) {
            await slicer.yield();
          }
        }
        if (lacking.length > 0) {
          targets.set(file.id, { snapshot: snapshotOf(file), additions: lacking, changed });
          withChanged.file();
          if (!changed) {
            additions.file();
          }
        }
      }
    }
    return { targets, additions: additions.result, additionsWithChanged: withChanged.result };
  }

  /** Adds the tags of `plan`, a chunk of files at a time, each chunk kept once added. */
  private async add(plan: Plan, includeChanged: boolean): Promise<TagImportResult> {
    const started = performance.now();
    const ids = [...plan.targets]
      .filter(([, target]) => includeChanged || !target.changed)
      .map(([id]) => id)
      .sort((a, b) => a - b);
    const fileIds: number[] = [];
    let assignments = 0;
    let files = 0;
    let newTags = 0;
    this.report({ step: 'importing', done: 0, total: ids.length });
    try {
      for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
        const chunk = ids.slice(start, start + CHUNK_SIZE);
        // One transaction: no indexing can change these files between the check and the writes.
        const added = this.options.files.transaction(() => this.addChunk(plan, chunk));
        assignments += added.assignments;
        files += added.files;
        newTags += added.newTags;
        fileIds.push(...added.alive);
        if (added.alive.length > 0) {
          this.options.onTagged(added.alive);
        }
        this.report({ step: 'importing', done: start + chunk.length, total: ids.length });
        await yieldNow();
      }
    } finally {
      if (assignments > 0) {
        this.options.onImported(fileIds);
      }
    }
    const skipped = ids.length - fileIds.length;
    log.info(
      `Imported ${assignments} tags to ${files} files in ` +
        `${Math.round(performance.now() - started)} ms (${skipped} left out)`,
    );
    return { assignments, files, newTags, skipped, notFound: plan.notFound };
  }

  /**
   * Adds the planned tags to the files of `ids` still where and what they were at the preview.
   * Call within a transaction.
   */
  private addChunk(
    plan: Plan,
    ids: readonly number[],
  ): TagImportAdditions & { readonly alive: number[] } {
    const { files, tags } = this.options;
    const alive = files
      .snapshots(ids)
      .filter((row) => sameSnapshot(row, plan.targets.get(row.id)?.snapshot))
      .map((row) => row.id)
      .sort((a, b) => a - b);
    const current = tags.pathsForFiles(alive);
    // By tag, for the files still as they were only: no tag is created for nothing.
    const byTag = new Map<string, number[]>();
    let gaining = 0;
    for (const id of alive) {
      const has = new Set((current.get(id) ?? []).map(tagKey));
      const lacking = (plan.targets.get(id)?.additions ?? []).filter(
        (tag) => !has.has(tagKey(tag)),
      );
      if (lacking.length > 0) {
        gaining++;
      }
      for (const tag of lacking) {
        const group = byTag.get(tag);
        if (group) {
          group.push(id);
        } else {
          byTag.set(tag, [id]);
        }
      }
    }
    const before = tags.count();
    let assignments = 0;
    for (const [tag, fileIds] of byTag) {
      assignments += tags.addToFiles(fileIds, [tag]);
    }
    return { alive, assignments, files: gaining, newTags: tags.count() - before };
  }

  private sessionOf(token: string): Session {
    if (this.session?.token !== token) {
      throw new Error(NOT_OPEN);
    }
    return this.session;
  }

  private refuseWhileApplying(): void {
    if (this.applying) {
      throw new Error(APPLYING);
    }
  }

  /** Cancels any reading or planning, and starts another, which owns `progress` until it ends. */
  private start(progress: TagTransferProgress): AbortController {
    this.task?.abort(canceled());
    const task = new AbortController();
    this.task = task;
    this.report(progress);
    return task;
  }

  /** `task` ended: unless a newer one replaced it, nothing is running any more. */
  private settle(task: AbortController): void {
    if (this.task === task) {
      this.task = null;
      this.report(null);
    }
  }

  private report(progress: TagTransferProgress | null): void {
    this.current = progress;
    this.options.onProgress();
  }
}

/** Counts what adding tags to files adds, one file at a time: each tag it lacks, then the file. */
class AdditionsCount {
  private readonly existing: ReadonlySet<string>;
  private assignments = 0;
  private files = 0;
  /** `tagKey` of the tags created, ancestors included. */
  private readonly created = new Set<string>();

  /** `existing`: the `tagKey` of every tag in the library. */
  constructor(existing: ReadonlySet<string>) {
    this.existing = existing;
  }

  get result(): TagImportAdditions {
    return { assignments: this.assignments, files: this.files, newTags: this.created.size };
  }

  /**
   * The file gets the tag of `key`, which it lacks. Its ancestors are looked at only up to the
   * first one known: the ancestors of a tag of the library are in it too, and those of a tag
   * counted were counted with it. So a tag takes a lookup or two, however deep it is and however
   * many files get it.
   */
  tag(key: string): void {
    this.assignments++;
    let at = key;
    while (!this.existing.has(at) && !this.created.has(at)) {
      this.created.add(at);
      const end = at.lastIndexOf('/');
      if (end === -1) {
        return;
      }
      at = at.slice(0, end);
    }
  }

  /** One more file gets tags, each counted with `tag`. */
  file(): void {
    this.files++;
  }
}

/**
 * Counts the files of the tags export by what they were found as, and lists some, in slices of
 * `slicer`. Gathers the tags each file found here gets from them.
 */
async function summarize(
  { header, entries }: ParsedTagFile,
  match: MatchResult,
  slicer: Slicer,
): Promise<{ summary: Summary; found: Found[] }> {
  const found = { samePlace: 0, moved: 0, shared: 0 };
  const notFound: Record<TagImportMissReason, number> = {
    missing: 0,
    uncompared: 0,
    folder: 0,
    notFound: 0,
  };
  let changed = 0;
  const movedItems: TagImportItem[] = [];
  const changedItems: TagImportItem[] = [];
  const missedItems: TagImportMissedItem[] = [];
  const byId = new Map<number, Found>();
  await eachInSlices(
    match.outcomes,
    (outcome, index) => {
      const entry = entries[index] as ImportEntry;
      if (outcome.kind === 'notFound') {
        notFound[outcome.reason]++;
        if (missedItems.length < MAX_MISSED_ITEMS) {
          missedItems.push({ exported: exportedPath(header, entry), reason: outcome.reason });
        }
        return;
      }
      const { target } = outcome;
      const item = (): TagImportItem => ({
        exported: exportedPath(header, entry),
        current: target.path,
      });
      if (outcome.kind === 'changed') {
        changed++;
        if (changedItems.length < MAX_CHANGED_ITEMS) {
          changedItems.push(item());
        }
      } else if (outcome.shared) {
        found.shared++;
      } else {
        found[outcome.kind]++;
        if (outcome.kind === 'moved' && movedItems.length < MAX_MOVED_ITEMS) {
          movedItems.push(item());
        }
      }
      let file = byId.get(target.id);
      if (!file) {
        file = { file: target, changed: outcome.kind === 'changed', tags: new Map() };
        byId.set(target.id, file);
      }
      for (const tag of entry.tags) {
        const key = tagKey(tag);
        if (!file.tags.has(key)) {
          file.tags.set(key, tag);
        }
      }
    },
    { slicer },
  );
  return {
    summary: { found, changed, notFound, movedItems, changedItems, missedItems },
    found: [...byId.values()],
  };
}

/**
 * `value` is an absolute path on a disk of this computer, as written on `platform`: on Windows,
 * one starting with a drive letter; elsewhere, one starting with a single `/`, outside `/net` and
 * `/Network`. Merely looking at any other path, such as `\\host\share` or `/net/host/share`, can
 * reach out to the computer it names, and on Windows hand it the user's credentials.
 */
export function isLocalPath(value: string, platform: string = process.platform): boolean {
  const segments = pathSegments(value, platform);
  // `..` could lead out of a folder that looks local.
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  if (platform === 'win32') {
    // Not `\\host\share`, `//host/share`, nor a device path such as `\\?\UNC\host\share`.
    return /^[a-z]:[\\/]/i.test(value);
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return false;
  }
  const folded = segments.map((segment) => segment.toLowerCase());
  // macOS also reaches them through its data volume.
  const top = folded.slice(0, 3).join('/') === 'system/volumes/data' ? folded[3] : folded[0];
  return !NETWORK_MOUNTS.has(top ?? '');
}

/**
 * `row` is where and what `snapshot` was, on disk or missing from it as it was: a file that went
 * missing since is left out, as its row would give the tags to the next file saved at its path.
 */
function sameSnapshot(row: FileSnapshot, snapshot: FileSnapshot | undefined): boolean {
  return (
    row.rootId === snapshot?.rootId &&
    row.dir === snapshot.dir &&
    row.name === snapshot.name &&
    row.size === snapshot.size &&
    row.mtimeMs === snapshot.mtimeMs &&
    row.missing === snapshot.missing
  );
}

function snapshotOf(candidate: ImportCandidate): FileSnapshot {
  const { id, rootId, dir, name, size, mtimeMs, missing } = candidate;
  return { id, rootId, dir, name, size, mtimeMs, missing };
}

function canceled(): Error {
  return new Error('Canceled.');
}

/** Rejects with `signal`'s reason once it is aborted. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

import { createLogger } from '@shared/log';
import type {
  TagDefinitionCounts,
  TagImportAdditions,
  TagImportDefinitions,
  TagImportFolder,
  TagImportItem,
  TagImportMissedItem,
  TagImportMissReason,
  TagImportPreview,
  TagImportResult,
  TagImportSource,
  TagTransferProgress,
} from '@shared/model';
import { tagKey } from '@shared/tag-names';
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
import type { AppliedDefinitions, TagDefinition, TagsRepository } from '../library/tags-repository';
import { eachInSlices, Slicer, yieldNow } from './slices';
import type { ImportEntry, ParsedTagFile } from './tag-file';
import { exportedPath, readTagFile } from './tag-file';
import type { MatchResult } from './tag-matcher';
import { matchEntries } from './tag-matcher';

const log = createLogger('tag-transfer');

/** Files per transaction when applying, and per tags query when planning. */
const CHUNK_SIZE = 1_000;
/**
 * Names of a tags export looked up in the library at a time when planning, at most: about a
 * millisecond's work for names of ordinary length, at some 10 microseconds a name in a library of
 * 100,000 tags, so that a slice is hardly overrun. Larger batches look a name up no faster.
 */
const NAME_BATCH = 100;
/**
 * UTF-16 units of the names looked up at a time, at most. A name takes longer to look up the
 * longer it is, up to some 0.4 ms at the 1,024 units a name may have: 100 such names would hold
 * the worker for several slices, so they are looked up 4 at a time. Names of up to 40 units on
 * average are still looked up 100 at a time.
 */
const NAME_BATCH_UNITS = 4_096;
/** Files a preview lists, by kind. */
const MAX_MOVED_ITEMS = 100;
const MAX_CHANGED_ITEMS = 100;
const MAX_MISSED_ITEMS = 500;
/** Tags, aliases, links and what is left out of them that a preview lists, by kind. */
const MAX_DEFINITION_ITEMS = 100;

/** What a tags export without tag lines describes. */
const NO_DEFINITIONS: AppliedDefinitions = {
  named: new Map(),
  created: [],
  aliases: [],
  links: [],
  knownAs: [],
  skipped: [],
};

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
  /** Applying an import made tags, or gave tags aliases or parent tags, before tagging files. */
  readonly onDefined: () => void;
  /** `progress` changed. */
  readonly onProgress: () => void;
  /** Whether names that differ only in case name one file (macOS, Windows); tests set it. */
  readonly caseInsensitive?: boolean;
  /** Reads an indexed file's fingerprint; tests inject a counting fake. */
  readonly read?: (target: FingerprintTarget) => Promise<string>;
}

/**
 * What a name of a tags export stands for in the library: the tag that it is the name or an alias
 * of, by its id, or else a tag that the library lacks, by the `tagKey` of the name. Two names of
 * one tag stand for the same. A name that the tag lines describe stands for what they make it
 * stand for (`AppliedDefinitions.named`).
 */
type NamedTag = number | string;

/** A file that importing adds tags to. */
interface Target {
  /** Where it was and what it was at the preview: if that changed, it is left out. */
  readonly snapshot: FileSnapshot;
  /**
   * Of the tags of its files in the tags export, those it lacked then, each by every name that
   * those files have for it. Names and not tags: what they stand for is looked up again when they
   * are added. Every name of a tag and not one of them: by then the tag may have lost an alias, or
   * be gone, so that its names no longer stand for one tag, and the file gets what each stands for.
   */
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
  /** Their names by `tagKey`, first spelling kept. */
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
 *
 * A tags export describes tags (its tag lines: aliases and parent tags) and names the tags of each
 * file. What its tag lines describe is added first, as `TagsRepository.applyDefinitions` adds it:
 * tags made, aliases and parent links the library lacks. A name then stands for the tag the tag
 * lines make it stand for, or else the tag of the library that has it as its name or as an alias,
 * or else a tag to make. Files are compared by tag, so a file is not given a tag that it has under
 * another of its names. All this is worked out for the preview, writing nothing, and again when
 * importing: in between, tags may be renamed, merged or deleted, and aliases added or removed.
 */
export class TagImporter {
  private readonly options: TagImporterOptions;
  private readonly caseInsensitive: boolean;
  private readonly read: (target: FingerprintTarget) => Promise<string>;
  private session: Session | null = null;
  /** Reading or planning: a newer one aborts it. */
  private task: AbortController | null = null;
  /** `apply` is adding tags. */
  private importing = false;
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
    return this.task !== null || this.importing;
  }

  /**
   * An import is being applied: tags are being added, from the call to `apply` until all are added
   * or adding them failed. Not while a tags export is read or a preview made, which write nothing.
   */
  get applying(): boolean {
    return this.importing;
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
      const { header, entries, definitions, tagCount, invalid, problems } = parsed;
      log.info(
        `Read a tags export of ${entries.length} files and ${definitions.length} tags described ` +
          `in ${Math.round(performance.now() - started)} ms (${invalid} lines not read in full)`,
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
      if (slicer.due) {
        await slicer.yield();
      }
      // One transaction, which a dry run writes nothing in: what the tag lines would add.
      const defined = this.define(parsed.definitions, true);
      const { targets, additions, additionsWithChanged } = await this.targetsOf(
        found,
        parsed.tags,
        defined.named,
        slicer,
      );
      const definitions = await this.describe(defined, slicer);
      const plan: Plan = {
        id: ++this.lastPlanId,
        notFound: Object.values(summary.notFound).reduce((sum, count) => sum + count, 0),
        targets,
      };
      session.plan = plan;
      return { planId: plan.id, ...summary, folders, additions, additionsWithChanged, definitions };
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
    this.importing = true;
    try {
      const result = await this.add(plan, includeChanged, session.parsed.definitions);
      // Importing again means opening the tags export again.
      this.session = null;
      return result;
    } catch (error) {
      // Only a new preview can tell what is left to add.
      session.plan = null;
      throw error;
    } finally {
      this.importing = false;
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
   * What the tag lines of `definitions` add, as `TagsRepository.applyDefinitions` adds it: written
   * unless `dryRun`. Nothing to do for a tags export without tag lines.
   */
  private define(definitions: readonly TagDefinition[], dryRun: boolean): AppliedDefinitions {
    return definitions.length === 0
      ? NO_DEFINITIONS
      : this.options.tags.applyDefinitions(definitions, dryRun);
  }

  /**
   * What a preview says of what the tag lines add: how many of each, and the first of each. For a
   * link that puts a tag of the library below another, how many files a search for the parent tag
   * starts to find, worked out one link at a time, the event loop running between two once a slice
   * of `slicer` is spent.
   */
  private async describe(
    defined: AppliedDefinitions,
    slicer: Slicer,
  ): Promise<TagImportDefinitions> {
    const linkItems: TagImportDefinitions['linkItems'][number][] = [];
    for (const { tag, parent, tagId, parentId } of defined.links.slice(0, MAX_DEFINITION_ITEMS)) {
      if (slicer.due) {
        await slicer.yield();
      }
      linkItems.push({
        tag,
        parent,
        newlyFound: tagId === null ? null : this.options.tags.newlyFound(tagId, parentId),
      });
    }
    return {
      ...countsOf(defined),
      createdItems: defined.created.slice(0, MAX_DEFINITION_ITEMS),
      aliasItems: defined.aliases.slice(0, MAX_DEFINITION_ITEMS),
      linkItems,
      knownAs: defined.knownAs.length,
      knownAsItems: defined.knownAs.slice(0, MAX_DEFINITION_ITEMS),
      skippedItems: defined.skipped.slice(0, MAX_DEFINITION_ITEMS),
    };
  }

  /**
   * The tags of a tags export that the library has: by `tagKey`, the id of the tag that has the
   * name, as its name or as an alias. `names` are those of the tags export, by `tagKey`, less those
   * that its tag lines describe (`named`). They are looked up a batch at a time (`nameBatches`), the
   * event loop running between two batches once a slice of `slicer` is spent: there may be a
   * million of them.
   */
  private async knownTags(
    names: ReadonlyMap<string, string>,
    named: ReadonlyMap<string, NamedTag>,
    slicer: Slicer,
  ): Promise<Map<string, number>> {
    const known = new Map<string, number>();
    const undescribed = new Map([...names].filter(([key]) => !named.has(key)));
    for (const batch of nameBatches(undescribed)) {
      // The work before may have spent the slice.
      if (slicer.due) {
        await slicer.yield();
      }
      const resolved = this.options.tags.resolve(batch.map(([, name]) => name));
      batch.forEach(([key], index) => {
        const tag = resolved[index];
        if (tag) {
          known.set(key, tag.id);
        }
      });
    }
    return known;
  }

  /**
   * The tags each file found lacks, and what adding them adds, without the changed files and with
   * them. `names` are those of the tags export, by `tagKey`: what they stand for is what its tag
   * lines make them stand for (`named`), or else what the library says, looked up once
   * (`knownTags`). Each file is compared by tag, so a name or an alias of a tag that the file has
   * adds nothing, and a tag that it lacks is counted once, whatever names of it the tags export
   * has. Yields between two tags once a slice of `slicer` is spent: a chunk of files can bring a
   * million tags, and a file found for many files of the tags export the tags of all of them.
   */
  private async targetsOf(
    found: readonly Found[],
    names: ReadonlyMap<string, string>,
    named: ReadonlyMap<string, NamedTag>,
    slicer: Slicer,
  ): Promise<{
    targets: Map<number, Target>;
    additions: TagImportAdditions;
    additionsWithChanged: TagImportAdditions;
  }> {
    const { tags } = this.options;
    const known = await this.knownTags(names, named, slicer);
    // Tags that the tag lines make: counted with them, not as new tags of files.
    const described = new Set([...named.values()].filter((tag) => typeof tag === 'string'));
    const additions = new AdditionsCount(described);
    const withChanged = new AdditionsCount(described);
    const targets = new Map<number, Target>();
    for (let start = 0; start < found.length; start += CHUNK_SIZE) {
      // The work before may have spent the slice.
      if (slicer.due) {
        await slicer.yield();
      }
      const batch = found.slice(start, start + CHUNK_SIZE);
      const current = tags.idsForFiles(batch.map(({ file }) => file.id));
      for (const { file, changed, tags: brought } of batch) {
        // The tags it has: a name of one of them adds nothing.
        const had = new Set<NamedTag>(current.get(file.id));
        // The tags it gets: each is counted once, and kept under every name of it.
        const gets = new Set<NamedTag>();
        const lacking: string[] = [];
        for (const [key, name] of brought) {
          const tag = named.get(key) ?? known.get(key) ?? key;
          if (!had.has(tag)) {
            lacking.push(name);
            if (!gets.has(tag)) {
              gets.add(tag);
              withChanged.tag(tag);
              if (!changed) {
                additions.tag(tag);
              }
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

  /**
   * Adds what the tag lines `definitions` describe, in one transaction, then the tags of `plan`, a
   * chunk of files at a time, each chunk kept once added.
   */
  private async add(
    plan: Plan,
    includeChanged: boolean,
    definitions: readonly TagDefinition[],
  ): Promise<TagImportResult> {
    const started = performance.now();
    const defined = this.define(definitions, false);
    const counts = countsOf(defined);
    if (counts.created + counts.aliases + counts.links > 0) {
      this.options.onDefined();
    }
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
        const added = this.options.files.transaction(() =>
          this.addChunk(plan, chunk, defined.named),
        );
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
      `Imported ${assignments} tags to ${files} files, made ${counts.created} tags and added ` +
        `${counts.aliases} aliases and ${counts.links} parent links in ` +
        `${Math.round(performance.now() - started)} ms (${skipped} files and ` +
        `${counts.skipped} aliases or links left out)`,
    );
    return { assignments, files, newTags, skipped, notFound: plan.notFound, definitions: counts };
  }

  /**
   * Adds the planned tags to the files of `ids` still where and what they were at the preview, by
   * what their names stand for now (`namedTags`): a file gets each tag it lacks once, whatever
   * names of it were planned. Call within a transaction: nothing changes between the lookups and
   * the writes, and the library takes every name that a tags export is read with
   * (`normalizeTagName`), so each file gains exactly the tags it is found to lack, which are those
   * counted.
   */
  private addChunk(
    plan: Plan,
    ids: readonly number[],
    described: ReadonlyMap<string, NamedTag>,
  ): TagImportAdditions & { readonly alive: number[] } {
    const { files, tags } = this.options;
    const alive = files
      .snapshots(ids)
      .filter((row) => sameSnapshot(row, plan.targets.get(row.id)?.snapshot))
      .map((row) => row.id)
      .sort((a, b) => a - b);
    const planned = alive.map((id) => ({ id, names: plan.targets.get(id)?.additions ?? [] }));
    const named = this.namedTags(
      planned.flatMap(({ names }) => names),
      described,
    );
    const current = tags.idsForFiles(alive);
    // By tag, for the files still as they were only: no tag is created for nothing. Each is added
    // under the first name planned for it.
    const byTag = new Map<NamedTag, { readonly name: string; readonly fileIds: number[] }>();
    let assignments = 0;
    let gaining = 0;
    for (const { id, names } of planned) {
      // The tags it has, and then those it gets: another name of one of them adds nothing more.
      const has = new Set<NamedTag>(current.get(id));
      let gained = 0;
      for (const name of names) {
        const tag = named.get(name) as NamedTag;
        if (has.has(tag)) {
          continue;
        }
        has.add(tag);
        gained++;
        const group = byTag.get(tag);
        if (group) {
          group.fileIds.push(id);
        } else {
          byTag.set(tag, { name, fileIds: [id] });
        }
      }
      assignments += gained;
      if (gained > 0) {
        gaining++;
      }
    }
    const before = tags.count();
    for (const [tag, { name, fileIds }] of byTag) {
      if (typeof tag === 'number') {
        tags.attach(fileIds, [tag]);
      } else {
        tags.addToFiles(fileIds, [name]);
      }
    }
    return { alive, assignments, files: gaining, newTags: tags.count() - before };
  }

  /**
   * What each of `names` stands for in the library now: the tag that the tag lines made it stand
   * for (`described`, once they are added), or else the tag that has it as its name or as an alias,
   * or else, by its `tagKey`, a tag that the library lacks.
   */
  private namedTags(
    names: readonly string[],
    described: ReadonlyMap<string, NamedTag>,
  ): Map<string, NamedTag> {
    const distinct = [...new Set(names)];
    const keys = distinct.map(tagKey);
    const undescribed = distinct.filter((_name, index) => !described.has(keys[index] as string));
    const resolved = new Map(
      this.options.tags.resolve(undescribed).map((tag, index) => [undescribed[index], tag]),
    );
    return new Map(
      distinct.map((name, index) => {
        const key = keys[index] as string;
        return [name, described.get(key) ?? resolved.get(name)?.id ?? key];
      }),
    );
  }

  private sessionOf(token: string): Session {
    if (this.session?.token !== token) {
      throw new Error(NOT_OPEN);
    }
    return this.session;
  }

  private refuseWhileApplying(): void {
    if (this.importing) {
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
  private assignments = 0;
  private files = 0;
  /** `tagKey` of the tags that the library lacks, each once. */
  private readonly created = new Set<string>();
  /** Tags that the tag lines make, by `tagKey`: counted with them, not here. */
  private readonly described: ReadonlySet<NamedTag>;

  constructor(described: ReadonlySet<NamedTag>) {
    this.described = described;
  }

  get result(): TagImportAdditions {
    return { assignments: this.assignments, files: this.files, newTags: this.created.size };
  }

  /**
   * The file gets `tag`, which it lacks. A tag that the library lacks is counted as new once,
   * however many files get it, unless the tag lines make it.
   */
  tag(tag: NamedTag): void {
    this.assignments++;
    if (typeof tag === 'string' && !this.described.has(tag)) {
      this.created.add(tag);
    }
  }

  /** One more file gets tags, each counted with `tag`. */
  file(): void {
    this.files++;
  }
}

/** How many of each thing the tag lines add, and how many are left out. */
function countsOf(defined: AppliedDefinitions): TagDefinitionCounts {
  return {
    created: defined.created.length,
    aliases: defined.aliases.length,
    links: defined.links.length,
    skipped: defined.skipped.length,
  };
}

/**
 * `names`, those of a tags export by `tagKey`, in order and a batch at a time: a batch holds at
 * most `NAME_BATCH` names, and at most `NAME_BATCH_UNITS` UTF-16 units in all of them.
 */
function* nameBatches(
  names: ReadonlyMap<string, string>,
): Generator<(readonly [key: string, name: string])[]> {
  let batch: (readonly [string, string])[] = [];
  let units = 0;
  for (const named of names) {
    const { length } = named[1];
    if (batch.length === NAME_BATCH || (batch.length > 0 && units + length > NAME_BATCH_UNITS)) {
      yield batch;
      batch = [];
      units = 0;
    }
    batch.push(named);
    units += length;
  }
  if (batch.length > 0) {
    yield batch;
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

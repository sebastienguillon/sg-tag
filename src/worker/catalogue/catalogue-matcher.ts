import { createLogger } from '@shared/log';
import type { TagImportFolder } from '@shared/model';
import type { FilesRepository } from '../library/files-repository';
import type { RootRecord } from '../library/roots-repository';
import { eachInSlices, Slicer } from '../tag-transfer/slices';
import type { ParsedTagFile } from '../tag-transfer/tag-file';
import type { MatchResult, Outcome } from '../tag-transfer/tag-matcher';
import type { CataloguePlace } from './catalogue-locator';
import { CatalogueLocator } from './catalogue-locator';

const log = createLogger('tag-transfer');

/** Library folders listed for the catalogue's folder, most files first. */
const MAX_FOUND_IN = 3;

export interface CatalogueMatchOptions {
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

/**
 * The file each entry of `parsed`, a classification catalogue read by `catalogueImport`, is in
 * this library, as `CatalogueLocator` finds it from the place of the entry (`places`, by entry
 * index): no file is read. A file that several entries are found as gets the tags of each
 * (`shared`).
 */
export async function matchCatalogueEntries(
  parsed: ParsedTagFile,
  places: readonly CataloguePlace[],
  options: CatalogueMatchOptions,
): Promise<MatchResult> {
  const started = performance.now();
  const locator = new CatalogueLocator({
    files: options.files,
    roots: options.roots,
    caseInsensitive: options.caseInsensitive,
    platform: options.platform ?? process.platform,
  });
  const total = places.length;
  const outcomes: Outcome[] = [];
  await eachInSlices(
    places,
    (place) => {
      outcomes.push(locator.locate(place));
    },
    {
      slicer: options.slicer ?? new Slicer(options.signal),
      onSlice: (done) => {
        options.onProgress('matching', done, total);
      },
    },
  );

  const taken = new Map<number, number>();
  for (const outcome of outcomes) {
    if (outcome.kind === 'samePlace' || outcome.kind === 'moved') {
      taken.set(outcome.target.id, (taken.get(outcome.target.id) ?? 0) + 1);
    }
  }
  const settled = outcomes.map((outcome): Outcome =>
    (outcome.kind === 'samePlace' || outcome.kind === 'moved') &&
    (taken.get(outcome.target.id) ?? 0) > 1
      ? { ...outcome, shared: true }
      : outcome,
  );

  const folder = parsed.header.roots[0] ?? '';
  const folderKey = locator.keyOf(locator.segmentsOf(folder));
  const samePath =
    options.roots.find((root) => locator.keyOf(locator.segmentsOf(root.path)) === folderKey) ??
    null;
  log.info(
    `Matched ${String(total)} files of a classification catalogue in ` +
      `${String(Math.round(performance.now() - started))} ms`,
  );
  return {
    outcomes: settled,
    folders: [total === 0 ? null : summaryOf(folder, settled, options.roots, samePath !== null)],
    samePathRoots: [samePath],
    reads: 0,
  };
}

/** What is said of the catalogue's folder: how many files were found, and in which folders. */
function summaryOf(
  folder: string,
  outcomes: readonly Outcome[],
  roots: readonly RootRecord[],
  inLibrary: boolean,
): Omit<TagImportFolder, 'addable'> {
  const counts = new Map<string, number>();
  let found = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'samePlace' || outcome.kind === 'moved') {
      found++;
      const root = roots.find((each) => each.id === outcome.target.rootId);
      if (root) {
        counts.set(root.path, (counts.get(root.path) ?? 0) + 1);
      }
    }
  }
  return {
    exported: folder,
    files: outcomes.length,
    found,
    foundIn: [...counts]
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_FOUND_IN)
      .map(([path]) => path),
    inLibrary,
    suspicious: false,
  };
}

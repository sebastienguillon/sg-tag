import { createLogger } from '@shared/log';
import type { CatalogueEntry, CatalogueStatus, CatalogueSuggestion } from '@shared/model';
import { errorMessage } from '@shared/rpc';
import { stat } from 'node:fs/promises';
import type { FilesRepository } from '../library/files-repository';
import { caseInsensitive } from '../library/paths';
import type { RootsRepository } from '../library/roots-repository';
import type { SettingsRepository } from '../library/settings-repository';
import type { TagDefinition, TagsRepository } from '../library/tags-repository';
import type { Catalogue, CatalogueRow } from './catalogue-file';
import { CatalogueError, readCatalogue } from './catalogue-file';
import { CatalogueLocator } from './catalogue-locator';

const log = createLogger('catalogue');

/** Least time between two checks of the catalogue on disk for a change: selections come fast. */
const CHECK_INTERVAL_MS = 1_000;

const CANNOT_READ = 'Cannot read this file.';
const GONE =
  'Cannot read the catalogue: it was moved or deleted, or its drive is not connected. ' +
  'Choose it again, or another one.';

/** What a catalogue is used through: its rows, and the rows of each place. */
interface Loaded {
  readonly catalogue: Catalogue;
  /** By the key of a path (`CatalogueLocator.keyOf`), the first row listing it. */
  readonly byPath: ReadonlyMap<string, CatalogueRow>;
  /** By name key and size, the rows that give a size and a date: those that may have moved. */
  readonly byNameAndSize: ReadonlyMap<string, readonly CatalogueRow[]>;
}

/** A row of the catalogue, and how its file was found. */
export interface LocatedRow {
  readonly row: CatalogueRow;
  readonly found: CatalogueEntry['found'];
}

export interface CatalogueServiceOptions {
  readonly files: FilesRepository;
  readonly roots: RootsRepository;
  readonly tags: TagsRepository;
  readonly settings: SettingsRepository;
  /** A catalogue was chosen, forgotten or read again, or can no longer be read. */
  readonly onChanged: () => void;
  /** Whether names that differ only in case name one file (macOS, Windows); tests set it. */
  readonly caseInsensitive?: boolean;
  /** `process.platform` by default; tests pass another to read paths as it writes them. */
  readonly platform?: string;
  /** `CHECK_INTERVAL_MS` by default; tests pass 0. */
  readonly checkIntervalMs?: number;
}

/**
 * The classification catalogue chosen in Settings: remembered in the library, read into memory
 * when chosen and when the indexer starts, and read again when its size or modification time
 * changed, checked when it is asked for at most once a `CHECK_INTERVAL_MS`. A catalogue that can no
 * longer be read stays chosen, saying why, until it can again or another is chosen.
 */
export class CatalogueService {
  private readonly options: CatalogueServiceOptions;
  private readonly caseInsensitive: boolean;
  private readonly platform: string;
  private chosen: string | null;
  private loaded: Loaded | null = null;
  private error: string | null = null;
  /** Reading or checking the chosen catalogue. */
  private reading: Promise<void> | null = null;
  private lastCheck = Number.NEGATIVE_INFINITY;
  /** Changes with every choice: a read of a catalogue chosen before is then dropped. */
  private generation = 0;

  constructor(options: CatalogueServiceOptions) {
    this.options = options;
    this.caseInsensitive = options.caseInsensitive ?? caseInsensitive;
    this.platform = options.platform ?? process.platform;
    this.chosen = options.settings.catalogueFile();
  }

  /** Reads the catalogue chosen before, if any. */
  async start(): Promise<void> {
    await this.refresh(true);
  }

  /**
   * Reads the catalogue at `filePath` and uses it from then on. Throws, saying why, when it cannot
   * be used: the catalogue chosen before stays.
   */
  async choose(filePath: string): Promise<CatalogueStatus> {
    const catalogue = await readCatalogue(filePath, { platform: this.platform });
    this.generation++;
    this.chosen = filePath;
    this.loaded = this.index(catalogue);
    this.error = null;
    this.lastCheck = performance.now();
    this.options.settings.recordCatalogueFile(filePath);
    log.info(
      `Chose a catalogue of ${String(catalogue.rows.length)} rows ` +
        `(${String(catalogue.invalid)} not read)`,
    );
    this.options.onChanged();
    return this.describe() as CatalogueStatus;
  }

  /** Stops using the catalogue. */
  forget(): void {
    if (this.chosen === null) {
      return;
    }
    this.generation++;
    this.chosen = null;
    this.loaded = null;
    this.error = null;
    this.options.settings.recordCatalogueFile(null);
    this.options.onChanged();
  }

  async status(): Promise<CatalogueStatus | null> {
    await this.refresh();
    return this.describe();
  }

  /** The catalogue as it is on disk now, read again first if it changed; `null` when none is. */
  async current(): Promise<Catalogue | null> {
    await this.refresh();
    return this.loaded?.catalogue ?? null;
  }

  /** What the catalogue says of file `id`; `null` when none is chosen or it does not list it. */
  async entryFor(id: number): Promise<CatalogueEntry | null> {
    const located = await this.rowFor(id);
    if (located === null) {
      return null;
    }
    const { row, found } = located;
    const { tags } = this.options;
    const names = [row.subcategory, ...row.formats];
    const has = new Set(tags.idsForFiles([id]).get(id));
    const resolved = tags.resolve(names);
    const suggestions = names.map((name, index): CatalogueSuggestion => ({
      name,
      kind: index === 0 ? 'subject' : 'format',
      added: has.has(resolved[index]?.id ?? 0),
    }));
    return {
      category: row.category,
      subcategory: row.subcategory,
      confidence: row.confidence,
      flagged: row.flagged,
      reviewStatus: row.reviewStatus,
      topic: row.topic,
      visibleContent: row.visibleContent,
      reviewNotes: row.reviewNotes,
      found,
      classifiedPath: row.path,
      suggestions,
    };
  }

  /**
   * The row of file `id`, as the import finds files (`CatalogueLocator`): the row at its path, else
   * a row with its name and size that the locator takes to be this file. `null` when no catalogue
   * is chosen or none is.
   */
  async rowFor(id: number): Promise<LocatedRow | null> {
    await this.refresh();
    const { loaded } = this;
    const { files } = this.options;
    const [file] = files.snapshots([id]);
    const filePath = files.pathOf(id);
    if (loaded === null || file === undefined || filePath === null) {
      return null;
    }
    const locator = this.locator();
    const atPath = loaded.byPath.get(locator.keyOf(locator.segmentsOf(filePath)));
    const candidates = [
      ...(atPath ? [atPath] : []),
      ...(loaded.byNameAndSize.get(nameAndSizeKey(locator.fold(file.name), file.size)) ?? []),
    ];
    for (const row of candidates) {
      const outcome = locator.locate(row);
      if (
        (outcome.kind === 'samePlace' || outcome.kind === 'changed' || outcome.kind === 'moved') &&
        outcome.target.id === id
      ) {
        return { row, found: outcome.kind };
      }
    }
    return null;
  }

  /** A locator on the library folders as they are now. */
  locator(): CatalogueLocator {
    return new CatalogueLocator({
      files: this.options.files,
      roots: this.options.roots.list(),
      caseInsensitive: this.caseInsensitive,
      platform: this.platform,
    });
  }

  private describe(): CatalogueStatus | null {
    if (this.chosen === null) {
      return null;
    }
    const catalogue = this.loaded?.catalogue;
    return {
      path: this.chosen,
      rows: catalogue?.rows.length ?? 0,
      invalid: catalogue?.invalid ?? 0,
      problems: catalogue?.problems ?? [],
      error: this.error,
    };
  }

  /**
   * Reads the chosen catalogue again if it changed on disk since it was read, unless it was
   * checked less than `CHECK_INTERVAL_MS` ago (`force` checks it all the same). Resolves once done:
   * a check under way is waited for.
   */
  private refresh(force = false): Promise<void> {
    if (this.chosen === null) {
      return Promise.resolve();
    }
    if (this.reading !== null) {
      return this.reading;
    }
    const interval = this.options.checkIntervalMs ?? CHECK_INTERVAL_MS;
    if (!force && performance.now() - this.lastCheck < interval) {
      return Promise.resolve();
    }
    this.lastCheck = performance.now();
    const reading = this.check(this.chosen, this.generation).finally(() => {
      this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  private async check(filePath: string, generation: number): Promise<void> {
    const info = await stat(filePath).catch(() => null);
    if (generation !== this.generation) {
      return;
    }
    if (info === null) {
      this.drop(GONE);
      return;
    }
    const known = this.loaded?.catalogue;
    if (known?.size === info.size && known.mtimeMs === info.mtimeMs) {
      return;
    }
    try {
      const catalogue = await readCatalogue(filePath, { platform: this.platform });
      if (generation !== this.generation) {
        return;
      }
      this.loaded = this.index(catalogue);
      this.error = null;
      log.info(`Read the catalogue again: ${String(catalogue.rows.length)} rows`);
      this.options.onChanged();
    } catch (error) {
      if (generation === this.generation) {
        log.warn('Cannot read the catalogue:', errorMessage(error));
        this.drop(error instanceof CatalogueError ? error.message : CANNOT_READ);
      }
    }
  }

  /** The catalogue chosen can no longer be read, for `reason`: it stays chosen, unused. */
  private drop(reason: string): void {
    if (this.loaded === null && this.error === reason) {
      return;
    }
    this.loaded = null;
    this.error = reason;
    this.options.onChanged();
  }

  private index(catalogue: Catalogue): Loaded {
    const locator = this.locator();
    const byPath = new Map<string, CatalogueRow>();
    const byNameAndSize = new Map<string, CatalogueRow[]>();
    for (const row of catalogue.rows) {
      const key = locator.keyOf(row.segments);
      if (!byPath.has(key)) {
        byPath.set(key, row);
      }
      if (row.size !== null && row.mtimeMs !== null) {
        const nameKey = nameAndSizeKey(locator.fold(row.segments.at(-1) ?? ''), row.size);
        const rows = byNameAndSize.get(nameKey);
        if (rows) {
          rows.push(row);
        } else {
          byNameAndSize.set(nameKey, [row]);
        }
      }
    }
    return { catalogue, byPath, byNameAndSize };
  }
}

function nameAndSizeKey(name: string, size: number): string {
  return `${String(size)}/${name}`;
}

/**
 * What tagging a file with the subcategory of `row` defines: the category, and the subcategory
 * below it.
 */
export function subjectDefinitions(row: CatalogueRow): TagDefinition[] {
  return [
    { name: row.category, aliases: [], parents: [] },
    { name: row.subcategory, aliases: [], parents: [row.category] },
  ];
}

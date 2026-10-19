import { createLogger } from '@shared/log';
import type { Diagnostics, FileCopy, IndexStatus, LibraryRoot } from '@shared/model';
import type { Channel, RpcHandlers } from '@shared/rpc';
import { errorMessage, RpcServer } from '@shared/rpc';
import type { LibraryApi, LibraryEvents, WorkerHostApi } from '@shared/worker-api';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './database/database';
import { openDatabase } from './database/database';
import { DuplicateFinder } from './duplicates/duplicate-finder';
import { TrashGuard } from './duplicates/trash-guard';
import { Fingerprinter } from './indexer/fingerprinter';
import { Indexer } from './indexer/indexer';
import type { ChangeSet } from './indexer/reconciler';
import { Reconciler } from './indexer/reconciler';
import { FilesRepository } from './library/files-repository';
import type { RootRecord } from './library/roots-repository';
import { RootsRepository } from './library/roots-repository';
import { SettingsRepository } from './library/settings-repository';
import { TagsRepository } from './library/tags-repository';
import { SearchService } from './search/search-service';
import { TagExporter } from './tag-transfer/tag-exporter';
import { TagImporter } from './tag-transfer/tag-importer';
import type { MediaTools } from './thumbnails/media-tools';
import { locateMediaTools } from './thumbnails/media-tools';
import { Thumbnailer } from './thumbnails/thumbnailer';

const log = createLogger('library');

export interface WorkerConfig {
  readonly dataDir: string;
  /** Electron's `process.resourcesPath`, where bundled binaries live in packaged builds. */
  readonly resourcesDir: string | null;
}

/** Coalescing windows for change notifications sent to renderers. */
const FILES_CHANGED_DELAY_MS = 200;
const STATUS_DELAY_MS = 250;
/** Past this many changed ids, renderers are told to refresh everything instead. */
const MAX_CHANGED_IDS = 5_000;

/** The indexer worker's services, exposed to the renderer (`LibraryApi`) and the main process. */
export class Library {
  readonly handlers: RpcHandlers<LibraryApi> = {
    search: (request) => this.searchService.search(request),
    getFiles: (ids) => this.files.summaries(ids, this.offlineRoots()),
    getDetails: (id) => {
      const details = this.files.details(id, this.offlineRoots());
      return details && { ...details, tags: this.tags.forFile(id), copies: this.copiesOf(id) };
    },
    getSelectionTags: (ids) => this.tags.forSelection(ids),
    listTags: () => this.tags.list(),
    addTags: (fileIds, tagPaths) => {
      this.tags.addToFiles(fileIds, tagPaths);
      this.broadcast('tagsChanged', null);
      this.fingerprinter.prioritize(fileIds);
      // Tagging a file is a good time to find out it has a copy; usually no file has its size.
      this.duplicates.check(fileIds).catch((error: unknown) => {
        log.warn('Duplicate check failed:', errorMessage(error));
      });
    },
    removeTags: (fileIds, tagIds) => {
      this.tags.removeFromFiles(fileIds, tagIds);
      this.broadcast('tagsChanged', null);
    },
    findDuplicates: () => this.duplicates.checkLibrary(),
    shareTagsWithCopies: (fileId) => {
      const group = this.files.contentGroup(fileId).map((copy) => copy.id);
      if (group.length > 1) {
        this.tags.copyTags(group, group);
        this.broadcast('tagsChanged', null);
      }
    },
    listRoots: () => this.roots.list().map((root) => this.describeRoot(root)),
    addRoot: async (rootPath) => {
      const root = await this.indexer.addRoot(rootPath);
      this.broadcast('rootsChanged', null);
      return this.describeRoot(root);
    },
    removeRoot: async (id) => {
      if (this.exporter.busy) {
        // Its tags would go missing from the export being written, which would not say so.
        throw new Error('Tags are being exported: remove the folder once that is done.');
      }
      // Every window is told (`removingFolders`), whichever one started it: none offers to export
      // tags meanwhile.
      this.removals++;
      this.scheduleStatus();
      const removed = await this.indexer.removeRoot(id).finally(() => {
        this.removals--;
        // Removed or not: the status sent shortly after also counts the files left.
        this.scheduleStatus();
      });
      this.tags.pruneUnused();
      this.broadcast('rootsChanged', null);
      this.broadcast('tagsChanged', null);
      this.markChanged(null);
      await this.thumbnails.remove(removed);
    },
    getSettings: () => this.settings.get(),
    updateSettings: (patch) => this.settings.update(patch),
    getStatus: () => this.status(),
    getDiagnostics: () => this.diagnostics(),
    getLastTagExport: () => this.settings.lastTagExport(),
    planTagImport: (token) => {
      this.refuseImportWhileExporting();
      return this.importer.plan(token);
    },
    applyTagImport: (token, planId, includeChanged) => {
      this.refuseImportWhileExporting();
      return this.importer.apply(token, planId, includeChanged);
    },
    closeTagImport: () => {
      this.importer.close();
    },
  };

  readonly hostHandlers: RpcHandlers<WorkerHostApi> = {
    thumbnail: (id) => this.thumbnails.thumbnail(id),
    storeThumbnail: (id, png) => this.thumbnails.storeSystemThumbnail(id, png),
    resolvePath: (id) => this.files.pathOf(id),
    videoPath: (id) => this.files.videoPathOf(id),
    prepareTrash: async (id) => {
      const filePath = await this.trash.prepare(id);
      this.broadcast('tagsChanged', null);
      return filePath;
    },
    forgetFile: async (id, trashed) => {
      // At once, not behind the indexer's queue: the outcome is known, and a retry must not wait.
      if (await this.trash.settle(id, trashed)) {
        this.broadcast('tagsChanged', null);
      }
      await this.indexer.forget(id, trashed);
    },
    exportTags: (destination, appVersion) => {
      if (this.importer.busy) {
        throw new Error('Tags are being imported: export them once that is done.');
      }
      if (this.removals > 0) {
        throw new Error('A library folder is being removed: export the tags once that is done.');
      }
      return this.exporter.export(destination, appVersion);
    },
    openTagImport: (filePath) => {
      this.refuseImportWhileExporting();
      return this.importer.open(filePath);
    },
    shutdown: () => this.stop(),
  };

  private readonly config: WorkerConfig;
  private readonly db: Db;
  private readonly files: FilesRepository;
  private readonly tags: TagsRepository;
  private readonly roots: RootsRepository;
  private readonly settings: SettingsRepository;
  private readonly searchService: SearchService;
  private readonly indexer: Indexer;
  private readonly thumbnails: Thumbnailer;
  private readonly fingerprinter: Fingerprinter;
  private readonly duplicates: DuplicateFinder;
  private readonly trash: TrashGuard;
  private readonly exporter: TagExporter;
  private readonly importer: TagImporter;
  private readonly tools: MediaTools;
  private readonly renderers = new Set<RpcServer<LibraryApi, LibraryEvents>>();
  private readonly changedIds = new Set<number>();
  private changedAll = false;
  private filesChangedTimer: NodeJS.Timeout | undefined;
  private readonly renderedIds = new Set<number>();
  private mediaChangedTimer: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private lastOffline = '';
  /**
   * Library folders being removed, from any window (`IndexStatus.removingFolders`): no tags export
   * may start until their files are gone.
   */
  private removals = 0;

  constructor(config: WorkerConfig) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = openDatabase(path.join(config.dataDir, 'library.db'));
    this.files = new FilesRepository(this.db);
    this.tags = new TagsRepository(this.db);
    this.roots = new RootsRepository(this.db);
    this.settings = new SettingsRepository(this.db);
    this.tools = locateMediaTools(config.resourcesDir);
    this.indexer = new Indexer(this.roots, this.files, new Reconciler(this.files), {
      onChanges: (changes) => {
        this.onIndexChanges(changes);
      },
      onStateChange: () => {
        this.onIndexerStateChange();
      },
    });
    this.searchService = new SearchService(this.db, () => this.indexer.offlineRootIds);
    this.thumbnails = new Thumbnailer({
      files: this.files,
      cacheDir: path.join(config.dataDir, 'thumbnails'),
      tools: this.tools,
      isOnline: (rootId) => this.indexer.isOnline(rootId),
      offlineRootIds: () => this.indexer.offlineRootIds,
      onRendered: (id) => {
        this.markRendered(id);
      },
      onSettled: () => {
        this.scheduleStatus();
        this.fingerprinter.wake();
      },
    });
    this.fingerprinter = new Fingerprinter({
      files: this.files,
      offlineRootIds: () => this.indexer.offlineRootIds,
    });
    this.duplicates = new DuplicateFinder({
      files: this.files,
      isOnline: (rootId) => this.indexer.isOnline(rootId),
      onHashed: (ids) => {
        this.markChanged(ids);
      },
      onProgress: () => {
        this.scheduleStatus();
      },
    });
    this.trash = new TrashGuard({
      files: this.files,
      tags: this.tags,
      isOnline: (rootId) => this.indexer.isOnline(rootId),
      expectDeletion: (id) => {
        this.indexer.expectDeletion(id);
      },
    });
    this.exporter = new TagExporter({
      files: this.files,
      tags: this.tags,
      roots: this.roots,
      settings: this.settings,
      exportsDir: path.join(config.dataDir, 'exports'),
      isOnline: (rootId) => this.indexer.isOnline(rootId),
      onProgress: () => {
        this.scheduleStatus();
      },
    });
    this.importer = new TagImporter({
      files: this.files,
      tags: this.tags,
      roots: this.roots,
      isOnline: (rootId) => this.indexer.isOnline(rootId),
      whenIndexed: () => this.indexer.whenIdle(),
      // `tag:` and `is:untagged` results change: renderers search again.
      onTagged: (ids) => {
        this.markChanged(ids);
      },
      onImported: (ids) => {
        this.broadcast('tagsChanged', null);
        // Library folders show how many files are tagged.
        this.broadcast('rootsChanged', null);
        this.fingerprinter.prioritize(ids);
        // No duplicate check, unlike addTags: an import can tag thousands of files at once, and
        // checking them would read whole files. Find duplicates stays available.
      },
      onProgress: () => {
        this.scheduleStatus();
      },
    });
    if (this.tools.ffmpeg === null) {
      log.warn('ffmpeg not found: video thumbnails fall back to the OS thumbnailer, if any.');
    }
  }

  async start(): Promise<void> {
    await this.indexer.start();
    this.exporter.cleanUp().catch((error: unknown) => {
      log.warn('Cannot clean up tags exports:', errorMessage(error));
    });
    this.thumbnails.startBackground();
    this.fingerprinter.startBackground();
  }

  async stop(): Promise<void> {
    this.importer.close();
    // Before the database closes: an export being written or saved is abandoned and its files
    // deleted.
    await this.exporter.stop();
    clearTimeout(this.filesChangedTimer);
    clearTimeout(this.mediaChangedTimer);
    clearTimeout(this.statusTimer);
    this.thumbnails.stop();
    this.fingerprinter.stop();
    await this.indexer.stop();
    for (const server of this.renderers) {
      server.dispose();
    }
    this.db.close();
  }

  /** Serves the library API to a renderer; returns the function that disconnects it. */
  attachRenderer(channel: Channel): () => void {
    const server = new RpcServer<LibraryApi, LibraryEvents>(channel, this.handlers);
    this.renderers.add(server);
    return () => {
      server.dispose();
      this.renderers.delete(server);
    };
  }

  private onIndexChanges(changes: ChangeSet): void {
    this.markChanged(changes.changed);
    this.markChanged(changes.deleted);
    this.thumbnails.wake();
    this.fingerprinter.prioritize(changes.changed);
    this.fingerprinter.wake(changes.changed);
    this.scheduleStatus();
    this.thumbnails.remove(changes.deleted).catch((error: unknown) => {
      log.warn('Cannot delete cached thumbnails:', errorMessage(error));
    });
  }

  private onIndexerStateChange(): void {
    const offline = this.indexer.offlineRootIds.join(',');
    if (offline !== this.lastOffline) {
      // Tiles show an "offline" badge, and roots their availability.
      this.lastOffline = offline;
      this.markChanged(null);
      this.broadcast('rootsChanged', null);
      this.fingerprinter.retryFailed();
    }
    this.scheduleStatus();
  }

  /** Records changed file ids (`null`: everything) and notifies renderers shortly after. */
  private markChanged(ids: readonly number[] | null): void {
    if (ids === null) {
      this.changedAll = true;
    } else {
      for (const id of ids) {
        this.changedIds.add(id);
      }
    }
    this.filesChangedTimer ??= setTimeout(() => {
      this.filesChangedTimer = undefined;
      const all = this.changedAll || this.changedIds.size > MAX_CHANGED_IDS;
      this.broadcast('filesChanged', { ids: all ? null : [...this.changedIds] });
      this.changedIds.clear();
      this.changedAll = false;
    }, FILES_CHANGED_DELAY_MS);
  }

  private markRendered(id: number): void {
    this.renderedIds.add(id);
    this.mediaChangedTimer ??= setTimeout(() => {
      this.mediaChangedTimer = undefined;
      this.broadcast('mediaChanged', { ids: [...this.renderedIds] });
      this.renderedIds.clear();
    }, FILES_CHANGED_DELAY_MS);
  }

  private scheduleStatus(): void {
    this.statusTimer ??= setTimeout(() => {
      this.statusTimer = undefined;
      this.broadcast('status', this.status());
    }, STATUS_DELAY_MS);
  }

  private broadcast<K extends keyof LibraryEvents>(name: K, payload: LibraryEvents[K]): void {
    for (const server of this.renderers) {
      server.emit(name, payload);
    }
  }

  private status(): IndexStatus {
    return {
      totalFiles: this.files.count(),
      scanning: this.indexer.scanning,
      pendingThumbnails: this.files.countPendingThumbnails(),
      offlineRoots: this.indexer.offlineRootIds.length,
      duplicateCheck: this.duplicates.progress,
      tagTransfer: this.exporter.progress ?? this.importer.progress,
      removingFolders: this.removals,
    };
  }

  private diagnostics(): Diagnostics {
    const sqlite = this.db.prepare<[], string>('SELECT sqlite_version()').pluck().get() ?? '?';
    return {
      ffmpeg: this.tools.ffmpeg,
      ffprobe: this.tools.ffprobe,
      sqlite,
      dataDir: this.config.dataDir,
    };
  }

  /** One tags transfer at a time. */
  private refuseImportWhileExporting(): void {
    if (this.exporter.busy) {
      throw new Error('Tags are being exported: import them once that is done.');
    }
  }

  private describeRoot(root: RootRecord): LibraryRoot {
    return { ...root, online: this.indexer.isOnline(root.id), ...this.roots.stats(root.id) };
  }

  private offlineRoots(): ReadonlySet<number> {
    return new Set(this.indexer.offlineRootIds);
  }

  private copiesOf(id: number): FileCopy[] {
    const offline = this.offlineRoots();
    return this.files.copies(id).map((copy) => ({
      id: copy.id,
      name: copy.name,
      path: copy.path,
      offline: offline.has(copy.rootId),
      tags: this.tags.forFile(copy.id),
    }));
  }
}

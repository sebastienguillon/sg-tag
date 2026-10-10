import { mapLimit } from '@shared/async';
import { createLogger } from '@shared/log';
import type { Diagnostics, IndexStatus, LibraryRoot } from '@shared/model';
import type { Channel, RpcHandlers } from '@shared/rpc';
import { errorMessage, RpcServer } from '@shared/rpc';
import type { LibraryApi, LibraryEvents, WorkerHostApi } from '@shared/worker-api';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './database/database';
import { openDatabase } from './database/database';
import { fingerprint } from './indexer/fingerprint';
import { Indexer } from './indexer/indexer';
import type { ChangeSet } from './indexer/reconciler';
import { Reconciler } from './indexer/reconciler';
import { FilesRepository } from './library/files-repository';
import type { RootRecord } from './library/roots-repository';
import { RootsRepository } from './library/roots-repository';
import { SettingsRepository } from './library/settings-repository';
import { TagsRepository } from './library/tags-repository';
import { SearchService } from './search/search-service';
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
      return details && { ...details, tags: this.tags.forFile(id) };
    },
    getSelectionTags: (ids) => this.tags.forSelection(ids),
    listTags: () => this.tags.list(),
    addTags: (fileIds, tagPaths) => {
      this.tags.addToFiles(fileIds, tagPaths);
      this.broadcast('tagsChanged', null);
      this.fingerprintTagged(fileIds);
    },
    removeTags: (fileIds, tagIds) => {
      this.tags.removeFromFiles(fileIds, tagIds);
      this.broadcast('tagsChanged', null);
    },
    listRoots: () => this.roots.list().map((root) => this.describeRoot(root)),
    addRoot: async (rootPath) => {
      const root = await this.indexer.addRoot(rootPath);
      this.broadcast('rootsChanged', null);
      return this.describeRoot(root);
    },
    removeRoot: async (id) => {
      const removed = await this.indexer.removeRoot(id);
      this.tags.pruneUnused();
      this.broadcast('rootsChanged', null);
      this.broadcast('tagsChanged', null);
      this.markChanged(null);
      this.scheduleStatus();
      await this.thumbnails.remove(removed);
    },
    getSettings: () => this.settings.get(),
    updateSettings: (patch) => this.settings.update(patch),
    getStatus: () => this.status(),
    getDiagnostics: () => this.diagnostics(),
  };

  readonly hostHandlers: RpcHandlers<WorkerHostApi> = {
    thumbnail: (id) => this.thumbnails.thumbnail(id),
    storeThumbnail: (id, png) => this.thumbnails.storeSystemThumbnail(id, png),
    resolvePath: (id) => this.files.pathOf(id),
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
  private readonly tools: MediaTools;
  private readonly renderers = new Set<RpcServer<LibraryApi, LibraryEvents>>();
  private readonly changedIds = new Set<number>();
  private changedAll = false;
  private filesChangedTimer: NodeJS.Timeout | undefined;
  private readonly renderedIds = new Set<number>();
  private mediaChangedTimer: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private lastOffline = '';

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
        this.scheduleStatus();
      },
    });
    if (this.tools.ffmpeg === null) {
      log.warn('ffmpeg not found: video thumbnails fall back to the OS thumbnailer, if any.');
    }
  }

  async start(): Promise<void> {
    await this.indexer.start();
    this.thumbnails.startBackground();
  }

  async stop(): Promise<void> {
    clearTimeout(this.filesChangedTimer);
    clearTimeout(this.mediaChangedTimer);
    clearTimeout(this.statusTimer);
    this.thumbnails.stop();
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
    this.fingerprintTagged(changes.changed);
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

  private describeRoot(root: RootRecord): LibraryRoot {
    return { ...root, online: this.indexer.isOnline(root.id), ...this.roots.stats(root.id) };
  }

  private offlineRoots(): ReadonlySet<number> {
    return new Set(this.indexer.offlineRootIds);
  }

  /** Tagged files get a content fingerprint so they can be recognised after a cross-volume move. */
  private fingerprintTagged(ids: readonly number[]): void {
    if (ids.length === 0) {
      return;
    }
    const targets = this.files.needingFingerprint(ids);
    void mapLimit(targets, 4, async (target) => {
      try {
        this.files.setFingerprint(target.id, await fingerprint(target.path, target.size));
      } catch {
        // Unreadable right now; retried the next time the file changes or is tagged.
      }
    });
  }
}

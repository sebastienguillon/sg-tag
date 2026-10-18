import { mapLimit } from '@shared/async';
import { createLogger } from '@shared/log';
import type { FileKind } from '@shared/model';
import { errorMessage } from '@shared/rpc';
import type { ThumbnailSource } from '@shared/worker-api';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FilesRepository, MediaInfo, ThumbInfo } from '../library/files-repository';
import { ThumbState } from '../library/files-repository';
import { formatOf } from '../library/formats';
import type { MediaTools } from './media-tools';
import { encodeThumbnail, renderImage, renderVideo, renderWithFfmpeg } from './renderers';
import { WorkPool } from './work-pool';

const log = createLogger('thumbnails');

const NONE: ThumbnailSource = { kind: 'none' };
const BACKGROUND_BATCH = 32;

interface Job {
  readonly info: ThumbInfo;
  readonly resolve: (source: ThumbnailSource) => void;
}

export interface ThumbnailerOptions {
  readonly files: FilesRepository;
  readonly cacheDir: string;
  readonly tools: MediaTools;
  readonly isOnline: (rootId: number) => boolean;
  readonly offlineRootIds: () => readonly number[];
  /** A thumbnail, and the media metadata read along the way, was stored for this file. */
  readonly onRendered: (id: number) => void;
  /** This file no longer waits for a thumbnail: rendered, left to the OS thumbnailer, or failed. */
  readonly onSettled: (id: number) => void;
}

/**
 * Renders and caches thumbnails as WebP files under `cacheDir/<shard>/<id>.webp`.
 *
 * Tiles on screen request thumbnails on demand (urgent, LIFO); when idle, the remaining files are
 * rendered newest first in the background. Images and videos use separate pools so slow video
 * decoding never holds up photos.
 */
export class Thumbnailer {
  private readonly options: ThumbnailerOptions;
  private readonly inflight = new Map<number, Promise<ThumbnailSource>>();
  private readonly pools: Readonly<Record<FileKind, WorkPool<Job>>>;
  private backgroundEnabled = false;

  constructor(options: ThumbnailerOptions) {
    this.options = options;
    const cores = os.availableParallelism();
    this.pools = {
      image: new WorkPool<Job>({
        concurrency: clamp(Math.floor(cores / 2), 2, 6),
        reserved: 1,
        run: (job) => this.render(job),
        refill: () => this.refill('image'),
      }),
      video: new WorkPool<Job>({
        concurrency: clamp(Math.floor(cores / 4), 2, 3),
        reserved: 1,
        run: (job) => this.render(job),
        refill: () => this.refill('video'),
      }),
    };
  }

  pathFor(id: number): string {
    const shard = (id % 256).toString(16).padStart(2, '0');
    return path.join(this.options.cacheDir, shard, `${id}.webp`);
  }

  /** Thumbnail for a tile on screen: from the cache, or rendered ahead of background work. */
  async thumbnail(id: number): Promise<ThumbnailSource> {
    const pending = this.inflight.get(id);
    if (pending) {
      for (const pool of Object.values(this.pools)) {
        pool.promote((job) => job.info.id === id);
      }
      return pending;
    }
    const info = this.options.files.thumbInfo(id);
    if (!info) {
      return NONE;
    }
    const cached = this.cached(info);
    if (cached) {
      return cached;
    }
    if (info.missing || !this.options.isOnline(info.rootId)) {
      return NONE;
    }
    return this.schedule(info);
  }

  /** Stores a thumbnail rendered by the OS thumbnailer, or records that there is none. */
  async storeSystemThumbnail(id: number, png: Uint8Array | null): Promise<string | null> {
    if (png === null || png.length === 0) {
      this.options.files.setThumb(id, ThumbState.failed);
      return null;
    }
    const target = this.pathFor(id);
    await mkdir(path.dirname(target), { recursive: true });
    await encodeThumbnail(png, target);
    this.options.files.setThumb(id, ThumbState.ready);
    return target;
  }

  /** Deletes cached thumbnails of files removed from the index. */
  async remove(ids: readonly number[]): Promise<void> {
    await mapLimit(ids, 16, (id) => rm(this.pathFor(id), { force: true }));
  }

  startBackground(): void {
    this.backgroundEnabled = true;
    this.wake();
  }

  /** New or changed files may need thumbnails. */
  wake(): void {
    if (this.backgroundEnabled) {
      this.pools.image.kick();
      this.pools.video.kick();
    }
  }

  stop(): void {
    this.backgroundEnabled = false;
  }

  private cached(info: ThumbInfo): ThumbnailSource | null {
    switch (info.thumbState) {
      case ThumbState.ready: {
        const file = this.pathFor(info.id);
        // A cleared cache folder just means rendering again.
        return existsSync(file) ? { kind: 'file', path: file } : null;
      }
      case ThumbState.failed:
        return NONE;
      case ThumbState.system:
        return info.missing || !this.options.isOnline(info.rootId)
          ? NONE
          : { kind: 'system', sourcePath: info.path };
      case ThumbState.pending:
        return null;
    }
  }

  private schedule(info: ThumbInfo): Promise<ThumbnailSource> {
    const { promise, resolve } = Promise.withResolvers<ThumbnailSource>();
    this.track(info.id, promise);
    this.pools[info.kind].pushUrgent({ info, resolve });
    return promise;
  }

  private refill(kind: FileKind): Job[] {
    if (!this.backgroundEnabled) {
      return [];
    }
    const ids = this.options.files.pendingThumbnails(
      kind,
      this.options.offlineRootIds(),
      this.inflight.keys(),
      BACKGROUND_BATCH,
    );
    const jobs: Job[] = [];
    for (const id of ids) {
      const info = this.options.files.thumbInfo(id);
      if (info) {
        const { promise, resolve } = Promise.withResolvers<ThumbnailSource>();
        this.track(id, promise);
        jobs.push({ info, resolve });
      }
    }
    return jobs;
  }

  private track(id: number, promise: Promise<ThumbnailSource>): void {
    this.inflight.set(id, promise);
    void promise.finally(() => this.inflight.delete(id));
  }

  private async render({ info, resolve }: Job): Promise<void> {
    try {
      resolve(await this.generate(info));
    } catch (error) {
      log.warn(`Cannot render ${info.path}: ${errorMessage(error)}`);
      this.options.files.setThumb(info.id, ThumbState.failed);
      this.options.onSettled(info.id);
      resolve(NONE);
    }
  }

  private async generate(queued: ThumbInfo): Promise<ThumbnailSource> {
    // The file may have changed, vanished or been rendered while it waited in the queue.
    const info = this.options.files.thumbInfo(queued.id);
    if (!info) {
      return NONE;
    }
    if (info.thumbState !== ThumbState.pending) {
      return this.cached(info) ?? NONE;
    }
    const target = this.pathFor(info.id);
    await mkdir(path.dirname(target), { recursive: true });
    for (const decoder of formatOf(info.ext)?.decoders ?? []) {
      if (decoder === 'system') {
        this.options.files.setThumb(info.id, ThumbState.system);
        this.options.onSettled(info.id);
        return { kind: 'system', sourcePath: info.path };
      }
      const media = await this.decode(decoder, info, target).catch((error: unknown) => {
        log.warn(`${decoder} cannot render ${info.path}: ${errorMessage(error)}`);
        return null;
      });
      if (media) {
        this.options.files.setThumb(info.id, ThumbState.ready, media);
        this.options.onRendered(info.id);
        this.options.onSettled(info.id);
        return { kind: 'file', path: target };
      }
    }
    this.options.files.setThumb(info.id, ThumbState.failed);
    this.options.onSettled(info.id);
    return NONE;
  }

  /** Resolves to `null` when the decoder is not installed. */
  private async decode(
    decoder: 'sharp' | 'ffmpeg',
    info: ThumbInfo,
    target: string,
  ): Promise<MediaInfo | null> {
    if (decoder === 'sharp') {
      return renderImage(info.path, target);
    }
    const { ffmpeg, ffprobe } = this.options.tools;
    if (ffmpeg === null) {
      return null;
    }
    return info.kind === 'video'
      ? renderVideo(ffmpeg, ffprobe, info.path, target)
      : renderWithFfmpeg(ffmpeg, info.path, target);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

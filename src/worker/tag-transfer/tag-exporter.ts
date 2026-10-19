import { mapLimit } from '@shared/async';
import { createLogger } from '@shared/log';
import type { TagExportResult, TagTransferProgress } from '@shared/model';
import { errorMessage } from '@shared/rpc';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import type {
  FilesRepository,
  FingerprintTarget,
  TaggedFileRow,
} from '../library/files-repository';
import type { RootRecord, RootsRepository } from '../library/roots-repository';
import type { SettingsRepository } from '../library/settings-repository';
import type { TagsRepository } from '../library/tags-repository';
import { tagKey } from '../library/tags-repository';
import { yieldNow } from './slices';
import {
  endLine,
  entryLine,
  exportedTags,
  headerLine,
  MAX_TAG_FILE_BYTES,
  readsHeader,
} from './tag-file';

const log = createLogger('tag-transfer');

/** Tagged files per page: one query for their tags and one write each. */
const PAGE_SIZE = 1_000;
const READ_CONCURRENCY = 4;

const TOO_LARGE = 'This library has more tagged files than one tags export can hold.';
const TOO_MANY_FOLDERS = 'This library has more library folders than one tags export can list.';

export interface TagExporterOptions {
  readonly files: FilesRepository;
  readonly tags: TagsRepository;
  readonly roots: RootsRepository;
  readonly settings: SettingsRepository;
  /** `<data folder>/exports`: where each export is written whole before it is saved. */
  readonly exportsDir: string;
  readonly isOnline: (rootId: number) => boolean;
  /** `progress` changed. */
  readonly onProgress: () => void;
  /** Reads a fingerprint; tests inject a counting fake. */
  readonly fingerprint?: (target: FingerprintTarget) => Promise<string>;
  /**
   * Largest export saved: the largest an import reads, `MAX_TAG_FILE_BYTES`; tests make it small.
   */
  readonly maxBytes?: number;
}

/** What to say about a failed write, by error code. */
interface Reasons {
  /** `EACCES`, `EPERM`. */
  readonly denied: string;
  /** `ENOSPC`. */
  readonly full: string;
  /** `EROFS`. */
  readonly readOnly: string;
  readonly other: string;
}

/** Why writing the export in the data folder failed, by error code. */
const NOT_WRITTEN: Reasons = {
  denied: 'SG Tag is not allowed to write in its data folder',
  full: 'the disk of SG Tag’s data folder is full',
  readOnly: 'the disk of SG Tag’s data folder is read-only',
  other: 'an error occurred while writing it',
};

/** Why saving the export where the user chose failed, by error code. */
const NOT_SAVED: Reasons = {
  denied: 'SG Tag is not allowed to write there',
  full: 'the disk is full',
  readOnly: 'that disk is read-only',
  other: 'the file could not be written',
};

/** What a tags export holds. */
interface Written {
  readonly files: number;
  readonly missing: number;
  /**
   * Distinct tags not written for at least one file: a tags export does not hold them
   * (`exportedTags`).
   */
  readonly leftOut: number;
  /** Fingerprints read on the way. */
  readonly read: number;
  /** Size of the file; past `maxBytes`, writing stopped there. */
  readonly bytes: number;
}

/** The export running, for `stop`. */
interface Running {
  readonly controller: AbortController;
  /** Settles once the export is over and its files are removed. */
  readonly settled: Promise<void>;
}

/**
 * Exports the tags of every tagged file, missing and offline ones included, to the file the user
 * chose. The whole export is written in the data folder first, so the chosen file is only opened
 * once there is something complete to put in it, and is deleted rather than left cut short if
 * saving fails or is stopped. One export runs at a time.
 *
 * Only the tags an import keeps are written (`exportedTags`), so it reads every line whole: the
 * others (far too long, too deep, with a long run of combining marks, or too many for one file)
 * are left out and counted. Every library folder is listed, whatever its path. An export its
 * import would refuse whole, larger than it reads (`MAX_TAG_FILE_BYTES`) or with a header longer
 * than it reads (`readsHeader`: thousands of library folders, or tens at the longest paths), is
 * refused rather than saved.
 *
 * The indexer's queue is not held: each line stands on its own and ids survive moves, so the
 * export is as of a moment, and a file tagged meanwhile may or may not be in it.
 */
export class TagExporter {
  private readonly options: TagExporterOptions;
  private readonly read: (target: FingerprintTarget) => Promise<string>;
  private readonly maxBytes: number;
  private current: TagTransferProgress | null = null;
  /** The export being written, which `cleanUp` leaves alone. */
  private file: string | null = null;
  private running: Running | null = null;

  constructor(options: TagExporterOptions) {
    this.options = options;
    this.read = options.fingerprint ?? ((target) => fingerprint(target.path, target.size));
    this.maxBytes = options.maxBytes ?? MAX_TAG_FILE_BYTES;
  }

  /** Progress of the export, `null` when none is running. */
  get progress(): TagTransferProgress | null {
    return this.current;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Deletes exports left by an earlier run that stopped before saving them. */
  async cleanUp(): Promise<void> {
    const { exportsDir } = this.options;
    let names: string[];
    try {
      names = await readdir(exportsDir);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        return;
      }
      throw error;
    }
    const leftovers = names
      .map((name) => path.join(exportsDir, name))
      .filter((file) => file !== this.file);
    await Promise.all(leftovers.map((file) => rm(file, { force: true })));
  }

  /**
   * Writes every tagged file and its tags to `destination`, and records it as the latest export; a
   * file is left out with its tags when a tags export holds none of them. Throws, saying why, when
   * it cannot, or when its import would refuse it: a file already at `destination` is only lost
   * when saving fails, or is stopped, after it was opened.
   */
  async export(destination: string, appVersion: string): Promise<TagExportResult> {
    if (this.current !== null) {
      throw new Error('A tags export is already being written.');
    }
    const total = this.options.tags.taggedFileCount();
    if (total === 0) {
      throw new Error('Nothing to export yet: no file is tagged.');
    }
    const controller = new AbortController();
    const exporting = this.run(destination, appVersion, total, controller.signal);
    this.running = {
      controller,
      settled: exporting.then(
        () => undefined,
        () => undefined,
      ),
    };
    return exporting;
  }

  /**
   * Stops the running export: it throws, and neither its file in the data folder nor the file it
   * was saving to is left (a file already at the destination that it did not open yet is kept).
   * Resolves once that is done, at once when no export runs.
   */
  async stop(): Promise<void> {
    if (this.running !== null) {
      this.running.controller.abort(new Error('The tags export was stopped.'));
      await this.running.settled;
    }
  }

  private async run(
    destination: string,
    appVersion: string,
    total: number,
    signal: AbortSignal,
  ): Promise<TagExportResult> {
    const file = path.join(this.options.exportsDir, `${randomUUID()}.jsonl`);
    this.file = file;
    this.report({ step: 'exporting', done: 0, total });
    try {
      const { files, missing, leftOut } = await this.write(file, appVersion, total, signal);
      const tags = this.options.tags.count();
      await this.save(file, destination, signal);
      this.options.settings.recordTagExport({ at: Date.now(), path: destination, files });
      return { path: destination, files, missing, tags, leftOut };
    } finally {
      await rm(file, { force: true }).catch((error: unknown) => {
        log.warn(`Cannot delete ${file}:`, errorMessage(error));
      });
      this.file = null;
      this.running = null;
      this.report(null);
    }
  }

  /**
   * Writes the whole export to `file`, a new file in the data folder; throws, saying why in words
   * fit to show, when it cannot, or when its import would refuse it: it is not saved then.
   */
  private async write(
    file: string,
    appVersion: string,
    total: number,
    signal: AbortSignal,
  ): Promise<Written> {
    const roots = this.options.roots.list();
    const header = headerLine({
      app: appVersion,
      exportedAt: new Date().toISOString(),
      platform: process.platform,
      fingerprint: FINGERPRINT_SCHEME,
      roots: roots.map((root) => root.path),
    });
    // Saved, it would be refused whole on import.
    if (!readsHeader(header)) {
      log.warn(
        `Not exporting: an import would refuse the header listing ${roots.length} library ` +
          `folders, of ${Buffer.byteLength(header)} bytes`,
      );
      throw new Error(TOO_MANY_FOLDERS);
    }
    const started = performance.now();
    let written: Written;
    try {
      await mkdir(this.options.exportsDir, { recursive: true });
      const handle = await open(file, 'wx');
      written = await writeAndClose(handle, () =>
        this.writeLines(handle, header, roots, total, signal),
      );
    } catch (error) {
      if (signal.aborted && error === signal.reason) {
        throw error;
      }
      log.warn(`Cannot write the tags export in ${this.options.exportsDir}:`, errorMessage(error));
      throw new Error(`The tags export could not be written: ${why(error, NOT_WRITTEN)}.`, {
        cause: error,
      });
    }
    // Saved, it would be refused whole on import.
    if (written.bytes > this.maxBytes) {
      log.warn(
        `Not saving the tags export: past ${this.maxBytes} bytes with ${written.files} ` +
          'tagged files written, an import would refuse it',
      );
      throw new Error(TOO_LARGE);
    }
    log.info(
      `Exported ${written.files} tagged files in ${Math.round(performance.now() - started)} ms ` +
        `(${written.read} fingerprints read)`,
    );
    if (written.leftOut > 0) {
      log.warn(
        `Left out ${written.leftOut} tags a tags export cannot hold (too long, too deep, ` +
          'with a long run of combining marks, or too many on one file)',
      );
    }
    return written;
  }

  /**
   * Writes the lines of the export, `header` listing `roots` first, and stops once past
   * `maxBytes`: such an export is refused.
   */
  private async writeLines(
    handle: FileHandle,
    header: string,
    roots: readonly RootRecord[],
    total: number,
    signal: AbortSignal,
  ): Promise<Written> {
    const { files, tags } = this.options;
    const rootIndex = new Map(roots.map((root, index) => [root.id, index]));
    let bytes = await writeText(handle, header);
    let count = 0;
    let missing = 0;
    // `tagKey` of the tags left out of a file, each once.
    const leftOut = new Set<string>();
    let read = 0;
    // Keyset by id: a file renamed or moved meanwhile keeps its place, so it is written once.
    let page = files.taggedPage(0, PAGE_SIZE);
    while (page.length > 0 && bytes <= this.maxBytes) {
      const prints = await this.readFingerprints(page, signal);
      signal.throwIfAborted();
      read += prints.size;
      const tagsByFile = tags.pathsForFiles(page.map((row) => row.id));
      let text = '';
      for (const row of page) {
        const index = rootIndex.get(row.rootId);
        // A library folder added meanwhile is not in the header.
        if (index === undefined) {
          continue;
        }
        const paths = tagsByFile.get(row.id) ?? [];
        const held = exportedTags(paths);
        if (held.length < paths.length) {
          const kept = new Set(held);
          for (const tag of paths) {
            if (!kept.has(tag)) {
              leftOut.add(tagKey(tag));
            }
          }
        }
        // A file may have lost its tags meanwhile, or have none a tags export holds.
        if (held.length > 0) {
          const print = row.fingerprint ?? prints.get(row.id) ?? null;
          text += entryLine({ ...row, fingerprint: print }, index, held);
          count++;
          if (row.missing) {
            missing++;
          }
        }
      }
      bytes += await writeText(handle, text);
      this.report({ step: 'exporting', done: Math.min(count, total), total });
      await yieldNow();
      signal.throwIfAborted();
      page = files.taggedPage((page.at(-1) as TaggedFileRow).id, PAGE_SIZE);
    }
    bytes += await writeText(handle, endLine(count));
    return { files: count, missing, leftOut: leftOut.size, read, bytes };
  }

  /**
   * Reads and stores the fingerprints that files of `page` on connected drives lack: files are
   * best recognised by their content when the export is imported. Unreadable files go without, and
   * so do those left once `signal` is aborted.
   */
  private async readFingerprints(
    page: readonly TaggedFileRow[],
    signal: AbortSignal,
  ): Promise<Map<number, string>> {
    const { files, isOnline } = this.options;
    const online = page.filter((row) => isOnline(row.rootId)).map((row) => row.id);
    const prints = new Map<number, string>();
    await mapLimit(files.needingFingerprint(online), READ_CONCURRENCY, async (target) => {
      if (signal.aborted) {
        return;
      }
      const print = await this.read(target).catch(() => null);
      if (print !== null) {
        files.setFingerprint(target, print);
        prints.set(target.id, print);
      }
    });
    return prints;
  }

  /** Copies `file` to `destination`; throws, saying why in words fit to show, when it cannot. */
  private async save(file: string, destination: string, signal: AbortSignal): Promise<void> {
    // Stopped before the save: the destination is not even opened.
    signal.throwIfAborted();
    try {
      await saveFile(file, destination, signal);
    } catch (error) {
      if (signal.aborted && error === signal.reason) {
        throw error;
      }
      log.warn(`Cannot save the tags export to ${destination}:`, errorMessage(error));
      throw new Error(`The tags export could not be saved: ${why(error, NOT_SAVED)}.`, {
        cause: error,
      });
    }
  }

  private report(progress: TagTransferProgress | null): void {
    this.current = progress;
    this.options.onProgress();
  }
}

/**
 * Copies `source` to `destination`. Opening it empties a file already there, so from then on a
 * failure deletes it rather than leave it cut short, and so does `signal` being aborted: an export
 * that is stopped is not reported saved, so nothing of it is left.
 */
async function saveFile(source: string, destination: string, signal: AbortSignal): Promise<void> {
  const target = await open(destination, 'w');
  try {
    await writeAndClose(target, async () => {
      for await (const chunk of createReadStream(source)) {
        signal.throwIfAborted();
        await writeFully(target, chunk as Buffer);
      }
    });
    signal.throwIfAborted();
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Writes `text` at the position of `handle`; resolves to the bytes it took. */
async function writeText(handle: FileHandle, text: string): Promise<number> {
  const data = Buffer.from(text);
  await writeFully(handle, data);
  return data.length;
}

/**
 * Writes all of `data` at the position of `handle`. A write may take only part of it (a disk
 * filling up) without an error: the rest is written again, and that write says why it cannot.
 */
async function writeFully(handle: FileHandle, data: Uint8Array): Promise<void> {
  for (let offset = 0; offset < data.length;) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) {
      throw new Error('Nothing more could be written.');
    }
    offset += bytesWritten;
  }
}

/** Runs `write`, then flushes `handle` to disk and closes it; closes it too when anything fails. */
async function writeAndClose<T>(handle: FileHandle, write: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await write();
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return result;
}

/** Why writing failed, among `reasons`, by its error code. */
function why(error: unknown, reasons: Reasons): string {
  switch (codeOf(error)) {
    case 'EACCES':
    case 'EPERM':
      return reasons.denied;
    case 'ENOSPC':
      return reasons.full;
    case 'EROFS':
      return reasons.readOnly;
    default:
      return reasons.other;
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

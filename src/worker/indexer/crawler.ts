import { mapLimit } from '@shared/async';
import { fdir } from 'fdir';
import { stat } from 'node:fs/promises';
import { isIgnoredDirectory, isIndexable } from '../library/paths';

/** A media file as found on disk. */
export interface DiskFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number | null;
  /** `<device>:<inode>`: stable across renames and moves within one volume. */
  readonly fileId: string;
}

const STAT_CONCURRENCY = 64;

/** Lists indexable files below `dir`. Unreadable folders are skipped silently. */
export function crawl(dir: string): Promise<string[]> {
  return new fdir()
    .withFullPaths()
    .exclude((name) => isIgnoredDirectory(name))
    .filter((filePath, isDir) => !isDir && isIndexable(filePath))
    .crawl(dir)
    .withPromise();
}

export async function statFile(filePath: string): Promise<DiskFile | null> {
  try {
    // BigInt stats: Windows file ids do not fit in a double.
    const stats = await stat(filePath, { bigint: true });
    if (!stats.isFile()) {
      return null;
    }
    return {
      path: filePath,
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      birthtimeMs: stats.birthtimeMs > 0n ? Number(stats.birthtimeMs) : null,
      fileId: `${String(stats.dev)}:${String(stats.ino)}`,
    };
  } catch {
    return null;
  }
}

export async function statFiles(paths: readonly string[]): Promise<DiskFile[]> {
  const files = await mapLimit(paths, STAT_CONCURRENCY, statFile);
  return files.filter((file) => file !== null);
}

export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

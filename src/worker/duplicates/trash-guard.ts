import { createLimiter } from '@shared/async';
import type { DiskFile } from '../indexer/crawler';
import { inodeOf, statFile } from '../indexer/crawler';
import type { ContentCandidate, FilesRepository } from '../library/files-repository';
import type { TagsRepository } from '../library/tags-repository';

const TRASH = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';

export interface TrashGuardOptions {
  readonly files: FilesRepository;
  readonly tags: TagsRepository;
  readonly isOnline: (rootId: number) => boolean;
  /** The app is about to delete this file: when it vanishes, it is gone, not moved. */
  readonly expectDeletion: (id: number) => void;
}

/** A file handed out for the Trash. */
interface Pending {
  readonly path: string;
  /** What was on disk at `path` when it was checked. */
  readonly fileId: string;
  /** The tags each copy (by id) was given for it. */
  readonly given: ReadonlyMap<number, readonly number[]>;
}

/**
 * Lets a duplicate go to the Trash, the one change SG Tag makes on disk, only when neither content
 * nor tags are lost: an identical copy stays on disk, unchanged since the two were compared, and is
 * given the duplicate's tags first.
 *
 * Requests are checked one at a time, and a file handed out for the Trash no longer counts as a copy
 * that stays until it is settled: trashing two copies at once cannot leave none.
 */
export class TrashGuard {
  private readonly options: TrashGuardOptions;
  private readonly serial = createLimiter(1);
  private readonly pending = new Map<number, Pending>();

  constructor(options: TrashGuardOptions) {
    this.options = options;
  }

  /**
   * Checks that `id` may go to the Trash, gives its tags to the copies that stay, and returns its
   * path. Throws, saying why, when it must stay. Call `settle` once trashing was tried.
   */
  prepare(id: number): Promise<string> {
    return this.serial(async () => {
      const { files, tags } = this.options;
      if (this.pending.has(id)) {
        throw new Error(`This file is already being moved to the ${TRASH}.`);
      }
      const group = files.contentGroup(id);
      const file = group.find((candidate) => candidate.id === id);
      const disk = file && (await this.unchangedOnDisk(file));
      if (!file || !disk) {
        throw new Error('This file changed since it was compared. Look for duplicates again.');
      }
      const kept: number[] = [];
      let leaving = false;
      let offline = 0;
      for (const copy of group) {
        if (copy.id === id) {
          continue;
        }
        if (this.pending.has(copy.id)) {
          leaving = true;
          continue;
        }
        if (!this.options.isOnline(copy.rootId)) {
          offline++;
          continue;
        }
        const copyDisk = await this.unchangedOnDisk(copy);
        // The same file through a hard or symbolic link would go with it.
        if (copyDisk && copyDisk.fileId !== disk.fileId) {
          kept.push(copy.id);
        }
      }
      if (kept.length === 0) {
        throw new Error(`${whyNoCopy(leaving, offline)}, so this one was kept.`);
      }
      const own = tags.forFile(id).map((tag) => tag.id);
      const given = new Map(
        kept.map((copyId) => {
          const has = new Set(tags.forFile(copyId).map((tag) => tag.id));
          return [copyId, own.filter((tagId) => !has.has(tagId))] as const;
        }),
      );
      tags.copyTags([id], kept);
      this.pending.set(id, { path: file.path, fileId: disk.fileId, given });
      this.options.expectDeletion(id);
      return file.path;
    });
  }

  /**
   * Trashing `id` was tried. If it failed and the file is still on disk, takes back the tags its
   * copies were given for it; in any doubt they keep them (extra tags on a copy lose nothing).
   * Returns whether tags changed.
   */
  async settle(id: number, trashed: boolean): Promise<boolean> {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || trashed) {
      return false;
    }
    const disk = await statFile(pending.path);
    if (disk?.fileId !== pending.fileId) {
      return false;
    }
    let changed = false;
    for (const [copyId, tagIds] of pending.given) {
      if (tagIds.length > 0) {
        this.options.tags.removeFromFiles([copyId], tagIds);
        changed = true;
      }
    }
    return changed;
  }

  /** What is on disk at `file`'s path, if it is still the file whose content was compared. */
  private async unchangedOnDisk(file: ContentCandidate): Promise<DiskFile | null> {
    if (!this.options.isOnline(file.rootId)) {
      return null;
    }
    const disk = await statFile(file.path);
    const unchanged =
      disk !== null &&
      disk.size === file.size &&
      disk.mtimeMs === file.mtimeMs &&
      (file.fileId === null || inodeOf(disk.fileId) === inodeOf(file.fileId));
    return unchanged ? disk : null;
  }
}

function whyNoCopy(leaving: boolean, offline: number): string {
  if (leaving) {
    return `Its identical copy is being moved to the ${TRASH}`;
  }
  if (offline > 0) {
    return offline === 1
      ? 'Its identical copy is on a drive that is not connected'
      : 'Its identical copies are on drives that are not connected';
  }
  return 'No identical copy of this file is on disk any more';
}

import { createLogger } from '@shared/log';
import { errorMessage } from '@shared/rpc';
import type { WorkerHost } from './worker-host';

const log = createLogger('trash');

/**
 * Moves file `id` to the Trash, only once the indexer vouches for it: an identical copy stays on
 * disk and has its tags. The indexer then settles the file without being waited for: its queue may
 * be busy with a scan, and the outcome of trashing is known already.
 */
export async function trashFile(
  worker: Pick<WorkerHost, 'call'>,
  id: number,
  trashItem: (filePath: string) => Promise<void>,
): Promise<void> {
  const filePath = await worker.call('prepareTrash', id);
  let trashed = false;
  try {
    await trashItem(filePath);
    trashed = true;
  } finally {
    // Also when trashing failed: the indexer stops expecting the file to vanish, and takes back
    // the tags it gave its copies.
    worker.call('forgetFile', id, trashed).catch((error: unknown) => {
      log.warn(`Cannot settle trashed file ${String(id)}:`, errorMessage(error));
    });
  }
}

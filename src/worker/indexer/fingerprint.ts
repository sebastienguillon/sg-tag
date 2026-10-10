import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const CHUNK = 64 * 1024;

/**
 * Cheap content identity: hash of the size plus the first and last 64 KiB. Enough to recognise a
 * file that was moved to another volume (where its inode changes) without reading it whole.
 */
export async function fingerprint(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256').update(String(size));
    const head = Buffer.alloc(Math.min(CHUNK, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > CHUNK) {
      const tail = Buffer.alloc(Math.min(CHUNK, size - CHUNK));
      await handle.read(tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
    return hash.digest('hex').slice(0, 32);
  } finally {
    await handle.close();
  }
}

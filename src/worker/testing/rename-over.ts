import { rename } from 'node:fs/promises';

/** How long a rename that Windows refuses is tried again: ten times the longest refusal seen. */
const PATIENCE_MS = 2_000;
const RETRY_MS = 10;

/**
 * Renames `from` to `to`, replacing a file that the spec wrote a moment before.
 *
 * Windows refuses, with EPERM, to replace a file that anything still has open, and something
 * outside the spec, most likely its virus scanner, opens a file just written for a moment: 5 to
 * 30 ms on an idle machine, up to 190 ms on a busy one. Measured with synchronous calls only, so
 * that the spec itself could have nothing open: of 500 renames over a file just written, 17 to 38
 * were refused; none over a file written five seconds before, and none to a name that was free.
 * So the rename is tried again until Windows takes it.
 */
export async function renameOver(from: string, to: string): Promise<void> {
  const deadline = Date.now() + PATIENCE_MS;
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isRefusedForNow(error) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

/** Elsewhere than on Windows, EPERM is a refusal that waiting does not lift. */
function isRefusedForNow(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    error.code === 'EPERM'
  );
}

import { NEWER_LIBRARY_EXIT_CODE } from '@shared/worker-api';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerHost } from './worker-host';

/** The indexer processes started so far. Each ends when a test has it emit `exit`. */
const forked = vi.hoisted((): EventEmitter[] => []);

// Electron is only there inside the app. The host is given what it uses of it: processes that
// start nothing, and message channels.
vi.mock('electron', async () => {
  const events = await import('node:events');
  return {
    utilityProcess: {
      fork: () => {
        const child = Object.assign(new events.EventEmitter(), {
          postMessage: () => undefined,
          kill: () => true,
        });
        forked.push(child);
        return child;
      },
    },
    MessageChannelMain: class {
      readonly port1 = {};
      readonly port2 = {};
    },
  };
});

describe('WorkerHost', () => {
  /** Called when the indexer ended because the library was made by a newer version. */
  let onNewerLibrary: ReturnType<typeof vi.fn<() => void>>;
  let host: WorkerHost;

  /** Ends the indexer process started last, as the process itself would. */
  const exit = (code: number): void => {
    forked.at(-1)?.emit('exit', code);
  };

  beforeEach(() => {
    forked.length = 0;
    vi.useFakeTimers();
    // The host logs each exit as an error.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onNewerLibrary = vi.fn<() => void>();
    host = new WorkerHost({
      entry: 'worker.js',
      dataDir: 'data',
      resourcesDir: 'resources',
      appVersion: '0.0.0',
      onNewerLibrary,
    });
    host.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says once that the library was made by a newer version, and starts no indexer again', async () => {
    const pending = host.call('resolvePath', 1);

    exit(NEWER_LIBRARY_EXIT_CODE);

    await expect(pending).rejects.toThrow('The indexer process exited');
    expect(onNewerLibrary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(forked).toHaveLength(1);
    expect(onNewerLibrary).toHaveBeenCalledTimes(1);
    await expect(host.call('resolvePath', 1)).rejects.toThrow('The indexer is not running');
  });

  it('starts the indexer again a moment after it ends for any other reason', async () => {
    exit(1);

    // Not at once: an indexer that fails as soon as it starts would be started without a pause.
    expect(forked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(forked).toHaveLength(2);
    expect(onNewerLibrary).not.toHaveBeenCalled();
  });

  it('says nothing of an indexer that ends while the app is stopping', async () => {
    const stopping = host.stop();

    exit(NEWER_LIBRARY_EXIT_CODE);
    await stopping;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onNewerLibrary).not.toHaveBeenCalled();
    expect(forked).toHaveLength(1);
  });
});

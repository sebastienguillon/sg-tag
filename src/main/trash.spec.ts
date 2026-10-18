import { describe, expect, it, vi } from 'vitest';
import { trashFile } from './trash';
import type { WorkerHost } from './worker-host';

describe('trashFile', () => {
  const setup = (prepare: () => Promise<string>, forget: () => Promise<void>) => {
    const calls: string[] = [];
    const worker = {
      call: (method: string, ...args: unknown[]) => {
        calls.push([method, ...args].join(' '));
        return method === 'prepareTrash' ? prepare() : forget();
      },
    } as unknown as Pick<WorkerHost, 'call'>;
    const trashItem = (filePath: string): Promise<void> => {
      calls.push(`trash ${filePath}`);
      return Promise.resolve();
    };
    return { calls, worker, trashItem };
  };

  it('trashes what the indexer vouches for, then lets it settle the file without waiting', async () => {
    const { calls, worker, trashItem } = setup(
      () => Promise.resolve('/library/a.jpg'),
      // The indexer's queue is busy with a scan.
      () => new Promise<void>(() => undefined),
    );

    await trashFile(worker, 7, trashItem);

    expect(calls).toEqual(['prepareTrash 7', 'trash /library/a.jpg', 'forgetFile 7 true']);
  });

  it('lets the indexer settle a file that could not be trashed', async () => {
    const { calls, worker } = setup(
      () => Promise.resolve('/library/a.jpg'),
      () => Promise.resolve(),
    );

    await expect(
      trashFile(worker, 7, () => Promise.reject(new Error('No Trash on this volume'))),
    ).rejects.toThrow('No Trash on this volume');
    expect(calls).toEqual(['prepareTrash 7', 'forgetFile 7 false']);
  });

  it('leaves alone a file the indexer refuses', async () => {
    const { calls, worker, trashItem } = setup(
      () => Promise.reject(new Error('No identical copy')),
      () => Promise.resolve(),
    );

    await expect(trashFile(worker, 7, trashItem)).rejects.toThrow('No identical copy');
    expect(calls).toEqual(['prepareTrash 7']);
  });

  it('only logs when the indexer cannot settle the file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { worker, trashItem } = setup(
        () => Promise.resolve('/library/a.jpg'),
        () => Promise.reject(new Error('The indexer process exited')),
      );

      await trashFile(worker, 7, trashItem);
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          '[trash]',
          'Cannot settle trashed file 7:',
          'The indexer process exited',
        );
      });
    } finally {
      warn.mockRestore();
    }
  });
});

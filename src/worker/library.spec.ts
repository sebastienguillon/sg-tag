import type { IndexStatus, LibraryRoot } from '@shared/model';
import type { RpcMessage } from '@shared/rpc';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Indexer } from './indexer/indexer';
import { Library } from './library';
import type { TagExporter } from './tag-transfer/tag-exporter';

const APP = '2026.10.0-alpha.1';
const REMOVE_WHILE_EXPORTING = 'Tags are being exported: remove the folder once that is done.';
const IMPORT_WHILE_EXPORTING = 'Tags are being exported: import them once that is done.';
const EXPORT_WHILE_REMOVING =
  'A library folder is being removed: export the tags once that is done.';

/** Calls `handler`, a sync throw turned into a rejection, as the RPC server does. */
const call = (handler: () => unknown): Promise<unknown> => Promise.resolve().then(handler);

describe('Library', () => {
  let dir: string;
  let library: Library;
  let stopped: boolean;

  const file = (...segments: string[]): string => path.join(dir, ...segments);

  /** Adds the library folders `Pictures` (a.jpg, b.jpg) and `Drive` (c.jpg), every file tagged. */
  const addTaggedFolders = async (): Promise<[LibraryRoot, LibraryRoot]> => {
    const folders = { Pictures: ['a.jpg', 'b.jpg'], Drive: ['c.jpg'] };
    const roots: LibraryRoot[] = [];
    for (const [folder, names] of Object.entries(folders)) {
      await mkdir(file(folder));
      for (const name of names) {
        await writeFile(file(folder, name), name);
      }
      roots.push(await library.handlers.addRoot(file(folder)));
    }
    await vi.waitFor(async () => {
      expect(await library.handlers.getStatus()).toMatchObject({ totalFiles: 3, scanning: null });
    });
    const { ids } = await library.handlers.search({
      query: '',
      sort: { field: 'name', direction: 'asc' },
    });
    await library.handlers.addTags([...ids], ['t']);
    return [roots[0] as LibraryRoot, roots[1] as LibraryRoot];
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-library-'));
    library = new Library({ dataDir: file('data'), resourcesDir: null, appVersion: '0.0.0' });
    stopped = false;
    await library.start();
  });

  afterEach(async () => {
    if (!stopped) {
      await library.stop();
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('removes no library folder while tags are exported, and exports none being removed', async () => {
    const [, drive] = await addTaggedFolders();

    const exporting = library.hostHandlers.exportTags(file('tags.jsonl'), APP);
    await expect(call(() => library.handlers.removeRoot(drive.id))).rejects.toThrow(
      REMOVE_WHILE_EXPORTING,
    );
    // Every folder's tags are in it.
    expect((await exporting).files).toBe(3);

    const removing = library.handlers.removeRoot(drive.id);
    await expect(
      call(() => library.hostHandlers.exportTags(file('tags 2.jsonl'), APP)),
    ).rejects.toThrow(EXPORT_WHILE_REMOVING);
    await removing;
    expect((await library.hostHandlers.exportTags(file('tags 2.jsonl'), APP)).files).toBe(2);
  });

  it('tells every window of a library folder being removed, whichever one removes it', async () => {
    const [pictures, drive] = await addTaggedFolders();
    const indexer = Reflect.get(library, 'indexer') as Indexer;
    const removeRoot = indexer.removeRoot.bind(indexer);
    // Queued behind a long scan, as at startup, until the test says.
    let gate = Promise.withResolvers<undefined>();
    const removals = vi.spyOn(indexer, 'removeRoot').mockImplementation(async (id) => {
      await gate.promise;
      return removeRoot(id);
    });
    /** Opens a window; returns the statuses it is sent, and how to close it. */
    const open = (): { readonly statuses: IndexStatus[]; readonly close: () => void } => {
      const statuses: IndexStatus[] = [];
      const close = library.attachRenderer({
        send: (message: RpcMessage) => {
          if (message.t === 'evt' && message.name === 'status') {
            statuses.push(message.payload as IndexStatus);
          }
        },
        listen: () => () => undefined,
      });
      return { statuses, close };
    };

    const first = open();
    expect((await library.handlers.getStatus()).removingFolders).toBe(0);
    const removing = library.handlers.removeRoot(drive.id);
    await vi.waitFor(() => {
      expect(first.statuses.at(-1)?.removingFolders).toBe(1);
    });
    // Reloaded, or closed and opened again: the removal goes on.
    first.close();
    const second = open();
    expect((await library.handlers.getStatus()).removingFolders).toBe(1);
    await expect(
      call(() => library.hostHandlers.exportTags(file('tags.jsonl'), APP)),
    ).rejects.toThrow(EXPORT_WHILE_REMOVING);
    gate.resolve(undefined);
    await removing;
    await vi.waitFor(() => {
      expect(second.statuses.at(-1)).toMatchObject({ removingFolders: 0, totalFiles: 2 });
    });

    // A removal that fails is over too.
    gate = Promise.withResolvers<undefined>();
    removals.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('The database is busy.');
    });
    const failing = library.handlers.removeRoot(pictures.id);
    await vi.waitFor(() => {
      expect(second.statuses.at(-1)?.removingFolders).toBe(1);
    });
    gate.resolve(undefined);
    await expect(failing).rejects.toThrow('The database is busy.');
    await vi.waitFor(() => {
      expect(second.statuses.at(-1)?.removingFolders).toBe(0);
    });
  });

  it('neither previews nor imports tags while they are exported', async () => {
    await addTaggedFolders();
    await library.hostHandlers.exportTags(file('tags.jsonl'), APP);
    const source = await library.hostHandlers.openTagImport(file('tags.jsonl'));
    const preview = await library.handlers.planTagImport(source.token);

    const exporting = library.hostHandlers.exportTags(file('tags 2.jsonl'), APP);
    await expect(call(() => library.handlers.planTagImport(source.token))).rejects.toThrow(
      IMPORT_WHILE_EXPORTING,
    );
    await expect(
      call(() => library.handlers.applyTagImport(source.token, preview.planId, true)),
    ).rejects.toThrow(IMPORT_WHILE_EXPORTING);
    await exporting;

    // Still the latest preview of a tags export still open.
    expect(await library.handlers.applyTagImport(source.token, preview.planId, true)).toEqual({
      assignments: 0,
      files: 0,
      newTags: 0,
      skipped: 0,
      notFound: 0,
    });
  });

  it('tells renderers of the tags and tagged counts an import changed', async () => {
    await addTaggedFolders();
    await library.hostHandlers.exportTags(file('tags.jsonl'), APP);
    const { ids } = await library.handlers.search({
      query: '',
      sort: { field: 'name', direction: 'asc' },
    });
    const tags = await library.handlers.listTags();
    await library.handlers.removeTags(
      [...ids],
      tags.map((tag) => tag.id),
    );
    const source = await library.hostHandlers.openTagImport(file('tags.jsonl'));
    const preview = await library.handlers.planTagImport(source.token);
    const events: string[] = [];
    library.attachRenderer({
      send: (message: RpcMessage) => {
        if (message.t === 'evt') {
          events.push(message.name);
        }
      },
      listen: () => () => undefined,
    });

    expect(
      (await library.handlers.applyTagImport(source.token, preview.planId, true)).assignments,
    ).toBe(3);
    expect(events).toEqual(expect.arrayContaining(['tagsChanged', 'rootsChanged']));
  });

  it('abandons a tags export being written before it closes the database', async () => {
    await addTaggedFolders();
    const exporter = Reflect.get(library, 'exporter') as TagExporter;
    const stop = exporter.stop.bind(exporter);
    // Abandoned at once, but holding the database open as long as the test says.
    const gate = Promise.withResolvers<undefined>();
    vi.spyOn(exporter, 'stop').mockImplementation(async () => {
      await stop();
      await gate.promise;
    });

    // Its outcome handled at once, as the RPC server does: it rejects while the library stops.
    const exporting = Promise.resolve(
      library.hostHandlers.exportTags(file('tags.jsonl'), APP),
    ).catch((error: unknown) => error);
    const stopping = library.stop();
    stopped = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => library.handlers.getStatus()).not.toThrow();
    gate.resolve(undefined);
    await stopping;
    expect(() => library.handlers.getStatus()).toThrow();
    expect(await exporting).toMatchObject({ message: 'The tags export was stopped.' });
    await expect(stat(file('tags.jsonl'))).rejects.toThrow();
    // No leftover in the data folder either, if it got that far.
    expect(await readdir(file('data', 'exports')).catch(() => [])).toEqual([]);
  });
});

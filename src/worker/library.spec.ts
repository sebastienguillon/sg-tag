import type { IndexStatus, LibraryRoot, Tag } from '@shared/model';
import type { RpcMessage } from '@shared/rpc';
import { tagTerm } from '@shared/tag-names';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewerLibraryError, openDatabase } from './database/database';
import { MIGRATIONS } from './database/migrations';
import type { Indexer } from './indexer/indexer';
import { Library } from './library';
import type { TagExporter } from './tag-transfer/tag-exporter';
import { editedTag } from './testing/test-library';

const APP = '2026.10.0-alpha.1';
const REMOVE_WHILE_EXPORTING = 'Tags are being exported: remove the folder once that is done.';
const IMPORT_WHILE_EXPORTING = 'Tags are being exported: import them once that is done.';
const EXPORT_WHILE_REMOVING =
  'A library folder is being removed: export the tags once that is done.';
/**
 * What a change to the definition of tags answers while a tags export is being written or a tags
 * import applied.
 */
const BUSY = { ok: false, error: { kind: 'busy' } };
/** What importing a tags export without tag lines adds of tags it describes: nothing. */
const NOTHING_DEFINED = { created: 0, aliases: 0, links: 0, skipped: 0 };
/** What renderers are sent when the definition of a tag changed. */
const DEFINITIONS_CHANGED = ['tagsChanged', 'tagDefinitionsChanged'];

/** Calls `handler`, a sync throw turned into a rejection, as the RPC server does. */
const call = (handler: () => unknown): Promise<unknown> => Promise.resolve().then(handler);

/**
 * The answer of a handler that gives it at once, as those of tags do: between two such calls
 * nothing else runs, not even the next step of a tags export or import.
 */
function atOnce<T>(answer: T | Promise<T>): T {
  if (answer instanceof Promise) {
    throw new Error('The handler did not answer at once.');
  }
  return answer;
}

/** Makes each of `calls` in turn, at once; returns their answers by name. */
function answersOf(calls: Readonly<Record<string, () => unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(calls).map(([name, make]) => [name, make()]));
}

/** `answer` under the name of each of `calls`. */
function eachAnswering(
  calls: Readonly<Record<string, unknown>>,
  answer: unknown,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(calls).map((name) => [name, answer]));
}

describe('Library', () => {
  let dir: string;
  let library: Library;
  let stopped: boolean;

  const file = (...segments: string[]): string => path.join(dir, ...segments);

  /** The ids of every file, sorted by name. */
  const allFiles = async (): Promise<number[]> => {
    const { ids } = await library.handlers.search({
      query: '',
      sort: { field: 'name', direction: 'asc' },
    });
    return [...ids];
  };

  /** The names of the files a search finds, in alphabetical order. */
  const found = async (query: string): Promise<string[]> => {
    const { ids } = await library.handlers.search({
      query,
      sort: { field: 'name', direction: 'asc' },
    });
    const files = await library.handlers.getFiles([...ids]);
    return files.map((each) => each.name).sort();
  };

  /** The names of the tags of each file, by the name of the file. */
  const tagsByFile = async (): Promise<Record<string, string[]>> => {
    const tags: Record<string, string[]> = {};
    for (const id of await allFiles()) {
      const details = await library.handlers.getDetails(id);
      if (details) {
        tags[details.name] = details.tags.map((tag) => tag.name);
      }
    }
    return tags;
  };

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
    await library.handlers.addTags(await allFiles(), ['t']);
    return [roots[0] as LibraryRoot, roots[1] as LibraryRoot];
  };

  /** Opens a window; returns what gives, and forgets, the names of the events it was sent since. */
  const listen = (): (() => string[]) => {
    const events: string[] = [];
    library.attachRenderer({
      send: (message: RpcMessage) => {
        if (message.t === 'evt') {
          events.push(message.name);
        }
      },
      listen: () => () => undefined,
    });
    return () => events.splice(0);
  };

  /**
   * Makes the tags `Paris`, `Lutetia` and `Europe`; returns, by name, one call of each kind that
   * changes the definition of tags. Made in this order, each of them succeeds.
   */
  const definitionCalls = (): Record<string, () => unknown> => {
    const { handlers } = library;
    const paris = editedTag(atOnce(handlers.createTag('Paris')));
    const lutetia = editedTag(atOnce(handlers.createTag('Lutetia')));
    const europe = editedTag(atOnce(handlers.createTag('Europe')));
    return {
      createTag: () => handlers.createTag('France'),
      renameTag: () => handlers.renameTag(paris.id, 'Paris (France)', false),
      addTagAlias: () => handlers.addTagAlias(paris.id, 'Paname'),
      removeTagAlias: () => handlers.removeTagAlias(paris.id, 'Paname'),
      addTagParent: () => handlers.addTagParent(paris.id, 'Europe'),
      removeTagParent: () => handlers.removeTagParent(paris.id, europe.id),
      addTagChild: () => handlers.addTagChild(europe.id, 'Lyon'),
      mergeTags: () => handlers.mergeTags(lutetia.id, paris.id),
      deleteTag: () => handlers.deleteTag(paris.id),
    };
  };

  /**
   * Checks that each of `calls` answers `busy`, changing nothing and telling renderers nothing,
   * and that `files` are tagged all the same. All of it in the turn it is called in: a tags export
   * or import started in that turn is not over before its first pause.
   */
  const expectTaggingOnly = (
    calls: Readonly<Record<string, () => unknown>>,
    files: readonly number[],
  ): void => {
    const { handlers } = library;
    const tags = atOnce(handlers.listTags());
    const sent = listen();

    expect(answersOf(calls)).toEqual(eachAnswering(calls, BUSY));
    expect(atOnce(handlers.listTags())).toEqual(tags);
    expect(sent()).toEqual([]);

    expect(atOnce(handlers.addTags(files, ['Meanwhile']))).toMatchObject([{ status: 'added' }]);
    const meanwhile = atOnce(handlers.getSelectionTags(files)).filter(
      (tag) => tag.name === 'Meanwhile',
    );
    expect(meanwhile).toMatchObject([{ fileCount: files.length }]);
    // A tag that tagging made goes with its last file, as ever.
    atOnce(
      handlers.removeTags(
        files,
        meanwhile.map((tag) => tag.id),
      ),
    );
    expect(atOnce(handlers.listTags())).toEqual(tags);
    expect(sent()).toEqual(['tagsChanged', 'tagsChanged']);
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
    // A file being read when the library stopped, for its thumbnail or to compare it with another,
    // stays open a moment more, and Windows deletes no file that is open.
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
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

  it('keeps a tag made on purpose once the library folder of its last file is removed', async () => {
    const [, drive] = await addTaggedFolders();
    const { handlers } = library;
    // Sorted by name: the last one is c.jpg, the file of Drive.
    const inDrive = (await allFiles()).slice(-1);
    await handlers.createTag('Kept');
    await handlers.addTags(inDrive, ['Kept', 'Drive only']);

    await handlers.removeRoot(drive.id);

    const tags = await handlers.listTags();
    expect(tags.map((tag) => [tag.name, tag.fileCount])).toEqual([
      ['Kept', 0],
      ['t', 2],
    ]);
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
      definitions: NOTHING_DEFINED,
    });
  });

  it('tells renderers of the tags and tagged counts an import changed', async () => {
    await addTaggedFolders();
    await library.hostHandlers.exportTags(file('tags.jsonl'), APP);
    const tags = await library.handlers.listTags();
    await library.handlers.removeTags(
      await allFiles(),
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

  it('answers what became of each name given to tag files', async () => {
    await addTaggedFolders();
    const files = await allFiles();
    const sent = listen();

    expect(await library.handlers.addTags(files, ['T', 'Paris', 'Paris, France'])).toMatchObject([
      { name: 'T', status: 'present', tag: { name: 't' } },
      { name: 'Paris', status: 'added', tag: { name: 'Paris' } },
      { name: 'Paris, France', status: 'refused', problem: 'comma' },
    ]);
    expect(sent()).toEqual(['tagsChanged']);
  });

  it('leaves no tag behind when none of the files to tag exists any more', async () => {
    await addTaggedFolders();
    const { handlers } = library;
    await handlers.createTag('Made on purpose');
    const tags = await handlers.listTags();
    const sent = listen();

    // The id of no file, as that of a file forgotten a moment before; then no file at all.
    expect(await handlers.addTags([987_654_321], ['Ghost', 'T'])).toMatchObject([
      { name: 'Ghost', status: 'present' },
      { name: 'T', status: 'present', tag: { name: 't' } },
    ]);
    expect(await handlers.addTags([], ['Nobody'])).toMatchObject([{ status: 'present' }]);

    expect(await handlers.listTags()).toEqual(tags);
    expect(sent()).toEqual(['tagsChanged', 'tagsChanged']);
  });

  it('says what a tag stands for, and nothing of a tag that is gone', async () => {
    const { handlers } = library;
    const france = editedTag(await handlers.createTag('France'));
    const paris = editedTag(await handlers.createTag('Paris'));
    await handlers.addTagParent(paris.id, 'France');

    expect(await handlers.getTagDetails(france.id)).toMatchObject({
      tag: { id: france.id, name: 'France' },
      parents: [],
      children: [{ id: paris.id, name: 'Paris' }],
      tagsBelow: 1,
    });
    await handlers.deleteTag(france.id);
    expect(await handlers.getTagDetails(france.id)).toBeNull();
  });

  it('tells renderers that tags changed, and no more, when a tag is made', async () => {
    const sent = listen();

    expect(await library.handlers.createTag('France')).toMatchObject({
      ok: true,
      tag: { name: 'France', fileCount: 0 },
    });
    expect(sent()).toEqual(['tagsChanged']);
  });

  it('tells renderers that searches may find other files when the definition of a tag changes', async () => {
    const { handlers } = library;
    const france = editedTag(await handlers.createTag('France'));
    const paris = editedTag(await handlers.createTag('Paris'));
    const lutetia = editedTag(await handlers.createTag('Lutetia'));
    const sent = listen();

    expect(editedTag(await handlers.renameTag(paris.id, 'Paris (France)', true))).toMatchObject({
      id: paris.id,
      name: 'Paris (France)',
      aliases: ['Paris'],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.addTagAlias(paris.id, 'Paname'))).toMatchObject({
      id: paris.id,
      aliases: ['Paname', 'Paris'],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.removeTagAlias(paris.id, 'Paris'))).toMatchObject({
      id: paris.id,
      aliases: ['Paname'],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.addTagParent(paris.id, 'france'))).toMatchObject({
      id: paris.id,
      parentIds: [france.id],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.removeTagParent(paris.id, france.id))).toMatchObject({
      id: paris.id,
      parentIds: [],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.mergeTags(lutetia.id, paris.id))).toMatchObject({
      id: paris.id,
      name: 'Paris (France)',
      aliases: ['Lutetia', 'Paname'],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    // A rename that keeps nothing of the old name, then one of letter case only: the name alone
    // changes, and that is a change.
    expect(editedTag(await handlers.renameTag(france.id, 'Gaule', false))).toMatchObject({
      id: france.id,
      name: 'Gaule',
      aliases: [],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.renameTag(france.id, 'GAULE', false))).toMatchObject({
      id: france.id,
      name: 'GAULE',
      aliases: [],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
  });

  it('tells renderers when a tag gets a child tag, made on the way or not, and not when it had it', async () => {
    const { handlers } = library;
    const france = editedTag(await handlers.createTag('France'));
    editedTag(await handlers.createTag('Paris'));
    const sent = listen();

    expect(editedTag(await handlers.addTagChild(france.id, 'paris'))).toMatchObject({
      id: france.id,
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.addTagChild(france.id, 'Lyon'))).toMatchObject({
      id: france.id,
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(editedTag(await handlers.addTagChild(france.id, 'Paris'))).toMatchObject({
      id: france.id,
    });
    expect(sent()).toEqual([]);
    expect(await handlers.addTagChild(france.id, 'France')).toMatchObject({ ok: false });
    expect(sent()).toEqual([]);
    expect(await handlers.getMergePreview(france.id, france.id)).toBeNull();
  });

  it('tells renderers once when a parent tag is made on the way', async () => {
    const { handlers } = library;
    const paris = editedTag(await handlers.createTag('Paris'));
    const sent = listen();

    expect(editedTag(await handlers.addTagParent(paris.id, 'France')).parentIds).toHaveLength(1);
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect((await handlers.listTags()).map((tag) => tag.name)).toEqual(['France', 'Paris']);
  });

  it('also tells renderers of the tagged counts of library folders when a tag is deleted', async () => {
    await addTaggedFolders();
    const { handlers } = library;
    const tag = (await handlers.listTags())[0] as Tag;
    // Drive, then Pictures.
    expect(await handlers.listRoots()).toMatchObject([{ taggedCount: 1 }, { taggedCount: 2 }]);
    const sent = listen();

    expect(await handlers.deleteTag(tag.id)).toEqual({ ok: true });
    expect(sent()).toEqual([...DEFINITIONS_CHANGED, 'rootsChanged']);
    expect(await handlers.listRoots()).toMatchObject([{ taggedCount: 0 }, { taggedCount: 0 }]);
  });

  it('tells renderers nothing of a change to a tag that is refused', async () => {
    const { handlers } = library;
    const france = editedTag(await handlers.createTag('France'));
    const paris = editedTag(await handlers.createTag('Paris'));
    await handlers.addTagParent(paris.id, 'France');
    const gone = editedTag(await handlers.createTag('Lutetia'));
    await handlers.deleteTag(gone.id);
    const tags = await handlers.listTags();
    const sent = listen();

    expect(await handlers.createTag('FRANCE')).toMatchObject({ error: { kind: 'taken' } });
    expect(await handlers.renameTag(paris.id, 'France', false)).toMatchObject({
      error: { kind: 'taken' },
    });
    expect(await handlers.addTagAlias(paris.id, 'Paris, France')).toMatchObject({
      error: { kind: 'invalid' },
    });
    expect(await handlers.removeTagAlias(gone.id, 'Paname')).toMatchObject({
      error: { kind: 'gone' },
    });
    expect(await handlers.addTagParent(france.id, 'Paris')).toMatchObject({
      error: { kind: 'loop' },
    });
    expect(await handlers.removeTagParent(gone.id, france.id)).toMatchObject({
      error: { kind: 'gone' },
    });
    expect(await handlers.mergeTags(gone.id, paris.id)).toMatchObject({ error: { kind: 'gone' } });
    expect(await handlers.deleteTag(gone.id)).toMatchObject({ error: { kind: 'gone' } });

    expect(sent()).toEqual([]);
    expect(await handlers.listTags()).toEqual(tags);
  });

  it('tells renderers nothing of a change to a tag that asks for what is already so', async () => {
    const { handlers } = library;
    const france = editedTag(await handlers.createTag('France'));
    const paris = editedTag(await handlers.createTag('Paris'));
    await handlers.addTagAlias(paris.id, 'Paname');
    await handlers.addTagParent(paris.id, 'France');
    const tags = await handlers.listTags();
    const sent = listen();

    expect(await handlers.renameTag(paris.id, 'Paris', true)).toMatchObject({ ok: true });
    expect(await handlers.addTagAlias(paris.id, 'PANAME')).toMatchObject({ ok: true });
    expect(await handlers.removeTagAlias(paris.id, 'Lutetia')).toMatchObject({ ok: true });
    expect(await handlers.addTagParent(paris.id, 'France')).toMatchObject({ ok: true });
    expect(await handlers.removeTagParent(france.id, paris.id)).toMatchObject({ ok: true });
    expect(await handlers.mergeTags(paris.id, paris.id)).toMatchObject({ ok: true });

    expect(sent()).toEqual([]);
    expect(await handlers.listTags()).toEqual(tags);
  });

  it('tells renderers of a rename that changes only characters nobody sees, and nothing of a name the tag has but for them', async () => {
    const { handlers } = library;
    const paris = editedTag(await handlers.createTag('Paris'));
    await handlers.addTagAlias(paris.id, 'Paname');
    const tags = await handlers.listTags();
    const sent = listen();

    // As pasted from a web page: with a zero-width space, a soft hyphen, direction marks. Each
    // is a name the tag has: no tag is made of it, and the tag is not given it again.
    expect(await handlers.createTag('Paris\u200B')).toMatchObject({ error: { kind: 'taken' } });
    expect(await handlers.addTagAlias(paris.id, 'Pa\u00ADris')).toMatchObject({ ok: true });
    expect(await handlers.addTagAlias(paris.id, '\u200EPaname\u200F')).toMatchObject({
      ok: true,
    });
    expect(sent()).toEqual([]);
    expect(await handlers.listTags()).toEqual(tags);

    // A rename to the name it has, spelled with one: the name alone changes, and that is a change.
    expect(editedTag(await handlers.renameTag(paris.id, 'Pa\u00ADris', true))).toMatchObject({
      id: paris.id,
      name: 'Pa\u00ADris',
      aliases: ['Paname'],
    });
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
  });

  it('changes the definition of no tag while tags are exported, and still tags files', async () => {
    await addTaggedFolders();
    const files = await allFiles();
    const calls = definitionCalls();

    const exporting = library.hostHandlers.exportTags(file('tags.jsonl'), APP);
    expectTaggingOnly(calls, files);

    expect((await exporting).files).toBe(3);
    expect(answersOf(calls)).toEqual(eachAnswering(calls, expect.objectContaining({ ok: true })));
  });

  it('changes the definition of no tag while a tags import is applied, and still tags files', async () => {
    await addTaggedFolders();
    const { handlers, hostHandlers } = library;
    await hostHandlers.exportTags(file('tags.jsonl'), APP);
    const files = await allFiles();
    const tagged = await handlers.getSelectionTags(files);
    await handlers.removeTags(
      files,
      tagged.map((tag) => tag.id),
    );
    const source = await hostHandlers.openTagImport(file('tags.jsonl'));

    // A tags export being matched holds nothing back, as it writes nothing: tags are made meanwhile.
    const previewing = handlers.planTagImport(source.token);
    const calls = definitionCalls();
    const preview = await previewing;

    const applying = handlers.applyTagImport(source.token, preview.planId, true);
    expectTaggingOnly(calls, files);

    expect((await applying).assignments).toBe(3);
    expect(answersOf(calls)).toEqual(eachAnswering(calls, expect.objectContaining({ ok: true })));
  });

  it('finds files through aliases and parent tags, and takes them to another library by name', async () => {
    await addTaggedFolders();
    const [a, b, c] = (await allFiles()) as [number, number, number];
    const sent = listen();
    expect(await library.handlers.addTags([a], ['Paris'])).toMatchObject([{ status: 'added' }]);
    expect(await library.handlers.addTags([b], ['Trips/2024'])).toMatchObject([
      { status: 'added' },
    ]);
    expect(await library.handlers.addTags([c], ['France'])).toMatchObject([{ status: 'added' }]);
    expect(sent()).toEqual(['tagsChanged', 'tagsChanged', 'tagsChanged']);
    const paris = (await library.handlers.listTags()).find((tag) => tag.name === 'Paris') as Tag;
    expect(await found('tag:France')).toEqual(['c.jpg']);

    // Paris is also Paname, and below France: the tag that has that name, whatever its letter case.
    editedTag(await library.handlers.addTagAlias(paris.id, 'Paname'));
    expect(editedTag(await library.handlers.addTagParent(paris.id, 'FRANCE'))).toMatchObject({
      name: 'Paris',
      aliases: ['Paname'],
      fileCount: 1,
    });
    expect(sent()).toEqual([...DEFINITIONS_CHANGED, ...DEFINITIONS_CHANGED]);

    // A tag finds its files and those of the tags below it; with `=`, its own only.
    expect(await found('tag:France')).toEqual(['a.jpg', 'c.jpg']);
    expect(await found('tag:=France')).toEqual(['c.jpg']);
    expect(await found('-tag:France')).toEqual(['b.jpg']);
    expect(await found('tag:paname')).toEqual(['a.jpg']);
    expect(await found(tagTerm('Paris', true))).toEqual(['a.jpg']);
    // Free text finds a tag by a part of its name or of an alias, and the tags below it with it.
    expect(await found('fran')).toEqual(['a.jpg', 'c.jpg']);
    expect(await found('panam')).toEqual(['a.jpg']);
    // A name with `/` is one tag: neither of its parts is a tag.
    expect(await found(tagTerm('Trips/2024'))).toEqual(['b.jpg']);
    expect(await found('tag:Trips')).toEqual([]);
    expect(await found('tag:2024')).toEqual([]);
    expect((await library.handlers.listTags()).map((tag) => tag.name)).toEqual([
      'France',
      'Paris',
      't',
      'Trips/2024',
    ]);

    // The tags made or edited on purpose are exported with their aliases and parent tags, and each
    // file with the names of its own tags.
    expect(await library.hostHandlers.exportTags(file('tags.jsonl'), APP)).toMatchObject({
      files: 3,
      tags: 4,
      definitions: 2,
      leftOut: 0,
    });
    const lines = (await readFile(file('tags.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ format: 'sg-tag/tags', version: 2 });
    expect(lines.slice(1, 3)).toEqual([
      { tag: 'France' },
      { tag: 'Paris', aliases: ['Paname'], parents: ['France'] },
    ]);
    expect(
      Object.fromEntries(lines.slice(3, -1).map((line) => [line['rel'], line['tags']])),
    ).toEqual({ 'a.jpg': ['Paris', 't'], 'b.jpg': ['t', 'Trips/2024'], 'c.jpg': ['France', 't'] });
    expect(lines.at(-1)).toEqual({ end: true, files: 3, tags: 2 });

    // Another library of the same folders, where a tag already answers to the name Paris.
    await library.stop();
    stopped = true;
    library = new Library({ dataDir: file('data 2'), resourcesDir: null, appVersion: '0.0.0' });
    stopped = false;
    await library.start();
    for (const folder of ['Pictures', 'Drive']) {
      await library.handlers.addRoot(file(folder));
    }
    await vi.waitFor(async () => {
      expect(await library.handlers.getStatus()).toMatchObject({ totalFiles: 3, scanning: null });
    });
    const lutetia = editedTag(await library.handlers.createTag('Lutetia'));
    editedTag(await library.handlers.addTagAlias(lutetia.id, 'PARIS'));

    const source = await library.hostHandlers.openTagImport(file('tags.jsonl'));
    expect(source).toMatchObject({ files: 3, tags: 4, invalid: 0 });
    const preview = await library.handlers.planTagImport(source.token);
    // Paris is a tag here under another name, Lutetia, which gets the alias Paname and goes below
    // France. France is made as the tag lines describe it; t and Trips/2024 for their files.
    expect(preview.additions).toEqual({ assignments: 6, files: 3, newTags: 2 });
    expect(preview.definitions).toEqual({
      created: 1,
      createdItems: ['France'],
      aliases: 1,
      aliasItems: [{ tag: 'Lutetia', alias: 'Paname' }],
      links: 1,
      // Lutetia has no file yet: the import gives it one.
      linkItems: [{ tag: 'Lutetia', parent: 'France', newlyFound: 0 }],
      knownAs: 1,
      knownAsItems: [{ exported: 'Paris', tag: 'Lutetia' }],
      skipped: 0,
      skippedItems: [],
    });
    expect(
      await library.handlers.applyTagImport(source.token, preview.planId, false),
    ).toMatchObject({
      assignments: 6,
      files: 3,
      newTags: 2,
      skipped: 0,
      notFound: 0,
      definitions: { created: 1, aliases: 1, links: 1, skipped: 0 },
    });

    expect(await tagsByFile()).toEqual({
      'a.jpg': ['Lutetia', 't'],
      'b.jpg': ['t', 'Trips/2024'],
      'c.jpg': ['France', 't'],
    });
    const tags = await library.handlers.listTags();
    const france = tags.find((tag) => tag.name === 'France') as Tag;
    expect(
      tags.map(({ name, aliases, parentIds, fileCount }) => ({
        name,
        aliases,
        parentIds,
        fileCount,
      })),
    ).toEqual([
      { name: 'France', aliases: [], parentIds: [], fileCount: 1 },
      { name: 'Lutetia', aliases: ['Paname', 'PARIS'], parentIds: [france.id], fileCount: 1 },
      { name: 't', aliases: [], parentIds: [], fileCount: 3 },
      { name: 'Trips/2024', aliases: [], parentIds: [], fileCount: 1 },
    ]);
    expect(await found('tag:France')).toEqual(['a.jpg', 'c.jpg']);
    expect(await found('tag:paris')).toEqual(['a.jpg']);
    expect(await found('tag:paname')).toEqual(['a.jpg']);
    expect(await found(tagTerm('Trips/2024'))).toEqual(['b.jpg']);
    expect(await found('tag:Trips')).toEqual([]);
  });

  it('tags a file as its classification catalogue says, the subcategory below the category', async () => {
    await addTaggedFolders();
    const { handlers, hostHandlers } = library;
    const [a, b] = (await allFiles()) as [number, number, number];
    const catalogue = file('catalogue.csv');
    await writeFile(
      catalogue,
      [
        'Source path,Suggested category,Subcategory,Format and secondary tags',
        `"${file('Pictures', 'a.jpg')}",Animals,Wildlife,phone video;selfie`,
      ].join('\n'),
    );
    const sent = listen();

    expect(await hostHandlers.openCatalogue(catalogue)).toMatchObject({ rows: 1, error: null });
    expect(await handlers.getCatalogue()).toMatchObject({ path: catalogue, rows: 1 });
    expect(sent()).toEqual(['catalogueChanged']);
    expect(await handlers.getCatalogueEntry(b)).toBeNull();
    expect((await handlers.getCatalogueEntry(a))?.suggestions).toEqual([
      { name: 'Wildlife', kind: 'subject', added: false },
      { name: 'phone video', kind: 'format', added: false },
      { name: 'selfie', kind: 'format', added: false },
    ]);

    // Only the tags it suggests for the file.
    const outcomes = await handlers.addCatalogueTags(a, ['Wildlife', 'selfie', 'Elsewhere']);
    expect(outcomes.map((outcome) => [outcome.name, outcome.status])).toEqual([
      ['Wildlife', 'added'],
      ['selfie', 'added'],
    ]);
    expect(sent()).toEqual(DEFINITIONS_CHANGED);
    expect(await found('tag:Animals')).toEqual(['a.jpg']);
    expect((await tagsByFile())['a.jpg']).toEqual(['selfie', 't', 'Wildlife']);
    expect((await handlers.getCatalogueEntry(a))?.suggestions.map((each) => each.added)).toEqual([
      true,
      false,
      true,
    ]);

    // The category is already above it: the definition of no tag changes.
    expect(await handlers.addCatalogueTags(a, ['Wildlife', 'phone video'])).toMatchObject([
      { name: 'Wildlife', status: 'present' },
      { name: 'phone video', status: 'added' },
    ]);
    expect(sent()).toEqual(['tagsChanged']);

    await handlers.forgetCatalogue();
    expect(sent()).toEqual(['catalogueChanged']);
    expect(await handlers.getCatalogue()).toBeNull();
    expect(await handlers.getCatalogueEntry(a)).toBeNull();
    expect(await handlers.addCatalogueTags(a, ['Wildlife'])).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it('lets through, as it is, the refusal of a library made by a newer version', async () => {
    await library.stop();
    stopped = true;
    const db = openDatabase(file('data', 'library.db'));
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    db.close();

    // The very error: the worker process tells it from any other by its class.
    expect(
      () => new Library({ dataDir: file('data'), resourcesDir: null, appVersion: '0.0.0' }),
    ).toThrow(NewerLibraryError);
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

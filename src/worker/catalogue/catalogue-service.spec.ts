import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsRepository } from '../library/settings-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary, editedTag } from '../testing/test-library';
import { CatalogueService } from './catalogue-service';

const HEADER =
  'Source path,Suggested category,Subcategory,Original size bytes,Original mtime nanoseconds,' +
  'Format and secondary tags,Confidence in category,Needs further review,Topic detail';

/** A row under `HEADER` for the file at `path`, of size 10 modified at 5 s. */
const row = (filePath: string, subcategory = 'Wildlife', formats = 'phone video;selfie'): string =>
  `${filePath},Animals,${subcategory},10,5000000000,${formats},high,False,A cat`;

describe('CatalogueService', () => {
  let dir: string;
  let library: TestLibrary;
  let settings: SettingsRepository;
  let changes: number;

  const serviceOf = (): CatalogueService =>
    new CatalogueService({
      files: library.files,
      roots: library.roots,
      tags: library.tags,
      settings,
      onChanged: () => {
        changes++;
      },
      caseInsensitive: true,
      platform: 'linux',
      checkIntervalMs: 0,
    });

  /** Writes a catalogue of `rows` under `HEADER`; returns its path. */
  const writeCatalogue = async (
    rows: readonly string[],
    name = 'catalogue.csv',
  ): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, [HEADER, ...rows].join('\n'));
    return file;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-catalogue-'));
    library = createTestLibrary();
    settings = new SettingsRepository(library.db);
    changes = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses a catalogue once chosen, and remembers it', async () => {
    const service = serviceOf();
    await service.start();
    expect(await service.status()).toBeNull();

    const file = await writeCatalogue([row('/library/a.jpg'), row('/library/b.jpg'), 'x,y,z']);
    const status = await service.choose(file);

    const expected = {
      path: file,
      rows: 2,
      invalid: 1,
      problems: ['Row 4: its source path cannot be read.'],
      error: null,
    };
    expect(status).toEqual(expected);
    expect(await service.status()).toEqual(expected);
    expect(settings.catalogueFile()).toBe(file);
    expect(changes).toBe(1);

    // Read again when the indexer starts again.
    const again = serviceOf();
    await again.start();
    expect(await again.status()).toEqual(expected);
  });

  it('keeps the catalogue chosen before when another cannot be used', async () => {
    const service = serviceOf();
    const file = await writeCatalogue([row('/library/a.jpg')]);
    await service.choose(file);
    const wrong = path.join(dir, 'wrong.csv');
    await writeFile(wrong, 'Name,Size\na.jpg,10');

    await expect(service.choose(wrong)).rejects.toThrow(
      'This file is not a classification catalogue: it has no “Source path” column.',
    );
    expect(await service.status()).toMatchObject({ path: file, rows: 1, error: null });
    expect(settings.catalogueFile()).toBe(file);
  });

  it('stops using a catalogue once forgotten', async () => {
    const service = serviceOf();
    const id = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });
    await service.choose(await writeCatalogue([row('/library/a.jpg')]));

    service.forget();

    expect(await service.status()).toBeNull();
    expect(await service.entryFor(id)).toBeNull();
    expect(settings.catalogueFile()).toBeNull();
    expect(changes).toBe(2);
  });

  it('says what the catalogue says of a file, and which of its tags the file has', async () => {
    const service = serviceOf();
    const id = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });
    await service.choose(await writeCatalogue([row('/library/a.jpg')]));

    expect(await service.entryFor(id)).toEqual({
      category: 'Animals',
      subcategory: 'Wildlife',
      confidence: 'high',
      flagged: false,
      reviewStatus: null,
      topic: 'A cat',
      visibleContent: null,
      reviewNotes: null,
      found: 'samePlace',
      classifiedPath: '/library/a.jpg',
      suggestions: [
        { name: 'Wildlife', kind: 'subject', added: false },
        { name: 'phone video', kind: 'format', added: false },
        { name: 'selfie', kind: 'format', added: false },
      ],
    });

    // A tag renamed since, its old name kept as an alias, is still the tag suggested.
    library.tags.addToFiles([id], ['selfie']);
    const selfie = library.tags.resolve(['selfie'])[0]?.id ?? 0;
    editedTag(library.tags.renameTag(selfie, 'Selfies', true));

    expect((await service.entryFor(id))?.suggestions).toEqual([
      { name: 'Wildlife', kind: 'subject', added: false },
      { name: 'phone video', kind: 'format', added: false },
      { name: 'selfie', kind: 'format', added: true },
    ]);
  });

  it('finds a file that changed, or moved, since it was classified', async () => {
    const service = serviceOf();
    const changed = library.addFile('Unsorted/a.jpg', { size: 99, mtimeMs: 5_000 });
    const moved = library.addFile('Sorted/b.jpg', { size: 10, mtimeMs: 5_000 });
    const unlisted = library.addFile('Sorted/c.jpg', { size: 10, mtimeMs: 5_000 });
    await service.choose(
      await writeCatalogue([row('/library/Unsorted/a.jpg'), row('/library/Unsorted/b.jpg')]),
    );

    expect(await service.entryFor(changed)).toMatchObject({
      found: 'changed',
      classifiedPath: '/library/Unsorted/a.jpg',
    });
    expect(await service.entryFor(moved)).toMatchObject({
      found: 'moved',
      classifiedPath: '/library/Unsorted/b.jpg',
    });
    expect(await service.entryFor(unlisted)).toBeNull();
  });

  it('does not take a file by its name for a row whose own file is at its place', async () => {
    const service = serviceOf();
    library.addFile('Unsorted/a.jpg', { size: 99, mtimeMs: 5_000 });
    const copy = library.addFile('Sorted/a.jpg', { size: 10, mtimeMs: 5_000 });
    await service.choose(await writeCatalogue([row('/library/Unsorted/a.jpg')]));

    expect(await service.entryFor(copy)).toBeNull();
  });

  it('reads the catalogue again when it changed on disk', async () => {
    const service = serviceOf();
    const id = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });
    const file = await writeCatalogue([row('/library/b.jpg')]);
    await service.choose(file);
    expect(await service.entryFor(id)).toBeNull();

    await writeCatalogue([row('/library/a.jpg'), row('/library/b.jpg')]);
    // Another date for sure: some file systems keep it to the second.
    await utimes(file, new Date(), new Date(Date.now() + 10_000));

    expect(await service.entryFor(id)).toMatchObject({ subcategory: 'Wildlife' });
    expect(await service.status()).toMatchObject({ rows: 2, error: null });
    expect(changes).toBe(2);
  });

  it('says why a catalogue chosen cannot be read any more, and uses it again once it can', async () => {
    const service = serviceOf();
    const id = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });
    const file = await writeCatalogue([row('/library/a.jpg')]);
    await service.choose(file);
    await rm(file);

    expect(await service.entryFor(id)).toBeNull();
    expect(await service.status()).toEqual({
      path: file,
      rows: 0,
      invalid: 0,
      problems: [],
      error:
        'Cannot read the catalogue: it was moved or deleted, or its drive is not connected. ' +
        'Choose it again, or another one.',
    });
    expect(settings.catalogueFile()).toBe(file);

    await writeCatalogue([row('/library/a.jpg')]);
    expect(await service.entryFor(id)).toMatchObject({ subcategory: 'Wildlife' });
    expect(changes).toBe(3);
  });

  it('checks the catalogue on disk at most once in a while', async () => {
    const service = new CatalogueService({
      files: library.files,
      roots: library.roots,
      tags: library.tags,
      settings,
      onChanged: () => undefined,
      platform: 'linux',
      checkIntervalMs: 60_000,
    });
    const file = await writeCatalogue([row('/library/a.jpg')]);
    await service.choose(file);
    await rm(file);

    expect(await service.status()).toMatchObject({ rows: 1, error: null });
  });
});

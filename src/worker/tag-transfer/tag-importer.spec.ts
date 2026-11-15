import type { TagImportPreview, TagImportSource, TagTransferProgress } from '@shared/model';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Crawler from '../indexer/crawler';
import { crawl, isDirectory, statFiles } from '../indexer/crawler';
import { fingerprint, FINGERPRINT_SCHEME } from '../indexer/fingerprint';
import { Reconciler } from '../indexer/reconciler';
import type { RootRecord } from '../library/roots-repository';
import { SettingsRepository } from '../library/settings-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { SLICE_BUDGET_MS, yieldNow } from './slices';
import { endLine, entryLine, headerLine } from './tag-file';
import { TagExporter } from './tag-exporter';
import { isLocalPath, TagImporter } from './tag-importer';

// The real `isDirectory`, watched: which paths of a tags export are looked at.
vi.mock('../indexer/crawler', async (importOriginal) => {
  const crawler = await importOriginal<typeof Crawler>();
  return { ...crawler, isDirectory: vi.fn(crawler.isDirectory) };
});

const APP = '2026.10.0-alpha.1';
/** Size of every file unless a case says otherwise. */
const SIZE = 1_000;
/** Modification time of every file of the cases without files on disk. */
const MTIME = 1_700_000_000_000;
const NOTHING = { assignments: 0, files: 0, newTags: 0 };
const NOT_OPEN = 'This tags export is no longer open: choose it again.';
const OUT_OF_DATE = 'This preview is out of date: check again.';
const APPLYING = 'Tags are being imported: wait until that is done.';

/** Stands for the fingerprint of a file holding `content`. */
const printOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 32);

/** A file listed in a tags export, holding `content`. */
interface Listed {
  readonly rel: string;
  readonly content: string;
  readonly tags: readonly string[];
  /** Index of its library folder in the export; 0 by default. */
  readonly root?: number;
  readonly size?: number;
}

describe('TagImporter', () => {
  let dir: string;
  let library: TestLibrary;
  let offline: Set<number>;
  /** Paths of the files whose fingerprint was read. */
  let reads: string[];
  let whenIndexed: () => Promise<void>;
  /** What `onTagged` was told, call by call. */
  let tagged: (readonly number[])[];
  /** What `onImported` was told, import by import. */
  let imported: (readonly number[])[];
  let progress: (TagTransferProgress | null)[];
  let onProgress: () => void;
  let importer: TagImporter;
  let exports: number;

  const file = (relative: string): string => path.join(dir, ...relative.split('/'));
  const write = async (relative: string, content: string): Promise<void> => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), content);
  };
  const index = async (into: TestLibrary, ...roots: RootRecord[]): Promise<void> => {
    for (const root of roots) {
      await new Reconciler(into.files).syncRoot(root, await statFiles(await crawl(root.path)));
    }
  };
  /** The id of the file at `relative` in `from`. */
  const idIn = (from: TestLibrary, relative: string): number =>
    from.files.findByPath(file(relative))?.id ?? 0;
  const tagsOf = (id: number, from = library): string[] =>
    from.tags.forFile(id).map((tag) => tag.name);
  /** Indexes a file holding `content` at `/library/<rel>`, its fingerprint known. */
  const put = (rel: string, content: string, size = SIZE): number =>
    library.addFile(rel, { size, mtimeMs: MTIME, fingerprint: printOf(content) });
  /** Exports the tags of `from` as Export tags… does, and returns the file. */
  const exportTags = async (from: TestLibrary): Promise<string> => {
    const destination = file(`tags ${String(++exports)}.jsonl`);
    await new TagExporter({
      files: from.files,
      tags: from.tags,
      roots: from.roots,
      settings: new SettingsRepository(from.db),
      exportsDir: file('exports'),
      isOnline: (rootId) => !offline.has(rootId),
      onProgress: () => undefined,
    }).export(destination, APP);
    return destination;
  };
  /** Writes a tags export of `listed`, made on a computer whose library folders were `roots`. */
  const writeExport = async (
    listed: readonly Listed[],
    roots: readonly string[] = ['/library'],
    platform: string = process.platform,
  ): Promise<string> => {
    const lines = listed.map(({ rel, content, tags, root = 0, size = SIZE }) => {
      const slash = rel.lastIndexOf('/');
      const row = {
        id: 0,
        rootId: 0,
        path: `${roots[root] ?? ''}/${rel}`,
        dir: slash === -1 ? '' : rel.slice(0, slash),
        name: rel.slice(slash + 1),
        size,
        mtimeMs: MTIME,
        fingerprint: printOf(content),
        contentHash: null,
        missing: false,
      };
      return entryLine(row, root, tags);
    });
    const exported = file(`tags ${String(++exports)}.jsonl`);
    await writeFile(
      exported,
      [
        headerLine({
          app: APP,
          exportedAt: null,
          platform,
          fingerprint: FINGERPRINT_SCHEME,
          roots,
        }),
        ...lines,
        endLine(listed.length),
      ].join(''),
    );
    return exported;
  };
  const openAndPlan = async (
    exported: string,
  ): Promise<{ source: TagImportSource; preview: TagImportPreview }> => {
    const source = await importer.open(exported);
    return { source, preview: await importer.plan(source.token) };
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-import-'));
    library = createTestLibrary();
    offline = new Set();
    reads = [];
    whenIndexed = () => Promise.resolve();
    tagged = [];
    imported = [];
    progress = [];
    onProgress = () => undefined;
    exports = 0;
    importer = new TagImporter({
      files: library.files,
      tags: library.tags,
      roots: library.roots,
      isOnline: (rootId) => !offline.has(rootId),
      whenIndexed: () => whenIndexed(),
      onTagged: (ids) => {
        tagged.push(ids);
      },
      onImported: (ids) => {
        imported.push(ids);
      },
      onProgress: () => {
        progress.push(importer.progress);
        onProgress();
      },
      read: (target) => {
        reads.push(target.path);
        return fingerprint(target.path, target.size);
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('adds nothing when a fresh export of this library is imported into it', async () => {
    const pictures = library.roots.insert(file('Pictures'));
    const drive = library.roots.insert(file('Drive'));
    await write('Pictures/a.jpg', 'a');
    await write('Pictures/2024/b.jpg', 'b');
    await write('Pictures/2024/b copy.jpg', 'b');
    await write('Pictures/gone.jpg', 'gone');
    await write('Pictures/untagged.jpg', 'untagged');
    await write('Drive/c.jpg', 'c');
    await index(library, pictures, drive);
    const id = (relative: string): number => idIn(library, relative);
    const ids = [
      'Pictures/a.jpg',
      'Pictures/2024/b.jpg',
      'Pictures/2024/b copy.jpg',
      'Pictures/gone.jpg',
      'Drive/c.jpg',
    ].map(id);
    library.tags.addToFiles([id('Pictures/a.jpg')], ['Ana', 'AC/DC']);
    library.tags.addToFiles([id('Pictures/2024/b.jpg'), id('Pictures/2024/b copy.jpg')], ['Trips']);
    library.tags.addToFiles([id('Pictures/2024/b copy.jpg')], ['copies']);
    library.tags.addToFiles([id('Pictures/gone.jpg')], ['family']);
    library.tags.addToFiles([id('Drive/c.jpg')], ['drive']);
    // Missing from disk, and on a drive that is not connected.
    await rm(file('Pictures/gone.jpg'));
    await index(library, pictures);
    offline.add(drive.id);
    expect(library.files.findByPath(file('Pictures/gone.jpg'))?.missing).toBe(true);
    const before = ids.map((each) => tagsOf(each));
    const exported = await exportTags(library);

    const { source, preview } = await openAndPlan(exported);

    expect(preview.found).toEqual({ samePlace: 5, moved: 0, shared: 0 });
    expect(preview.changed).toBe(0);
    expect(preview.notFound).toEqual({ missing: 0, uncompared: 0, folder: 0, notFound: 0 });
    expect(preview.additions).toEqual(NOTHING);
    expect(preview.additionsWithChanged).toEqual(NOTHING);
    expect(reads).toEqual([]);
    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      ...NOTHING,
      skipped: 0,
      notFound: 0,
    });
    expect(ids.map((each) => tagsOf(each))).toEqual(before);
    expect(imported).toEqual([]);
  });

  it('gives library B the tags of library A, at another path, files renamed and dates reset', async () => {
    const a = createTestLibrary();
    const pictures = a.roots.insert(file('a/Pictures'));
    await write('a/Pictures/x.jpg', 'xx');
    await write('a/Pictures/2024/y.jpg', 'yyy');
    await write('a/Pictures/2024/z.jpg', 'zzzz');
    await write('a/Pictures/w.jpg', 'wwwww');
    await write('a/Pictures/untagged.jpg', 'untagged');
    await write('a/Pictures/left behind.jpg', 'left behind');
    await index(a, pictures);
    const inA = (rel: string): number => idIn(a, `a/Pictures/${rel}`);
    a.tags.addToFiles([inA('x.jpg')], ['Ana', 'Japan 2024']);
    a.tags.addToFiles([inA('2024/y.jpg'), inA('2024/z.jpg')], ['Kyoto']);
    a.tags.addToFiles([inA('w.jpg')], ['Food']);
    a.tags.addToFiles([inA('left behind.jpg')], ['left']);
    const exported = await exportTags(a);

    await cp(file('a/Pictures'), file('b/Photos'), { recursive: true });
    await rm(file('b/Photos/left behind.jpg'));
    await rename(file('b/Photos/x.jpg'), file('b/Photos/renamed.jpg'));
    await mkdir(file('b/Photos/2023'));
    await rename(file('b/Photos/2024/y.jpg'), file('b/Photos/2023/y.jpg'));
    /** Where each file of A is in B. */
    const inB: Record<string, string> = {
      'x.jpg': 'renamed.jpg',
      '2024/y.jpg': '2023/y.jpg',
      '2024/z.jpg': '2024/z.jpg',
      'w.jpg': 'w.jpg',
    };
    for (const rel of Object.values(inB)) {
      await utimes(file(`b/Photos/${rel}`), new Date(), new Date(2_000_000_000_000));
    }
    const photos = library.roots.insert(file('b/Photos'));
    await index(library, photos);

    const { source, preview } = await openAndPlan(exported);
    expect(preview.found).toEqual({ samePlace: 2, moved: 2, shared: 0 });
    expect(preview.notFound).toEqual({ missing: 0, uncompared: 0, folder: 0, notFound: 1 });
    expect(preview.missedItems).toEqual([
      { exported: file('a/Pictures/left behind.jpg'), reason: 'notFound' },
    ]);
    expect(preview.movedItems.toSorted((x, y) => x.exported.localeCompare(y.exported))).toEqual([
      { exported: file('a/Pictures/2024/y.jpg'), current: file('b/Photos/2023/y.jpg') },
      { exported: file('a/Pictures/x.jpg'), current: file('b/Photos/renamed.jpg') },
    ]);
    expect(preview.folders).toEqual([
      {
        exported: pictures.path,
        files: 5,
        found: 4,
        foundIn: [photos.path],
        inLibrary: false,
        suspicious: false,
        addable: false,
      },
    ]);
    // Ana, Japan 2024, Kyoto and Food.
    expect(preview.additions).toEqual({ assignments: 5, files: 4, newTags: 4 });
    // Each file of their sizes once: the dates tell nothing.
    expect(reads.toSorted()).toEqual(
      Object.values(inB)
        .map((rel) => file(`b/Photos/${rel}`))
        .sort(),
    );

    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({ assignments: 5, files: 4, newTags: 4, skipped: 0, notFound: 1 });
    for (const [rel, here] of Object.entries(inB)) {
      expect(tagsOf(idIn(library, `b/Photos/${here}`))).toEqual(tagsOf(inA(rel), a));
    }
    expect(tagsOf(idIn(library, 'b/Photos/untagged.jpg'))).toEqual([]);
  });

  it('adds nothing when the same tags export is imported again', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['trips', 'Ana'] },
      { rel: 'b.jpg', content: 'b', tags: ['trips'] },
    ]);
    const first = await openAndPlan(exported);
    expect(await importer.apply(first.source.token, first.preview.planId, true)).toEqual({
      assignments: 3,
      files: 2,
      newTags: 2,
      skipped: 0,
      notFound: 0,
    });

    const again = await openAndPlan(exported);
    expect(again.preview.found).toEqual({ samePlace: 2, moved: 0, shared: 0 });
    expect(again.preview.additions).toEqual(NOTHING);
    expect(await importer.apply(again.source.token, again.preview.planId, true)).toEqual({
      ...NOTHING,
      skipped: 0,
      notFound: 0,
    });
    expect(tagsOf(a)).toEqual(['Ana', 'trips']);
    expect(tagsOf(b)).toEqual(['trips']);
  });

  it('keeps the spelling of tags the library has, and counts each new tag once', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    library.tags.addToFiles([a], ['trips', 'Été']);
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['Japan'] },
      // Letter case does not tell two tags apart, accents do.
      { rel: 'b.jpg', content: 'b', tags: ['JAPAN', 'TRIPS', 'été', 'ete', 'Ramen'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    // Japan, ete and Ramen: trips and Été exist.
    expect(preview.additions).toEqual({ assignments: 6, files: 2, newTags: 3 });
    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({ assignments: 6, files: 2, newTags: 3, skipped: 0, notFound: 0 });
    expect(tagsOf(a)).toEqual(['Été', 'Japan', 'trips']);
    expect(tagsOf(b)).toEqual(['ete', 'Été', 'Japan', 'Ramen', 'trips']);
    expect(library.tags.list().map((tag) => tag.name)).toEqual([
      'ete',
      'Été',
      'Japan',
      'Ramen',
      'trips',
    ]);
  });

  it('takes a name for the tag of the library that it is but for characters nobody sees', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    const paris = library.addTag('Paris', { aliases: ['Paname'] });
    library.tags.attach([a], [paris]);
    const exported = await writeExport([
      // As another library holds them, pasted from a web page: its name with a zero-width space,
      // its alias with a soft hyphen.
      { rel: 'a.jpg', content: 'a', tags: ['Paris\u200B', 'Pa\u00ADname'] },
      // Three spellings of the one tag, which this file lacks.
      { rel: 'b.jpg', content: 'b', tags: ['Pa\u00ADris', '\u200EPARIS\u200F', 'Paris'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    // The name and the alias, however spelled.
    expect(source.tags).toBe(2);
    // No tag to make: one file has the tag, the other gets it once.
    expect(preview.additions).toEqual({ assignments: 1, files: 1, newTags: 0 });
    expect(preview.additionsWithChanged).toEqual({ assignments: 1, files: 1, newTags: 0 });
    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      assignments: 1,
      files: 1,
      newTags: 0,
      skipped: 0,
      notFound: 0,
    });
    expect(tagsOf(a)).toEqual(['Paris']);
    expect(tagsOf(b)).toEqual(['Paris']);
    // The tag there was, spelled as the library spells it.
    expect(library.tags.list()).toEqual([
      { id: paris, name: 'Paris', aliases: ['Paname'], parentIds: [], fileCount: 2 },
    ]);
    expect(imported).toEqual([[b]]);
  });

  it('makes one tag of the spellings of a name that differ by characters nobody sees', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    // A black flag, then the tag characters that spell `gbeng` and `gbsct`: nobody sees them, and
    // they are all that tells the flag of England from that of Scotland, which stay two tags.
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const exported = await writeExport([
      // A soft hyphen, then none, then a zero-width space.
      { rel: 'a.jpg', content: 'a', tags: ['Ky\u00ADoto', 'Kyoto'] },
      { rel: 'b.jpg', content: 'b', tags: ['KYOTO\u200B', england, scotland] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    expect(source.tags).toBe(3);
    expect(preview.additions).toEqual({ assignments: 4, files: 2, newTags: 3 });
    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({ assignments: 4, files: 2, newTags: 3, skipped: 0, notFound: 0 });
    // Spelled as the tags export first spells it.
    expect(tagsOf(a)).toEqual(['Ky\u00ADoto']);
    expect(tagsOf(b)).toEqual([england, scotland, 'Ky\u00ADoto']);
    expect(library.tags.count()).toBe(3);
    // Nothing is left to add.
    expect((await openAndPlan(exported)).preview.additionsWithChanged).toEqual(NOTHING);
  });

  it('makes one tag of a name that holds `/`, and no other', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    library.tags.addToFiles([a], ['trips']);
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['trips/2024/Japan', 'AC/DC'] },
      { rel: 'b.jpg', content: 'b', tags: ['Trips/2024/Japan', 'trips/2024'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    // trips/2024/Japan, AC/DC and trips/2024, each a tag of its own.
    expect(preview.additions).toEqual({ assignments: 4, files: 2, newTags: 3 });
    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({ assignments: 4, files: 2, newTags: 3, skipped: 0, notFound: 0 });
    expect(tagsOf(a)).toEqual(['AC/DC', 'trips', 'trips/2024/Japan']);
    // It did not have `trips`, and does not get it.
    expect(tagsOf(b)).toEqual(['trips/2024', 'trips/2024/Japan']);
    expect(library.tags.list().map(({ name, parentIds }) => ({ name, parentIds }))).toEqual([
      { name: 'AC/DC', parentIds: [] },
      { name: 'trips', parentIds: [] },
      { name: 'trips/2024', parentIds: [] },
      { name: 'trips/2024/Japan', parentIds: [] },
    ]);
  });

  it('counts the tags a preview would create, each once, as importing creates them', async () => {
    put('a.jpg', 'a');
    put('b.jpg', 'b, edited');
    const c = put('c.jpg', 'c');
    library.tags.addToFiles([c], ['Trips', 'family']);
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['Kyoto', 'Japan', 'trips'] },
      // Changed: counted only with the changed files.
      { rel: 'b.jpg', content: 'b', tags: ['Osaka', 'JAPAN', 'Ramen'] },
      { rel: 'c.jpg', content: 'c', tags: ['TRIPS', 'Family', 'kyoto'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    expect(preview.changed).toBe(1);
    // Kyoto and Japan.
    expect(preview.additions).toEqual({ assignments: 4, files: 2, newTags: 2 });
    // And Osaka and Ramen.
    expect(preview.additionsWithChanged).toEqual({ assignments: 7, files: 3, newTags: 4 });
    const before = library.tags.count();
    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      ...preview.additionsWithChanged,
      skipped: 0,
      notFound: 0,
    });
    expect(library.tags.count() - before).toBe(4);
  });

  it('adds nothing to a file that has a tag which the tags export names by an alias', async () => {
    const a = put('a.jpg', 'a');
    const paris = library.addTag('Paris', { aliases: ['Paname', 'Lutèce'] });
    library.tags.attach([a], [paris]);
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['Paname', 'LUTÈCE', 'paris'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    expect(preview.found).toEqual({ samePlace: 1, moved: 0, shared: 0 });
    expect(preview.additions).toEqual(NOTHING);
    expect(preview.additionsWithChanged).toEqual(NOTHING);
    // And importing adds what the preview says.
    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      ...NOTHING,
      skipped: 0,
      notFound: 0,
    });
    expect(tagsOf(a)).toEqual(['Paris']);
    expect(library.tags.list()).toEqual([
      { id: paris, name: 'Paris', aliases: ['Lutèce', 'Paname'], parentIds: [], fileCount: 1 },
    ]);
    expect(tagged).toEqual([]);
    expect(imported).toEqual([]);
  });

  it('gives a file a tag once, whatever names of it the tags export has', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    const c = put('c.jpg', 'c, edited');
    const paris = library.addTag('Paris', { aliases: ['Paname', 'Lutèce'] });
    library.tags.attach([a], [paris]);
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['Paname', 'Rome'] },
      // Three names of one tag, which this file lacks.
      { rel: 'b.jpg', content: 'b', tags: ['Lutèce', 'paris', 'PANAME'] },
      // Changed: counted only with the changed files.
      { rel: 'c.jpg', content: 'c', tags: ['Paname', 'Paris', 'rome'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    // Rome for the first, Paris for the second: an alias is no new tag.
    expect(preview.additions).toEqual({ assignments: 2, files: 2, newTags: 1 });
    expect(preview.additionsWithChanged).toEqual({ assignments: 4, files: 3, newTags: 1 });
    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      ...preview.additionsWithChanged,
      skipped: 0,
      notFound: 0,
    });
    expect(tagsOf(a)).toEqual(['Paris', 'Rome']);
    expect(tagsOf(b)).toEqual(['Paris']);
    expect(tagsOf(c)).toEqual(['Paris', 'Rome']);
    expect(library.tags.list().map(({ name, aliases }) => ({ name, aliases }))).toEqual([
      { name: 'Paris', aliases: ['Lutèce', 'Paname'] },
      { name: 'Rome', aliases: [] },
    ]);
  });

  it('adds tags by what their names stand for when importing, not at the preview', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['Paname', 'Paris'] },
      { rel: 'b.jpg', content: 'b', tags: ['Paris', 'Rome'] },
    ]);
    const { source, preview } = await openAndPlan(exported);
    // Three names that no tag has: three tags to make.
    expect(preview.additions).toEqual({ assignments: 4, files: 2, newTags: 3 });

    // Meanwhile two of them became the names of one tag, which one of the files got, and the
    // third an alias of another tag.
    const paris = library.addTag('Paris', { aliases: ['Paname'] });
    library.tags.attach([b], [paris]);
    library.addTag('Roma', { aliases: ['Rome'] });

    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      assignments: 2,
      files: 2,
      newTags: 0,
      skipped: 0,
      notFound: 0,
    });
    expect(tagsOf(a)).toEqual(['Paris']);
    expect(tagsOf(b)).toEqual(['Paris', 'Roma']);
    expect(library.tags.list().map((tag) => tag.name)).toEqual(['Paris', 'Roma']);
  });

  it('gives a file every tag its line names when one lost an alias, or was deleted, since the preview', async () => {
    const a = put('a.jpg', 'a');
    const b = put('b.jpg', 'b');
    const paris = library.addTag('Paris', { aliases: ['Paname'] });
    const roma = library.addTag('Roma', { aliases: ['Rome'] });
    // Each line names one tag twice, by an alias and then by its name.
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['Paname', 'Paris'] },
      { rel: 'b.jpg', content: 'b', tags: ['Rome', 'Roma'] },
    ]);
    const { source, preview } = await openAndPlan(exported);
    expect(preview.additions).toEqual({ assignments: 2, files: 2, newTags: 0 });

    // Meanwhile one tag lost its alias and the other was deleted: of the four names, one stands for
    // a tag of the library and three for tags to make.
    expect(library.tags.removeAlias(paris, 'Paname')).toMatchObject({ ok: true });
    expect(library.tags.deleteTag(roma)).toEqual({ ok: true });

    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      assignments: 4,
      files: 2,
      newTags: 3,
      skipped: 0,
      notFound: 0,
    });
    // Paris too, and not only the tag made of the name that was its alias.
    expect(tagsOf(a)).toEqual(['Paname', 'Paris']);
    expect(tagsOf(b)).toEqual(['Roma', 'Rome']);
    // Nothing is left to add.
    expect((await openAndPlan(exported)).preview.additionsWithChanged).toEqual(NOTHING);
  });

  it('lets the event loop run while it counts what the files of one chunk would get', async () => {
    // The same 50 tags on each file, all of them within one chunk of 1,000 files.
    const shared = Array.from({ length: 50 }, (_, at) => `tag ${at}`);
    const listed = Array.from({ length: 20 }, (_, at) => ({
      rel: `${at}.jpg`,
      content: `${at}`,
      size: SIZE + at,
      tags: shared,
    }));
    for (const { rel, content, size } of listed) {
      put(rel, content, size);
    }
    const source = await importer.open(await writeExport(listed));
    /** Turns of the event loop since the preview looked up the tags of the files found. */
    let turns: number | null = null;
    let planning = true;
    const turn = (): void => {
      if (turns !== null) {
        turns++;
      }
      if (planning) {
        setImmediate(turn);
      }
    };
    setImmediate(turn);
    const idsForFiles = library.tags.idsForFiles.bind(library.tags);
    vi.spyOn(library.tags, 'idsForFiles').mockImplementation((ids) => {
      turns ??= 0;
      return idsForFiles(ids);
    });
    // Each look at the clock takes 1 ms, so a slice is spent every few tags.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);

    const preview = await importer.plan(source.token);
    planning = false;

    expect(preview.additions).toEqual({ assignments: 1_000, files: 20, newTags: 50 });
    // More than once a file, though all of them are within one chunk.
    expect(turns).toBeGreaterThan(20);
  });

  it('lets the event loop run while it looks up the tags of a tags export in the library', async () => {
    const names = Array.from({ length: 2_000 }, (_, at) => `tag ${at}`);
    library.tags.addToFiles([put('a.jpg', 'a')], names.slice(0, 500));
    put('b.jpg', 'b');
    const source = await importer.open(
      await writeExport([
        { rel: 'b.jpg', content: 'b', tags: names.slice(0, 1_000) },
        // Not found: its tags are looked up all the same.
        { rel: 'elsewhere.jpg', content: 'elsewhere', tags: names.slice(1_000) },
      ]),
    );
    /** Names looked up since the event loop last ran, and the most there were. */
    let lookedUp = 0;
    let most = 0;
    let planning = true;
    const turn = (): void => {
      lookedUp = 0;
      if (planning) {
        setImmediate(turn);
      }
    };
    setImmediate(turn);
    const resolve = library.tags.resolve.bind(library.tags);
    const batches: number[] = [];
    vi.spyOn(library.tags, 'resolve').mockImplementation((batch) => {
      batches.push(batch.length);
      lookedUp += batch.length;
      most = Math.max(most, lookedUp);
      return resolve(batch);
    });
    // Each look at the clock takes 1 ms, so a slice is spent every few batches.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);

    const preview = await importer.plan(source.token);
    planning = false;

    // Each name of the tags export once, 100 at a time.
    expect(batches).toEqual(Array.from({ length: 20 }, () => 100));
    // The 500 tags that the library lacks, of the 1,000 of the file found.
    expect(preview.additions).toEqual({ assignments: 1_000, files: 1, newTags: 500 });
    // A look at the clock before each batch: a slice is spent within 8 of them.
    expect(most).toBeLessThanOrEqual(SLICE_BUDGET_MS * 100);
  });

  it('looks up fewer names at a time when they are long', async () => {
    // The longest a name may be: looking up 100 of them at a time would overrun a slice.
    const longest = Array.from({ length: 8 }, (_, at) => String(at).padEnd(1_024, '語'));
    const short = Array.from({ length: 150 }, (_, at) => `tag ${at}`);
    put('a.jpg', 'a');
    const source = await importer.open(
      await writeExport([{ rel: 'a.jpg', content: 'a', tags: [...longest, ...short] }]),
    );
    const resolve = library.tags.resolve.bind(library.tags);
    const batches: (readonly string[])[] = [];
    vi.spyOn(library.tags, 'resolve').mockImplementation((batch) => {
      batches.push(batch);
      return resolve(batch);
    });

    const preview = await importer.plan(source.token);

    // Each name once, in the order of the tags export.
    expect(batches.flat()).toEqual([...longest, ...short]);
    // 4,096 UTF-16 units at a time at most, which 4 of the longest names are, and 100 names.
    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 100, 50]);
    expect(preview.additions).toEqual({ assignments: 158, files: 1, newTags: 158 });
  });

  it('goes on from matching to counting what the files found would get in one slice', async () => {
    const listed = Array.from({ length: 6 }, (_, at) => ({
      rel: `${at}.jpg`,
      content: `${at}`,
      tags: ['trips'],
    }));
    for (const { rel, content } of listed) {
      put(rel, content);
    }
    const source = await importer.open(await writeExport(listed));
    // Each look at the clock takes 1 ms: no step spends a slice, but all of them together do.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    /** The clock when planning starts, at each turn of the event loop, then when it ends. */
    const clocks = [clock];
    let planning = true;
    const turn = (): void => {
      if (planning) {
        clocks.push(clock);
        setImmediate(turn);
      }
    };
    setImmediate(turn);

    const preview = await importer.plan(source.token);
    clocks.push(clock);
    planning = false;
    expect(preview.additions).toEqual({ assignments: 6, files: 6, newTags: 1 });
    const longest = Math.max(...clocks.slice(1).map((at, before) => at - (clocks[before] ?? 0)));
    // The budget, and the look at the clock that finds it spent.
    expect(longest).toBeLessThanOrEqual(SLICE_BUDGET_MS + 1);
  });

  it('never removes a tag', async () => {
    const a = put('a.jpg', 'a');
    const other = put('other.jpg', 'other');
    library.tags.addToFiles([a], ['keep', 'mine']);
    library.tags.addToFiles([other], ['other']);
    const exported = await writeExport([{ rel: 'a.jpg', content: 'a', tags: ['added'] }]);

    const { source, preview } = await openAndPlan(exported);
    await importer.apply(source.token, preview.planId, true);
    expect(tagsOf(a)).toEqual(['added', 'keep', 'mine']);
    expect(tagsOf(other)).toEqual(['other']);
  });

  it('gives a file found for two files of the tags export the tags of both', async () => {
    const photo = put('photo.jpg', 'same');
    const exported = await writeExport([
      { rel: 'photo.jpg', content: 'same', tags: ['trips', 'Ana'] },
      { rel: 'photo copy.jpg', content: 'same', tags: ['Trips', 'family'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    expect(preview.found).toEqual({ samePlace: 1, moved: 0, shared: 1 });
    expect(preview.movedItems).toEqual([]);
    // Trips is trips, spelled as the first file of the tags export does.
    expect(preview.additions).toEqual({ assignments: 3, files: 1, newTags: 3 });
    await importer.apply(source.token, preview.planId, true);
    expect(tagsOf(photo)).toEqual(['Ana', 'family', 'trips']);
  });

  it('tags files changed at their place only when the import includes them', async () => {
    put('a.jpg', 'a');
    const b = put('b.jpg', 'b, edited');
    put('c.jpg', 'c');
    const exported = await writeExport([
      { rel: 'a.jpg', content: 'a', tags: ['t'] },
      { rel: 'b.jpg', content: 'b', tags: ['t', 'edited'] },
      { rel: 'c.jpg', content: 'c', tags: ['t'] },
    ]);

    const { source, preview } = await openAndPlan(exported);
    expect(preview.found).toEqual({ samePlace: 2, moved: 0, shared: 0 });
    expect(preview.changed).toBe(1);
    expect(preview.changedItems).toEqual([
      { exported: '/library/b.jpg', current: '/library/b.jpg' },
    ]);
    expect(preview.additions).toEqual({ assignments: 2, files: 2, newTags: 1 });
    expect(preview.additionsWithChanged).toEqual({ assignments: 4, files: 3, newTags: 2 });
    expect(await importer.apply(source.token, preview.planId, false)).toEqual({
      assignments: 2,
      files: 2,
      newTags: 1,
      skipped: 0,
      notFound: 0,
    });
    expect(tagsOf(b)).toEqual([]);

    const again = await openAndPlan(exported);
    await importer.apply(again.source.token, again.preview.planId, true);
    expect(tagsOf(b)).toEqual(['edited', 't']);
  });

  it('refuses an old preview, a tags export no longer open, and importing while planning', async () => {
    const a = put('a.jpg', 'a');
    const exported = await writeExport([{ rel: 'a.jpg', content: 'a', tags: ['t'] }]);
    const { source, preview } = await openAndPlan(exported);
    const newer = await importer.plan(source.token);

    await expect(importer.apply(source.token, preview.planId, true)).rejects.toThrow(OUT_OF_DATE);
    await expect(importer.plan('another')).rejects.toThrow(NOT_OPEN);
    await expect(importer.apply('another', newer.planId, true)).rejects.toThrow(NOT_OPEN);

    const indexing = Promise.withResolvers<undefined>();
    whenIndexed = () => indexing.promise;
    const planning = importer.plan(source.token);
    await expect(importer.apply(source.token, newer.planId, true)).rejects.toThrow(OUT_OF_DATE);
    indexing.resolve(undefined);
    const latest = await planning;
    expect(tagsOf(a)).toEqual([]);

    await importer.apply(source.token, latest.planId, true);
    expect(tagsOf(a)).toEqual(['t']);
  });

  it('leaves out files deleted, changed or replaced between the preview and the import', async () => {
    const kept = put('kept.jpg', 'kept');
    const deleted = put('deleted.jpg', 'deleted');
    const edited = put('edited.jpg', 'edited');
    const replaced = put('replaced.jpg', 'replaced');
    const meanwhile = put('meanwhile.jpg', 'meanwhile');
    const exported = await writeExport(
      ['kept', 'deleted', 'edited', 'replaced', 'meanwhile'].map((name) => ({
        rel: `${name}.jpg`,
        content: name,
        tags: ['t'],
      })),
    );
    const { source, preview } = await openAndPlan(exported);
    expect(preview.additions).toEqual({ assignments: 5, files: 5, newTags: 1 });

    library.files.delete([deleted]);
    library.files.update(
      edited,
      {
        rootId: library.root.id,
        path: '/library/edited.jpg',
        dir: '',
        name: 'edited.jpg',
        ext: 'jpg',
        kind: 'image',
        size: SIZE,
        mtimeMs: MTIME + 60_000,
        birthtimeMs: null,
        fileId: null,
      },
      true,
    );
    // Ids can be reused: another file now has this one's.
    library.files.delete([replaced]);
    library.db
      .prepare<[number, number, number, number]>(
        `INSERT INTO files (id, root_id, path, dir, name, ext, kind, size, mtime_ms)
         VALUES (?, ?, '/library/new.jpg', '', 'new.jpg', 'jpg', 'image', ?, ?)`,
      )
      .run(replaced, library.root.id, SIZE, MTIME);
    // Counted as it is when importing.
    library.tags.addToFiles([meanwhile], ['t']);

    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({ assignments: 1, files: 1, newTags: 0, skipped: 3, notFound: 0 });
    expect(imported).toEqual([[kept, meanwhile]]);
    expect(tagsOf(kept)).toEqual(['t']);
    expect(tagsOf(edited)).toEqual([]);
    expect(tagsOf(replaced)).toEqual([]);
  });

  it('leaves out files that went missing between the preview and the import', async () => {
    const kept = put('kept.jpg', 'kept');
    const edited = put('edited.jpg', 'edited since');
    const deleted = put('deleted.jpg', 'deleted');
    put('other.jpg', 'other');
    // Missing already: taken on its content, and still missing when importing.
    const gone = library.addFile('gone.jpg', {
      size: SIZE,
      mtimeMs: MTIME,
      fingerprint: printOf('gone'),
      missingSince: 1,
    });
    const exported = await writeExport(
      ['kept', 'edited', 'deleted', 'other', 'gone'].map((name) => ({
        rel: `${name}.jpg`,
        content: name,
        tags: [name],
      })),
    );
    const { source, preview } = await openAndPlan(exported);
    expect(preview.found).toEqual({ samePlace: 4, moved: 0, shared: 0 });
    expect(preview.changedItems).toEqual([
      { exported: '/library/edited.jpg', current: '/library/edited.jpg' },
    ]);

    // Deleted on disk, as the indexer finds them. A missing row tagged would be kept, and give its
    // tags to the next file saved at its path; the one changed at its place has nothing else to
    // tie it to the tags export.
    library.files.markMissing(edited, MTIME);
    library.files.markMissing(deleted, MTIME);

    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({ assignments: 3, files: 3, newTags: 3, skipped: 2, notFound: 0 });
    expect(tagsOf(kept)).toEqual(['kept']);
    expect(tagsOf(gone)).toEqual(['gone']);
    expect(tagsOf(edited)).toEqual([]);
    expect(tagsOf(deleted)).toEqual([]);
  });

  it('creates no tag when every file left the library before the import', async () => {
    const a = put('a.jpg', 'a');
    const exported = await writeExport([{ rel: 'a.jpg', content: 'a', tags: ['brand new'] }]);
    const { source, preview } = await openAndPlan(exported);
    expect(preview.additions).toEqual({ assignments: 1, files: 1, newTags: 1 });

    library.files.delete([a]);
    expect(await importer.apply(source.token, preview.planId, true)).toEqual({
      ...NOTHING,
      skipped: 1,
      notFound: 0,
    });
    expect(library.tags.list()).toEqual([]);
    expect(tagged).toEqual([]);
    expect(imported).toEqual([]);
  });

  it('cancels a preview being made when another is asked for', async () => {
    const a = put('a.jpg', 'a');
    const exported = await writeExport([{ rel: 'a.jpg', content: 'a', tags: ['t'] }]);
    const source = await importer.open(exported);
    const indexing = Promise.withResolvers<undefined>();
    whenIndexed = () => indexing.promise;

    const first = importer.plan(source.token);
    const second = importer.plan(source.token);
    await expect(first).rejects.toThrow('Canceled.');
    expect(importer.progress).toEqual({ step: 'waiting', done: 0, total: 0 });
    indexing.resolve(undefined);
    const preview = await second;
    expect(importer.progress).toBeNull();
    expect(importer.busy).toBe(false);

    await importer.apply(source.token, preview.planId, true);
    expect(tagsOf(a)).toEqual(['t']);
  });

  it('stops reading a tags export when closed', async () => {
    const exported = await writeExport([{ rel: 'a.jpg', content: 'a', tags: ['t'] }]);

    const opening = importer.open(exported);
    expect(importer.progress).toEqual({ step: 'reading', done: 0, total: 0 });
    expect(importer.busy).toBe(true);
    importer.close();
    await expect(opening).rejects.toThrow('Canceled.');
    expect(importer.progress).toBeNull();
    expect(importer.busy).toBe(false);
    expect(progress).toEqual([{ step: 'reading', done: 0, total: 0 }, null]);

    // Closed once the whole file is read: forgotten all the same.
    onProgress = () => {
      if (importer.progress?.step === 'reading' && importer.progress.done > 0) {
        importer.close();
      }
    };
    await expect(importer.open(exported)).rejects.toThrow('Canceled.');
    expect(importer.busy).toBe(false);
  });

  it('refuses another tags export while importing, and finishes the import when closed', async () => {
    const a = put('a.jpg', 'a');
    const exported = await writeExport([{ rel: 'a.jpg', content: 'a', tags: ['t'] }]);
    const { source, preview } = await openAndPlan(exported);

    const applying = importer.apply(source.token, preview.planId, true);
    expect(importer.busy).toBe(true);
    const refused = [
      expect(importer.open(exported)).rejects.toThrow(APPLYING),
      expect(importer.plan(source.token)).rejects.toThrow(APPLYING),
    ];
    importer.close();
    expect((await applying).assignments).toBe(1);
    await Promise.all(refused);
    expect(tagsOf(a)).toEqual(['t']);
    expect(importer.progress).toBeNull();
    // Imported: importing again means opening it again.
    await expect(importer.plan(source.token)).rejects.toThrow(NOT_OPEN);
  });

  it('says it is applying an import only while it adds its tags', async () => {
    const ids = Array.from({ length: 1_001 }, (_, at) => put(`${at}.jpg`, `${at}`, SIZE + at));
    const exported = await writeExport(
      ids.map((_, at) => ({ rel: `${at}.jpg`, content: `${at}`, size: SIZE + at, tags: ['t'] })),
    );
    /** Whether it said so when each step began, and each time it had nothing left to do. */
    const said: [step: string, applying: boolean][] = [];
    onProgress = () => {
      const step = importer.progress?.step ?? 'idle';
      if (said.at(-1)?.[0] !== step) {
        said.push([step, importer.applying]);
      }
    };
    expect(importer.applying).toBe(false);

    // Reading a tags export and making a preview write nothing.
    const { source, preview } = await openAndPlan(exported);
    expect(importer.applying).toBe(false);

    const applying = importer.apply(source.token, preview.planId, true);
    // Between two chunks of files, when other requests are served.
    expect(library.tags.taggedFileCount()).toBe(1_000);
    expect(importer.applying).toBe(true);
    await applying;
    expect(library.tags.taggedFileCount()).toBe(1_001);
    expect(importer.applying).toBe(false);
    expect(said).toEqual([
      ['reading', false],
      ['idle', false],
      ['waiting', false],
      ['matching', false],
      ['idle', false],
      ['importing', true],
      ['idle', false],
    ]);
  });

  it('waits for indexing to settle before matching', async () => {
    const exported = await writeExport([{ rel: 'later.jpg', content: 'later', tags: ['t'] }]);
    const source = await importer.open(exported);
    const indexing = Promise.withResolvers<undefined>();
    whenIndexed = () => indexing.promise;
    let planned = false;

    const planning = importer.plan(source.token).then((preview) => {
      planned = true;
      return preview;
    });
    await yieldNow();
    await yieldNow();
    expect(planned).toBe(false);
    expect(importer.progress).toEqual({ step: 'waiting', done: 0, total: 0 });
    // Indexed meanwhile: found.
    put('later.jpg', 'later');
    indexing.resolve(undefined);
    expect((await planning).found).toEqual({ samePlace: 1, moved: 0, shared: 0 });
  });

  it('offers to add a folder only if it exists here, is apart, of this kind and nothing was found', async () => {
    library.roots.insert(file('lib'));
    await mkdir(file('lib/sub'), { recursive: true });
    await mkdir(file('elsewhere'));
    await mkdir(file('found'));
    put('found.jpg', 'found');
    const roots = [
      file('elsewhere'),
      file('nowhere'),
      path.join('..', 'elsewhere'),
      file('lib/sub'),
      file('found'),
      '/library',
    ];
    const exported = await writeExport(
      roots.map((folder, root) =>
        folder === file('found')
          ? { root, rel: 'found.jpg', content: 'found', tags: ['t'] }
          : { root, rel: `${root}.jpg`, content: folder, tags: ['t'] },
      ),
      roots,
    );

    const { preview } = await openAndPlan(exported);
    expect(preview.folders.map(({ exported: folder, addable }) => [folder, addable])).toEqual([
      [file('elsewhere'), true],
      // Not on this computer.
      [file('nowhere'), false],
      // Not an absolute path.
      [roots[2], false],
      // Within a library folder.
      [file('lib/sub'), false],
      // Its file was found.
      [file('found'), false],
      // Already a library folder.
      ['/library', false],
    ]);

    const other = process.platform === 'win32' ? 'darwin' : 'win32';
    const elsewhere = await writeExport(
      [{ rel: 'a.jpg', content: 'a', tags: ['t'] }],
      [file('elsewhere')],
      other,
    );
    expect((await openAndPlan(elsewhere)).preview.folders[0]?.addable).toBe(false);
  });

  it('never looks at a folder of a tags export that may be on another computer', async () => {
    await mkdir(file('elsewhere'));
    const remote =
      process.platform === 'win32'
        ? [
            '\\\\evil.invalid\\share',
            '//evil.invalid/share',
            '\\\\?\\UNC\\evil.invalid\\share',
            '\\\\.\\pipe\\evil',
          ]
        : [
            '//evil.invalid/share',
            '/net/evil.invalid/share',
            '/Network/Servers/evil.invalid/share',
          ];
    // A folder that exists, reached through `..`.
    const climbing = [file('elsewhere'), '..', '..', path.basename(dir), 'elsewhere'].join(
      path.sep,
    );
    const roots = [...remote, climbing, file('elsewhere')];
    const exported = await writeExport(
      roots.map((_, root) => ({ root, rel: `${root}.jpg`, content: `${root}`, tags: ['t'] })),
      roots,
    );
    vi.mocked(isDirectory).mockClear();

    const { preview } = await openAndPlan(exported);
    expect(vi.mocked(isDirectory).mock.calls).toEqual([[file('elsewhere')]]);
    expect(preview.folders.map(({ exported: folder, addable }) => [folder, addable])).toEqual([
      ...remote.map((folder) => [folder, false]),
      [climbing, false],
      [file('elsewhere'), true],
    ]);
  });

  it('matches a tags export whose library folders hold long runs of combining marks, as written', async () => {
    // More marks in a row than a name holds, in the reverse of the order NFC puts them in: NFC
    // would take 650 ms for each, so matching compares them as written (`nfcOf`).
    const roots = Array.from(
      { length: 8 },
      (_, root) => `/${root}${'\u0301'.repeat(16_383)}${'\u0316'.repeat(16_382)}`,
    );
    library.roots.insert('/Volumes/Archive');
    const exported = await writeExport(
      roots.map((_, root) => ({ root, rel: `${root}.jpg`, content: `${root}`, tags: ['t'] })),
      roots,
    );
    const normalize = vi.spyOn(String.prototype, 'normalize');

    const { preview } = await openAndPlan(exported);
    expect(preview.folders.map((folder) => folder.exported)).toEqual(roots);
    const longRun = /\p{M}{256}/u;
    expect(normalize.mock.contexts.filter((text) => longRun.test(String(text)))).toEqual([]);
  });

  it('keeps the tags added before an import fails, and the tags export open', async () => {
    const ids = Array.from({ length: 1_001 }, (_, at) => put(`${at}.jpg`, `${at}`, SIZE + at));
    const exported = await writeExport(
      ids.map((_, at) => ({ rel: `${at}.jpg`, content: `${at}`, size: SIZE + at, tags: ['t'] })),
    );
    const { source, preview } = await openAndPlan(exported);
    const transaction = library.files.transaction.bind(library.files);
    vi.spyOn(library.files, 'transaction')
      .mockImplementationOnce(transaction)
      .mockImplementationOnce(() => {
        throw new Error('database or disk is full');
      });

    await expect(importer.apply(source.token, preview.planId, true)).rejects.toThrow(
      'database or disk is full',
    );
    // The first chunk stays, and is told of like a finished import.
    expect(library.tags.taggedFileCount()).toBe(1_000);
    expect(imported).toEqual([ids.slice(0, 1_000)]);
    expect(importer.busy).toBe(false);
    expect(importer.applying).toBe(false);
    expect(importer.progress).toBeNull();
    // What is left to add needs a new preview.
    await expect(importer.apply(source.token, preview.planId, true)).rejects.toThrow(OUT_OF_DATE);
    const again = await importer.plan(source.token);
    expect(again.additions).toEqual({ assignments: 1, files: 1, newTags: 0 });

    expect(await importer.apply(source.token, again.planId, true)).toEqual({
      assignments: 1,
      files: 1,
      newTags: 0,
      skipped: 0,
      notFound: 0,
    });
    expect(library.tags.taggedFileCount()).toBe(1_001);
    await expect(importer.plan(source.token)).rejects.toThrow(NOT_OPEN);
  });

  it('adds the tags a chunk of files at a time, saying which files each time', async () => {
    const ids = Array.from({ length: 1_001 }, (_, at) => put(`${at}.jpg`, `${at}`, SIZE + at));
    // Files are tagged in id order, whatever the order of the tags export.
    const exported = await writeExport(
      ids
        .map((_, at) => ({ rel: `${at}.jpg`, content: `${at}`, size: SIZE + at, tags: ['t'] }))
        .reverse(),
    );
    const { source, preview } = await openAndPlan(exported);
    progress = [];

    const result = await importer.apply(source.token, preview.planId, true);
    expect(result).toEqual({
      assignments: 1_001,
      files: 1_001,
      newTags: 1,
      skipped: 0,
      notFound: 0,
    });
    expect(tagged).toEqual([ids.slice(0, 1_000), ids.slice(1_000)]);
    expect(imported).toEqual([ids]);
    expect(progress).toEqual([
      { step: 'importing', done: 0, total: 1_001 },
      { step: 'importing', done: 1_000, total: 1_001 },
      { step: 'importing', done: 1_001, total: 1_001 },
      null,
    ]);
  });
});

describe('isLocalPath', () => {
  it('accepts only absolute paths on a disk of this computer', () => {
    expect(isLocalPath('C:\\Users\\seb\\Pictures', 'win32')).toBe(true);
    expect(isLocalPath('d:/Photos', 'win32')).toBe(true);
    for (const other of [
      '\\\\nas\\photos',
      '//nas/photos',
      '\\\\?\\UNC\\nas\\photos',
      '\\\\?\\C:\\Photos',
      '\\\\.\\pipe\\photos',
      'C:Photos',
      '\\Photos',
      'Photos',
      'C:\\Photos\\..\\..',
    ]) {
      expect(isLocalPath(other, 'win32'), other).toBe(false);
    }

    expect(isLocalPath('/Users/seb/Pictures', 'darwin')).toBe(true);
    expect(isLocalPath('/Volumes/Archive/net', 'darwin')).toBe(true);
    expect(isLocalPath('/home/seb/Network', 'linux')).toBe(true);
    for (const other of [
      '//nas/photos',
      '/net/nas/photos',
      '/NET/nas/photos',
      '/Network/Servers/nas/photos',
      '/System/Volumes/Data/net/nas/photos',
      '/Users/../net/nas/photos',
      '/./net/nas/photos',
      'Pictures',
      'C:\\Pictures',
    ]) {
      expect(isLocalPath(other, 'darwin'), other).toBe(false);
    }
    expect(isLocalPath('/net/nas/photos', 'linux')).toBe(false);
  });
});

import type { CatalogueFilters, CatalogueImportDetails } from '@shared/model';
import { tagKey } from '@shared/tag-names';
import type { TagDefinition, TagsRepository } from '../library/tags-repository';
import type { ImportEntry, ParsedTagFile } from '../tag-transfer/tag-file';
import type { Catalogue, CatalogueRow } from './catalogue-file';
import type { CataloguePlace } from './catalogue-locator';

/** The category of the taxonomy for files whose subject the evidence does not settle. */
export const UNCLEAR_CATEGORY = 'Needs context or audio review';
/** Format tags without a tag listed in the preview, most files first. */
const MAX_FORMAT_ITEMS = 20;

/** A classification catalogue as an import reads it. */
export interface CatalogueImport {
  /**
   * As a tags export would be read: one library folder (the deepest folder holding every row
   * kept), each row kept an entry with its tags, and the definitions of its categories and
   * subcategories, each subcategory below its category.
   */
  readonly parsed: ParsedTagFile;
  /** Where each entry's file was when it was classified, by entry index. */
  readonly places: readonly CataloguePlace[];
  /**
   * The `tagKey` of each format tag that files get: tags of the library, which the import must not
   * make if one is gone by the time it is applied.
   */
  readonly formats: ReadonlySet<string>;
  readonly details: CatalogueImportDetails;
}

/**
 * What importing `catalogue` brings, its rows left out as `filters` say: each file kept gets its
 * subcategory, made below its category, and those of its format tags that the library has as a
 * name or an alias of a tag (`tags`), or that the import makes as a category or subcategory.
 */
export function catalogueImport(
  catalogue: Catalogue,
  filters: CatalogueFilters,
  tags: TagsRepository,
  platform: string = process.platform,
): CatalogueImport {
  const unclear = tagKey(UNCLEAR_CATEGORY);
  const matching = { lowConfidence: 0, flagged: 0, unclear: 0 };
  const kept: CatalogueRow[] = [];
  for (const row of catalogue.rows) {
    const low = row.confidence?.toLowerCase() === 'low';
    const isUnclear = tagKey(row.category) === unclear;
    matching.lowConfidence += low ? 1 : 0;
    matching.flagged += row.flagged ? 1 : 0;
    matching.unclear += isUnclear ? 1 : 0;
    if (
      !(low && !filters.lowConfidence) &&
      !(row.flagged && !filters.flagged) &&
      !(isUnclear && !filters.unclear)
    ) {
      kept.push(row);
    }
  }

  // Each category once, then each subcategory once below each of its categories.
  const categories = new Map<string, string>();
  const subjects = new Map<string, TagDefinition>();
  const defined = new Set<string>();
  for (const { category, subcategory } of kept) {
    const categoryKey = tagKey(category);
    const subcategoryKey = tagKey(subcategory);
    if (!categories.has(categoryKey)) {
      categories.set(categoryKey, category);
    }
    const pair = `${subcategoryKey}\n${categoryKey}`;
    if (!subjects.has(pair)) {
      subjects.set(pair, { name: subcategory, aliases: [], parents: [category] });
    }
    defined.add(categoryKey).add(subcategoryKey);
  }
  const definitions: TagDefinition[] = [
    ...[...categories.values()].map((name) => ({ name, aliases: [], parents: [] })),
    ...subjects.values(),
  ];

  // The format tags that a tag has, or that the import makes, and the files of the others.
  const formatFiles = new Map<string, { name: string; files: number }>();
  for (const row of kept) {
    for (const name of row.formats) {
      const key = tagKey(name);
      const counted = formatFiles.get(key);
      if (counted) {
        counted.files++;
      } else {
        formatFiles.set(key, { name, files: 1 });
      }
    }
  }
  const undefinedFormats = [...formatFiles].filter(([key]) => !defined.has(key));
  const resolved = tags.resolve(undefinedFormats.map(([, { name }]) => name));
  const formats = new Set<string>();
  undefinedFormats.forEach(([key], index) => {
    if (resolved[index]) {
      formats.add(key);
    }
  });
  const givenKey = (key: string): boolean => defined.has(key) || formats.has(key);
  const given = (name: string): boolean => givenKey(tagKey(name));
  const withoutTag = [...formatFiles]
    .filter(([key]) => !givenKey(key))
    .map(([, item]) => item)
    .sort((a, b) => (a.files === b.files ? a.name.localeCompare(b.name) : b.files - a.files));

  const folder = commonFolder(kept);
  const entries: ImportEntry[] = [];
  const places: CataloguePlace[] = [];
  const tagNames = new Map<string, string>();
  let filesWithoutFormat = 0;
  for (const row of kept) {
    const rowFormats = row.formats.filter(given);
    if (rowFormats.length < row.formats.length) {
      filesWithoutFormat++;
    }
    const names = [row.subcategory, ...rowFormats];
    for (const name of names) {
      const key = tagKey(name);
      if (!tagNames.has(key)) {
        tagNames.set(key, name);
      }
    }
    entries.push({
      root: 0,
      segments: row.segments.slice(folder.length),
      path: row.path,
      size: row.size ?? 0,
      mtimeMs: row.mtimeMs,
      fingerprint: null,
      sha256: null,
      missing: false,
      tags: names,
    });
    places.push({ segments: row.segments, size: row.size, mtimeMs: row.mtimeMs });
  }
  const distinct = new Set([...defined, ...tagNames.keys()]);

  return {
    parsed: {
      header: {
        app: 'media-classification',
        exportedAt: new Date(catalogue.mtimeMs).toISOString(),
        platform,
        roots: [pathOf(folder, platform)],
      },
      entries,
      definitions,
      tagCount: distinct.size,
      invalid: catalogue.invalid,
      problems: catalogue.problems,
      tags: tagNames,
    },
    places,
    formats,
    details: {
      filters,
      rows: catalogue.rows.length,
      matching,
      leftOut: catalogue.rows.length - kept.length,
      renamed: catalogue.renamed,
      formatsWithoutTag: withoutTag.length,
      filesWithoutFormat,
      formatItems: withoutTag.slice(0, MAX_FORMAT_ITEMS),
    },
  };
}

/** The segments of the deepest folder that holds the file of every row. */
function commonFolder(rows: readonly CatalogueRow[]): readonly string[] {
  const [first, ...others] = rows;
  if (first === undefined) {
    return [];
  }
  let common = first.segments.slice(0, -1);
  for (const { segments } of others) {
    let same = 0;
    while (same < common.length && same < segments.length - 1 && segments[same] === common[same]) {
      same++;
    }
    common = common.slice(0, same);
  }
  return common;
}

/** `segments` of an absolute path as `platform` writes it: `D:\Media`, `\\nas\share`, `/media`. */
function pathOf(segments: readonly string[], platform: string): string {
  if (segments.length === 0) {
    return '';
  }
  if (platform !== 'win32') {
    return `/${segments.join('/')}`;
  }
  const joined = segments.join('\\');
  if (/^[a-zA-Z]:$/.test(segments[0] ?? '')) {
    return segments.length === 1 ? `${joined}\\` : joined;
  }
  return `\\\\${joined}`;
}

import type {
  Tag,
  TagAddOutcome,
  TagDeleteResult,
  TagDetails,
  TagEditError,
  TagEditResult,
  TagRef,
  TagUsage,
} from '@shared/model';
import {
  MAX_TAG_ALIASES,
  MAX_TAG_PARENTS,
  normalizeTagName,
  tagFold,
  tagKey,
} from '@shared/tag-names';
import type { Db } from '../database/database';
import { jsonIds } from '../database/database';

/** The tag a name stands for. */
export interface ResolvedTag extends TagRef {
  /** The name given is one of the tag's aliases, not its name. */
  readonly viaAlias: boolean;
}

/**
 * The order of tags by name wherever they are listed: numbers by their value (`Tag 9` before
 * `Tag 10`), letters whatever their case and accents.
 */
const NAME_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** What a name or an alias is sorted by. */
interface Sortable {
  readonly name: string;
  readonly key: string;
}

/**
 * Compares two names for display. Names the collator holds equal (`côte` and `côté`) are told apart
 * by their keys, which no two names share: the order never depends on how the rows were read.
 */
function byName(a: Sortable, b: Sortable): number {
  const order = NAME_ORDER.compare(a.name, b.name);
  if (order !== 0 || a.key === b.key) {
    return order;
  }
  return a.key < b.key ? -1 : 1;
}

/** A tag with what it is sorted by. */
interface TagRow extends Sortable {
  readonly id: number;
}

/** A name or an alias of a tag, as stored. */
interface NameRow extends Sortable {
  readonly tagId: number;
  readonly isAlias: number;
}

/** A tag being put together by `list()`. */
interface ListedTag extends TagRow {
  readonly aliases: Sortable[];
  readonly parents: TagRow[];
  fileCount: number;
}

/** The numbers of `TagDetails` that take a walk through the tags below. */
interface ReachRow {
  readonly tagsBelow: number;
  readonly ownFiles: number;
  readonly filesWithBelow: number;
  readonly forgottenFiles: number;
}

/** Joins, as `n`, the row holding the name of the tag whose id is the SQL expression `tagId`. */
function nameOf(tagId: string): string {
  return `JOIN tag_names n ON n.tag_id = ${tagId} AND n.is_alias = 0`;
}

function prepareStatements(db: Db) {
  return {
    names: db.prepare<[], NameRow>(
      'SELECT tag_id AS tagId, name, key, is_alias AS isAlias FROM tag_names',
    ),
    links: db.prepare<[], { tagId: number; parentId: number }>(
      'SELECT tag_id AS tagId, parent_id AS parentId FROM tag_parents',
    ),
    // Walks `file_tags_tag`, which is in tag order: no temporary B-tree for the groups.
    fileCounts: db.prepare<[], { tagId: number; fileCount: number }>(
      'SELECT tag_id AS tagId, COUNT(*) AS fileCount FROM file_tags GROUP BY tag_id',
    ),
    namesOf: db.prepare<[number], NameRow>(
      'SELECT tag_id AS tagId, name, key, is_alias AS isAlias FROM tag_names WHERE tag_id = ?',
    ),
    nameOf: db.prepare<[number], TagRow>(
      'SELECT tag_id AS id, name, key FROM tag_names WHERE tag_id = ? AND is_alias = 0',
    ),
    byKey: db.prepare<[string], { id: number; name: string; viaAlias: number }>(`
      SELECT held.tag_id AS id, n.name, held.is_alias AS viaAlias
      FROM tag_names held ${nameOf('held.tag_id')}
      WHERE held.key = ?`),
    parentsOf: db.prepare<[number], TagRow>(`
      SELECT n.tag_id AS id, n.name, n.key
      FROM tag_parents tp ${nameOf('tp.parent_id')}
      WHERE tp.tag_id = ?`),
    childrenOf: db.prepare<[number], TagRow>(`
      SELECT n.tag_id AS id, n.name, n.key
      FROM tag_parents tp ${nameOf('tp.tag_id')}
      WHERE tp.parent_id = ?`),
    fileCountOf: db.prepare<[number], { count: number }>(
      'SELECT COUNT(*) AS count FROM file_tags WHERE tag_id = ?',
    ),
    aliasCount: db.prepare<[number], { count: number }>(
      'SELECT COUNT(*) AS count FROM tag_names WHERE tag_id = ? AND is_alias = 1',
    ),
    parentCount: db.prepare<[number], { count: number }>(
      'SELECT COUNT(*) AS count FROM tag_parents WHERE tag_id = ?',
    ),
    // The parents the tag kept by a merge ends up with: those of both, each once, less the two
    // tags themselves.
    mergedParentCount: db.prepare<[{ from: number; into: number }], { count: number }>(`
      SELECT COUNT(DISTINCT parent_id) AS count FROM tag_parents
      WHERE tag_id IN (@from, @into) AND parent_id NOT IN (@from, @into)`),
    // A child tag of `@id` that would have more than `@max` parents once `@id` is deleted and its
    // child tags have moved up: its own, less `@id`, and those of `@id`, each counted once.
    childPastParentLimit: db.prepare<[{ id: number; max: number }], { found: number }>(`
      SELECT 1 AS found FROM tag_parents down
      WHERE down.parent_id = @id
        AND (SELECT COUNT(DISTINCT parent_id) FROM tag_parents
             WHERE tag_id IN (down.tag_id, @id) AND parent_id <> @id) > @max
      LIMIT 1`),
    hasParent: db.prepare<[number, number], { found: number }>(
      'SELECT 1 AS found FROM tag_parents WHERE tag_id = ? AND parent_id = ?',
    ),
    // The child tags of `@above` that are `@below` or above it: none unless `@below` is below
    // `@above`. Walks up from `@below`: a tag has few tags above it, and may have thousands below.
    stepsDown: db.prepare<[{ above: number; below: number }], TagRow>(`
      WITH RECURSIVE reached(id) AS (
        SELECT @below
        UNION
        SELECT tp.parent_id FROM tag_parents tp JOIN reached r ON tp.tag_id = r.id
      )
      SELECT n.tag_id AS id, n.name, n.key
      FROM tag_parents tp ${nameOf('tp.tag_id')}
      WHERE tp.parent_id = @above AND tp.tag_id IN (SELECT id FROM reached)`),
    // `UNION` keeps each tag once however many ways lead down to it, so each file is counted once.
    // The counts of files on disk are those of the searches `tag:=Name` and `tag:Name`.
    reach: db.prepare<[{ id: number }], ReachRow>(`
      WITH RECURSIVE covered(id) AS (
        SELECT @id
        UNION
        SELECT tp.tag_id FROM tag_parents tp JOIN covered c ON tp.parent_id = c.id
      )
      SELECT
        (SELECT COUNT(*) - 1 FROM covered) AS tagsBelow,
        (SELECT COUNT(*) FROM file_tags ft JOIN files f ON f.id = ft.file_id
         WHERE ft.tag_id = @id AND f.missing_since IS NULL) AS ownFiles,
        (SELECT COUNT(*) FROM files f
         WHERE f.missing_since IS NULL AND f.id IN (
           SELECT ft.file_id FROM file_tags ft
           WHERE ft.tag_id IN (SELECT id FROM covered))) AS filesWithBelow,
        (SELECT COUNT(*) FROM file_tags ft JOIN files f ON f.id = ft.file_id
         WHERE ft.tag_id = @id AND f.missing_since IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM file_tags other
             WHERE other.file_id = ft.file_id AND other.tag_id <> ft.tag_id)) AS forgottenFiles`),
    insertTag: db.prepare<[number, number]>('INSERT INTO tags (kept, created_at) VALUES (?, ?)'),
    insertName: db.prepare<
      [{ key: string; fold: string; name: string; tagId: number; isAlias: number }]
    >(`
      INSERT INTO tag_names (key, fold, name, tag_id, is_alias)
      VALUES (@key, @fold, @name, @tagId, @isAlias)`),
    keep: db.prepare<[number]>('UPDATE tags SET kept = 1 WHERE id = ?'),
    demote: db.prepare<[string]>('UPDATE tag_names SET is_alias = 1 WHERE key = ?'),
    // Makes the row the name of its tag, spelled as given; on the row that already is, it only
    // changes the spelling.
    promote: db.prepare<[string, string]>(
      'UPDATE tag_names SET is_alias = 0, name = ? WHERE key = ?',
    ),
    rename: db.prepare<[{ key: string; fold: string; name: string; from: string }]>(
      'UPDATE tag_names SET key = @key, fold = @fold, name = @name WHERE key = @from',
    ),
    deleteAlias: db.prepare<[string, number]>(
      'DELETE FROM tag_names WHERE key = ? AND tag_id = ? AND is_alias = 1',
    ),
    link: db.prepare<[number, number]>('INSERT INTO tag_parents (tag_id, parent_id) VALUES (?, ?)'),
    unlink: db.prepare<[number, number]>(
      'DELETE FROM tag_parents WHERE tag_id = ? AND parent_id = ?',
    ),
    // Each child tag of the tag gets each of its parents, unless it has it already. Parent links
    // are added with `ON CONFLICT DO NOTHING`, here and in a merge: `INSERT OR IGNORE` would also
    // pass over a tag made its own parent, which must fail instead.
    passChildrenUp: db.prepare<[{ id: number }]>(`
      INSERT INTO tag_parents (tag_id, parent_id)
      SELECT down.tag_id, up.parent_id FROM tag_parents down, tag_parents up
      WHERE down.parent_id = @id AND up.tag_id = @id
      ON CONFLICT DO NOTHING`),
    // A merge gives the kept tag what the other has. Plain updates would fail wherever the two
    // already share something: a file carrying both, a parent or a child tag of both.
    moveFiles: db.prepare<[{ from: number; into: number }]>(`
      INSERT OR IGNORE INTO file_tags (file_id, tag_id)
      SELECT file_id, @into FROM file_tags WHERE tag_id = @from`),
    moveParents: db.prepare<[{ from: number; into: number }]>(`
      INSERT INTO tag_parents (tag_id, parent_id)
      SELECT @into, parent_id FROM tag_parents WHERE tag_id = @from
      ON CONFLICT DO NOTHING`),
    moveChildren: db.prepare<[{ from: number; into: number }]>(`
      INSERT INTO tag_parents (tag_id, parent_id)
      SELECT tag_id, @into FROM tag_parents WHERE parent_id = @from
      ON CONFLICT DO NOTHING`),
    moveNames: db.prepare<[{ from: number; into: number }]>(
      'UPDATE tag_names SET tag_id = @into, is_alias = 1 WHERE tag_id = @from',
    ),
    delete: db.prepare<[number]>('DELETE FROM tags WHERE id = ?'),
    // Joined with both tables: ids that are not, or no longer, a file or a tag are passed over.
    attach: db.prepare<[string, string]>(`
      INSERT OR IGNORE INTO file_tags (file_id, tag_id)
      SELECT f.id, t.id FROM files f, tags t
      WHERE f.id IN (SELECT value FROM json_each(?)) AND t.id IN (SELECT value FROM json_each(?))`),
    copy: db.prepare<[string, string]>(`
      INSERT OR IGNORE INTO file_tags (file_id, tag_id)
      SELECT target.value, ft.tag_id
      FROM json_each(?) target, file_tags ft
      WHERE ft.file_id IN (SELECT value FROM json_each(?))`),
    detach: db.prepare<[string, string]>(`
      DELETE FROM file_tags
      WHERE tag_id IN (SELECT value FROM json_each(?)) AND file_id IN (SELECT value FROM json_each(?))`),
    forFile: db.prepare<[number], TagRow>(`
      SELECT n.tag_id AS id, n.name, n.key
      FROM file_tags ft ${nameOf('ft.tag_id')}
      WHERE ft.file_id = ?`),
    forFiles: db.prepare<[string], TagRow & { fileId: number }>(`
      SELECT ft.file_id AS fileId, n.tag_id AS id, n.name, n.key
      FROM file_tags ft ${nameOf('ft.tag_id')}
      WHERE ft.file_id IN (SELECT value FROM json_each(?))
      ORDER BY ft.file_id`),
    idsForFiles: db.prepare<[string], { fileId: number; tagId: number }>(`
      SELECT file_id AS fileId, tag_id AS tagId FROM file_tags
      WHERE file_id IN (SELECT value FROM json_each(?))
      ORDER BY file_id, tag_id`),
    // Counted first, then named: the name of a tag is read once, not once for each file of the
    // selection that has the tag.
    forSelection: db.prepare<[string], TagRow & { fileCount: number }>(`
      SELECT n.tag_id AS id, n.name, n.key, used.fileCount
      FROM (
        SELECT ft.tag_id, COUNT(*) AS fileCount FROM file_tags ft
        WHERE ft.file_id IN (SELECT value FROM json_each(?))
        GROUP BY ft.tag_id
      ) used ${nameOf('used.tag_id')}`),
    count: db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM tags'),
    // Walks the primary key: no temporary B-tree for DISTINCT.
    taggedFileCount: db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM (SELECT DISTINCT file_id FROM file_tags)',
    ),
    cleanup: db.prepare<[]>(`
      DELETE FROM tags
      WHERE kept = 0 AND NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.tag_id = tags.id)`),
  };
}

/**
 * Tags: each has one name, any number of aliases and any number of parent tags. A name is checked
 * and stored as `normalizeTagName` leaves it, and stands for the same tag as any name with the same
 * `tagKey`. Every method is synchronous (better-sqlite3).
 *
 * A tag made by tagging files (`kept = 0`) goes with its last file (`cleanup`); one made or edited
 * on purpose (`kept = 1`) stays until `deleteTag`.
 *
 * Every method leaves these true:
 * - each tag has exactly one name;
 * - parent links never form a loop;
 * - no tag has more than `MAX_TAG_ALIASES` aliases or more than `MAX_TAG_PARENTS` parents;
 * - a tag with `kept = 0` has no alias, no parent and no child tag: whatever adds one sets
 *   `kept = 1` on the tags it concerns.
 *
 * The methods that change a tag (`createTag` to `mergeTags`) are one transaction each, and change
 * nothing when they answer an error. None answers `busy`: that is for the caller, which knows
 * whether tags are being exported or imported.
 */
export class TagsRepository {
  private readonly db: Db;
  private readonly statements: ReturnType<typeof prepareStatements>;

  constructor(db: Db) {
    this.db = db;
    this.statements = prepareStatements(db);
  }

  /** Every tag, sorted by name; the aliases of each sorted the same way, its parents by name. */
  list(): Tag[] {
    const names = this.statements.names.all();
    const tags = new Map<number, ListedTag>();
    for (const { tagId, name, key, isAlias } of names) {
      if (isAlias === 0) {
        tags.set(tagId, { id: tagId, name, key, aliases: [], parents: [], fileCount: 0 });
      }
    }
    for (const alias of names) {
      if (alias.isAlias === 1) {
        tags.get(alias.tagId)?.aliases.push(alias);
      }
    }
    for (const { tagId, parentId } of this.statements.links.all()) {
      const parent = tags.get(parentId);
      if (parent) {
        tags.get(tagId)?.parents.push(parent);
      }
    }
    for (const { tagId, fileCount } of this.statements.fileCounts.all()) {
      const tag = tags.get(tagId);
      if (tag) {
        tag.fileCount = fileCount;
      }
    }
    return [...tags.values()].sort(byName).map((tag) => ({
      id: tag.id,
      name: tag.name,
      aliases: tag.aliases.sort(byName).map((alias) => alias.name),
      parentIds: tag.parents.sort(byName).map((parent) => parent.id),
      fileCount: tag.fileCount,
    }));
  }

  /** One tag as `list()` gives it, or `null` when no tag has this id. */
  get(id: number): Tag | null {
    const names = this.statements.namesOf.all(id);
    const name = names.find((row) => row.isAlias === 0);
    if (!name) {
      return null;
    }
    return {
      id,
      name: name.name,
      aliases: names
        .filter((row) => row.isAlias === 1)
        .sort(byName)
        .map((alias) => alias.name),
      parentIds: this.parentsOf(id).map((parent) => parent.id),
      fileCount: this.statements.fileCountOf.get(id)?.count ?? 0,
    };
  }

  /**
   * For each of `names`, the tag it is the name or an alias of; `null` when no tag has it, and for
   * a name that cannot be one. Writes nothing.
   */
  resolve(names: readonly string[]): (ResolvedTag | null)[] {
    // One transaction, so that a long list is read under one lock instead of one per name.
    return this.transaction(() =>
      names.map((input) => {
        const check = normalizeTagName(input);
        return check.ok ? this.find(check.name) : null;
      }),
    );
  }

  /**
   * Tags `fileIds` with each of `names`: a name or an alias is that of its tag, and an unknown name
   * makes a tag, one that goes with its last file. Answers for each name, in order: `added` when at
   * least one file gained the tag, `present` when none did, `refused` (tagging nothing) for a name
   * that cannot be one.
   *
   * The tag of an unknown name is made whether or not any of `fileIds` is a file. When none is, it
   * is left without a file until the next `cleanup`, which is for the caller to run when nothing
   * was added.
   */
  addToFiles(fileIds: readonly number[], names: readonly string[]): TagAddOutcome[] {
    const files = jsonIds(fileIds);
    return this.transaction(() =>
      names.map((name): TagAddOutcome => {
        const check = normalizeTagName(name);
        if (!check.ok) {
          return { name, status: 'refused', problem: check.problem };
        }
        const known = this.find(check.name);
        const tag = known ? toRef(known) : this.insertTag(check.name, 0);
        const added = this.statements.attach.run(files, jsonIds([tag.id])).changes > 0;
        return { name, status: added ? 'added' : 'present', tag };
      }),
    );
  }

  /**
   * Gives each of `fileIds` each of `tagIds`: for importers, which resolve names themselves
   * (`resolve`). Returns the number of tags added, counted once per file: tags a file already has
   * are not, and ids that are not a file or a tag are passed over.
   */
  attach(fileIds: readonly number[], tagIds: readonly number[]): number {
    return this.statements.attach.run(jsonIds(fileIds), jsonIds(tagIds)).changes;
  }

  /** Gives each of `toIds` every tag that one of `fromIds` has. */
  copyTags(fromIds: readonly number[], toIds: readonly number[]): void {
    this.statements.copy.run(jsonIds(toIds), jsonIds(fromIds));
  }

  /** Takes `tagIds` from `fileIds`; the tags that only tagging had made go with their last file. */
  removeFromFiles(fileIds: readonly number[], tagIds: readonly number[]): void {
    this.transaction(() => {
      this.statements.detach.run(jsonIds(tagIds), jsonIds(fileIds));
      this.cleanup();
    });
  }

  /**
   * Deletes every tag that was made only by tagging files (`kept = 0`) and that no file carries any
   * more; returns how many. Call it after files that may have carried tags were deleted.
   */
  cleanup(): number {
    return this.statements.cleanup.run().changes;
  }

  /** The tags of a file, sorted as `list()` sorts them. */
  forFile(fileId: number): TagRef[] {
    return this.statements.forFile.all(fileId).sort(byName).map(toRef);
  }

  /** The tags that at least one of `fileIds` has, with how many of them, sorted as `list()`. */
  forSelection(fileIds: readonly number[]): TagUsage[] {
    return this.statements.forSelection
      .all(jsonIds(fileIds))
      .sort(byName)
      .map(({ id, name, fileCount }) => ({ id, name, fileCount }));
  }

  /** The tag names of each of `fileIds`, sorted as `list()` sorts them; untagged files left out. */
  namesForFiles(fileIds: readonly number[]): Map<number, string[]> {
    const names = new Map<number, string[]>();
    const carriers = new Map<number, TagRow & { readonly fileIds: number[] }>();
    for (const { fileId, id, name, key } of this.statements.forFiles.all(jsonIds(fileIds))) {
      if (!names.has(fileId)) {
        names.set(fileId, []);
      }
      const tag = carriers.get(id);
      if (tag) {
        tag.fileIds.push(fileId);
      } else {
        carriers.set(id, { id, name, key, fileIds: [fileId] });
      }
    }
    // Tags are sorted once and dealt out to their files in that order: comparing names is the slow
    // part, and a page of files carries far fewer distinct tags than it has file tags.
    for (const tag of [...carriers.values()].sort(byName)) {
      for (const fileId of tag.fileIds) {
        names.get(fileId)?.push(tag.name);
      }
    }
    return names;
  }

  /** The tag ids of each of `fileIds`; untagged files left out. */
  idsForFiles(fileIds: readonly number[]): Map<number, number[]> {
    const ids = new Map<number, number[]>();
    for (const { fileId, tagId } of this.statements.idsForFiles.all(jsonIds(fileIds))) {
      const list = ids.get(fileId);
      if (list) {
        list.push(tagId);
      } else {
        ids.set(fileId, [tagId]);
      }
    }
    return ids;
  }

  count(): number {
    return this.statements.count.get()?.count ?? 0;
  }

  /** Files, present or missing, that have at least one tag. */
  taggedFileCount(): number {
    return this.statements.taggedFileCount.get()?.count ?? 0;
  }

  /** Makes a tag that no file has yet. `taken` when a tag has the name, as its name or an alias. */
  createTag(name: string): TagEditResult {
    return this.transaction((): TagEditResult => {
      const check = normalizeTagName(name);
      if (!check.ok) {
        return refused({ kind: 'invalid', problem: check.problem });
      }
      const owner = this.find(check.name);
      if (owner) {
        return refused(taken(owner));
      }
      return this.edited(this.insertTag(check.name, 1).id);
    });
  }

  /**
   * Renames a tag. A change of letter case only, or of characters nobody sees, is a rename; one of
   * its own aliases becomes the name and the old name an alias; otherwise the old name stays as an
   * alias only with `keepOldName`. The very name it has changes nothing.
   */
  renameTag(id: number, name: string, keepOldName: boolean): TagEditResult {
    return this.transaction((): TagEditResult => {
      const current = this.statements.nameOf.get(id);
      if (!current) {
        return refused({ kind: 'gone' });
      }
      const check = normalizeTagName(name);
      if (!check.ok) {
        return refused({ kind: 'invalid', problem: check.problem });
      }
      if (check.name === current.name) {
        return this.edited(id);
      }
      const key = tagKey(check.name);
      const owner = this.find(check.name);
      if (owner && owner.id !== id) {
        return refused(taken(owner));
      }
      if (key === current.key) {
        // Its own name in another letter case, or with other characters nobody sees: only the
        // spelling changes.
        this.statements.promote.run(check.name, key);
      } else if (owner) {
        // The name is made an alias before the alias is made the name: as one statement, the swap
        // fails whenever the alias is the first row updated, the tag then having two names.
        this.statements.demote.run(current.key);
        this.statements.promote.run(check.name, key);
      } else if (keepOldName) {
        if (this.aliasCount(id) >= MAX_TAG_ALIASES) {
          return refused({ kind: 'limit', what: 'aliases' });
        }
        this.statements.demote.run(current.key);
        this.insertName(id, check.name, 0);
      } else {
        this.statements.rename.run({
          key,
          fold: tagFold(check.name),
          name: check.name,
          from: current.key,
        });
      }
      this.statements.keep.run(id);
      return this.edited(id);
    });
  }

  /** Gives a tag another name. Its own name or one of its aliases changes nothing. */
  addAlias(id: number, alias: string): TagEditResult {
    return this.transaction((): TagEditResult => {
      if (!this.statements.nameOf.get(id)) {
        return refused({ kind: 'gone' });
      }
      const check = normalizeTagName(alias);
      if (!check.ok) {
        return refused({ kind: 'invalid', problem: check.problem });
      }
      const owner = this.find(check.name);
      if (owner) {
        return owner.id === id ? this.edited(id) : refused(taken(owner));
      }
      if (this.aliasCount(id) >= MAX_TAG_ALIASES) {
        return refused({ kind: 'limit', what: 'aliases' });
      }
      this.insertName(id, check.name, 1);
      this.statements.keep.run(id);
      return this.edited(id);
    });
  }

  /**
   * Takes an alias from a tag. A name that is not one of its aliases changes nothing: the name of
   * the tag itself cannot be removed.
   */
  removeAlias(id: number, alias: string): TagEditResult {
    return this.transaction((): TagEditResult => {
      if (!this.statements.nameOf.get(id)) {
        return refused({ kind: 'gone' });
      }
      const check = normalizeTagName(alias);
      if (check.ok) {
        this.statements.deleteAlias.run(tagKey(check.name), id);
      }
      return this.edited(id);
    });
  }

  /**
   * Puts the tag below the tag that `parentName` is the name or an alias of, making that tag when
   * no tag has the name. `loop` when that tag is the tag itself or below it; a tag that is already
   * its parent changes nothing.
   */
  addParent(id: number, parentName: string): TagEditResult {
    return this.transaction((): TagEditResult => {
      const row = this.statements.nameOf.get(id);
      if (!row) {
        return refused({ kind: 'gone' });
      }
      const tag = toRef(row);
      const check = normalizeTagName(parentName);
      if (!check.ok) {
        return refused({ kind: 'invalid', problem: check.problem });
      }
      const known = this.find(check.name);
      if (known) {
        const parent = toRef(known);
        if (parent.id === id) {
          return refused({ kind: 'loop', above: tag, below: tag, through: null });
        }
        const loop = this.loop(tag, parent, false);
        if (loop) {
          return refused(loop);
        }
        if (this.statements.hasParent.get(id, parent.id)) {
          return this.edited(id);
        }
      }
      if (this.parentCount(id) >= MAX_TAG_PARENTS) {
        return refused({ kind: 'limit', what: 'parents' });
      }
      // Made only now that nothing refuses the link: an error leaves no tag behind.
      const parentId = known?.id ?? this.insertTag(check.name, 1).id;
      this.statements.link.run(id, parentId);
      this.statements.keep.run(id);
      this.statements.keep.run(parentId);
      return this.edited(id);
    });
  }

  /** Takes a parent from a tag. A tag that is not its parent changes nothing. */
  removeParent(id: number, parentId: number): TagEditResult {
    return this.transaction((): TagEditResult => {
      if (!this.statements.nameOf.get(id)) {
        return refused({ kind: 'gone' });
      }
      this.statements.unlink.run(id, parentId);
      return this.edited(id);
    });
  }

  /**
   * Deletes a tag: its files lose it and its aliases go. Its child tags move up to each of its
   * parents, so that the tags above still find their files; that cannot make a loop.
   *
   * `limit`, changing nothing, when a child tag would then have more parents than a tag may: the
   * limit must hold for every tag at all times, so that no tag can exist that a tags export cannot
   * hold.
   */
  deleteTag(id: number): TagDeleteResult {
    return this.transaction((): TagDeleteResult => {
      if (!this.statements.nameOf.get(id)) {
        return refused({ kind: 'gone' });
      }
      if (this.statements.childPastParentLimit.get({ id, max: MAX_TAG_PARENTS })) {
        return refused({ kind: 'limit', what: 'parents' });
      }
      this.statements.passChildrenUp.run({ id });
      this.statements.delete.run(id);
      return { ok: true };
    });
  }

  /**
   * Makes one tag of two: the files, parents and child tags of `fromId` become those of `intoId`,
   * and its name and aliases become aliases of `intoId`, which is answered. The same tag twice
   * changes nothing.
   *
   * `loop` when, leaving aside a parent link between the two themselves, one is below the other:
   * the tag in between would end up both above and below the tag kept. That is the only way a
   * merge could make a loop.
   */
  mergeTags(fromId: number, intoId: number): TagEditResult {
    return this.transaction((): TagEditResult => {
      const from = this.statements.nameOf.get(fromId);
      const into = this.statements.nameOf.get(intoId);
      if (!from || !into) {
        return refused({ kind: 'gone' });
      }
      if (fromId === intoId) {
        return this.edited(intoId);
      }
      const loop =
        this.loop(toRef(into), toRef(from), true) ?? this.loop(toRef(from), toRef(into), true);
      if (loop) {
        return refused(loop);
      }
      if (this.aliasCount(intoId) + 1 + this.aliasCount(fromId) > MAX_TAG_ALIASES) {
        return refused({ kind: 'limit', what: 'aliases' });
      }
      const pair = { from: fromId, into: intoId };
      if ((this.statements.mergedParentCount.get(pair)?.count ?? 0) > MAX_TAG_PARENTS) {
        return refused({ kind: 'limit', what: 'parents' });
      }
      // The link between the two goes first: moved, it would make the kept tag its own parent.
      this.statements.unlink.run(fromId, intoId);
      this.statements.unlink.run(intoId, fromId);
      this.statements.moveFiles.run(pair);
      this.statements.moveParents.run(pair);
      this.statements.moveChildren.run(pair);
      this.statements.moveNames.run(pair);
      this.statements.delete.run(fromId);
      this.statements.keep.run(intoId);
      return this.edited(intoId);
    });
  }

  /** What a tag stands for in the library; `null` when no tag has this id. */
  details(id: number): TagDetails | null {
    return this.transaction((): TagDetails | null => {
      const tag = this.get(id);
      const reach = this.statements.reach.get({ id });
      if (!tag || !reach) {
        return null;
      }
      return {
        tag,
        parents: this.parentsOf(id).map(toRef),
        children: this.statements.childrenOf.all(id).sort(byName).map(toRef),
        tagsBelow: reach.tagsBelow,
        ownFiles: reach.ownFiles,
        filesWithBelow: reach.filesWithBelow,
        taggedFiles: tag.fileCount,
        forgottenFiles: reach.forgottenFiles,
      };
    });
  }

  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** The tag that `name`, already normalised, is the name or an alias of. */
  private find(name: string): ResolvedTag | null {
    const row = this.statements.byKey.get(tagKey(name));
    return row ? { id: row.id, name: row.name, viaAlias: row.viaAlias === 1 } : null;
  }

  /** The parents of a tag, sorted by name. */
  private parentsOf(id: number): TagRow[] {
    return this.statements.parentsOf.all(id).sort(byName);
  }

  private aliasCount(id: number): number {
    return this.statements.aliasCount.get(id)?.count ?? 0;
  }

  private parentCount(id: number): number {
    return this.statements.parentCount.get(id)?.count ?? 0;
  }

  /** Makes a tag named `name`: a normalised name that no tag has. */
  private insertTag(name: string, kept: 0 | 1): TagRef {
    const id = Number(this.statements.insertTag.run(kept, Date.now()).lastInsertRowid);
    this.insertName(id, name, 0);
    return { id, name };
  }

  /** Stores `name`, normalised and held by no tag, as the name or an alias of tag `tagId`. */
  private insertName(tagId: number, name: string, isAlias: 0 | 1): void {
    this.statements.insertName.run({
      key: tagKey(name),
      fold: tagFold(name),
      name,
      tagId,
      isAlias,
    });
  }

  /**
   * The error that refuses to put `above` below `below`: `null` unless `below` is already below
   * `above`. It names the child tag of `above` that leads down to `below`, or none when `below` is
   * itself a child tag of `above`. With `besidesDirectLink`, being a child tag of `above` does not
   * count, only another way down does: a merge of the two drops that link.
   */
  private loop(above: TagRef, below: TagRef, besidesDirectLink: boolean): TagEditError | null {
    const steps = this.statements.stepsDown.all({ above: above.id, below: below.id });
    if (!besidesDirectLink && steps.some((step) => step.id === below.id)) {
      return { kind: 'loop', above, below, through: null };
    }
    const through = steps
      .filter((step) => step.id !== below.id)
      .sort(byName)
      .at(0);
    return through ? { kind: 'loop', above, below, through: toRef(through) } : null;
  }

  /** The answer to a change made to tag `id`, or to one it did not need: the tag as it is now. */
  private edited(id: number): TagEditResult {
    const tag = this.get(id);
    return tag ? { ok: true, tag } : refused({ kind: 'gone' });
  }
}

/** A tag as it is answered: without what it is sorted by here, or how it was found. */
function toRef({ id, name }: TagRef): TagRef {
  return { id, name };
}

/** The answer to a change that was not made. */
function refused(error: TagEditError): { readonly ok: false; readonly error: TagEditError } {
  return { ok: false, error };
}

/** The error for a name that `owner`, another tag, already has. */
function taken(owner: ResolvedTag): TagEditError {
  return { kind: 'taken', owner: toRef(owner), asAlias: owner.viaAlias };
}

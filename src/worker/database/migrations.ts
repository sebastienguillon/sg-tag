/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 * Never edit a released migration: append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  /* sql */ `
  CREATE TABLE roots (
    id          INTEGER PRIMARY KEY,
    path        TEXT    NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE files (
    id              INTEGER PRIMARY KEY,
    root_id         INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    path            TEXT    NOT NULL UNIQUE,  -- absolute, native separators, as found on disk
    dir             TEXT    NOT NULL,         -- relative to the root, '/'-separated, NFC
    name            TEXT    NOT NULL,         -- NFC
    ext             TEXT    NOT NULL,         -- lower-case, no dot
    kind            TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
    size            INTEGER NOT NULL,
    mtime_ms        INTEGER NOT NULL,
    birthtime_ms    INTEGER,
    file_id         TEXT,                     -- '<device>:<inode>', survives renames within a volume
    fingerprint     TEXT,                     -- quick content hash, computed once a file is tagged
    width           INTEGER,
    height          INTEGER,
    duration_ms     INTEGER,
    codec           TEXT,
    thumb_state     INTEGER NOT NULL DEFAULT 0,  -- see ThumbState
    missing_since   INTEGER                   -- set when a tagged file vanishes; NULL while present
  ) STRICT;

  CREATE INDEX files_root     ON files (root_id);
  -- One index per sort order, covering the attribute filters (type, ext, size), so filtered
  -- listings walk the index in display order without touching table rows.
  CREATE INDEX files_modified ON files (mtime_ms, id, missing_since, kind, ext, size);
  CREATE INDEX files_name     ON files (name COLLATE NOCASE, id, missing_since, kind, ext, size);
  CREATE INDEX files_size     ON files (size, id, missing_since, kind, ext);
  CREATE INDEX files_missing  ON files (size) WHERE missing_since IS NOT NULL;
  CREATE INDEX files_pending  ON files (kind, mtime_ms) WHERE thumb_state = 0 AND missing_since IS NULL;

  -- Substring search over names and folders; trigram + diacritic folding ('ete' finds 'Été').
  CREATE VIRTUAL TABLE files_fts USING fts5 (
    name, dir,
    content = 'files', content_rowid = 'id',
    tokenize = 'trigram remove_diacritics 1'
  );

  CREATE TRIGGER files_fts_insert AFTER INSERT ON files BEGIN
    INSERT INTO files_fts (rowid, name, dir) VALUES (new.id, new.name, new.dir);
  END;
  CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
    INSERT INTO files_fts (files_fts, rowid, name, dir) VALUES ('delete', old.id, old.name, old.dir);
  END;
  CREATE TRIGGER files_fts_update AFTER UPDATE OF name, dir ON files BEGIN
    INSERT INTO files_fts (files_fts, rowid, name, dir) VALUES ('delete', old.id, old.name, old.dir);
    INSERT INTO files_fts (rowid, name, dir) VALUES (new.id, new.name, new.dir);
  END;

  CREATE TABLE tags (
    id          INTEGER PRIMARY KEY,
    parent_id   INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,                       -- last path segment
    path        TEXT    NOT NULL UNIQUE COLLATE NOCASE, -- full '/'-separated path
    created_at  INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX tags_parent ON tags (parent_id);

  CREATE TABLE file_tags (
    file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, tag_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX file_tags_tag ON file_tags (tag_id, file_id);

  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL  -- JSON
  ) STRICT, WITHOUT ROWID;
  `,

  /* sql */ `
  -- When a row was created: a file that vanishes may be the source of one added shortly before.
  ALTER TABLE files ADD COLUMN added_at INTEGER;
  -- SHA-256 of the whole content, computed only when another file has the same size and fingerprint.
  ALTER TABLE files ADD COLUMN content_hash TEXT;

  CREATE INDEX files_content_hash ON files (content_hash) WHERE content_hash IS NOT NULL;
  -- Background fingerprinting, newest first, once the thumbnail is done.
  CREATE INDEX files_unprinted ON files (mtime_ms)
    WHERE fingerprint IS NULL AND missing_since IS NULL AND thumb_state != 0;
  `,

  /* sql */ `
  -- Tags stop being '/'-separated paths: a tag has one name, any number of aliases and any number
  -- of parent tags. The tags a library had are not carried over.
  --
  -- Dropping a table deletes its rows first. A tag deleted took the tags below it with it, one
  -- level of cascade for each level of tags: past a thousand, SQLite gives up. So the parents go
  -- first, then file_tags, the only other table that refers to a tag.
  UPDATE tags SET parent_id = NULL;
  DROP TABLE file_tags;
  DROP TABLE tags;
  -- The latest tags export wrote tags as paths and can no longer be imported: its record goes.
  DELETE FROM settings WHERE key = 'lastTagExport';

  -- A tag made or edited on purpose (kept = 1) stays until it is deleted; one made by tagging a
  -- file (kept = 0) goes with its last file.
  CREATE TABLE tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- never given again once its tag is deleted
    kept        INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
    created_at  INTEGER NOT NULL
  ) STRICT;

  -- The name of each tag (exactly one row with is_alias = 0) and its aliases, in one namespace:
  -- a key belongs to exactly one tag.
  CREATE TABLE tag_names (
    key       TEXT    PRIMARY KEY,                  -- identity: lower-case, nothing unseen (tagKey)
    fold      TEXT    NOT NULL,                     -- key without accents (tagFold), for search
    name      TEXT    NOT NULL CHECK (name <> ''),  -- as typed, normalised (normalizeTagName)
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    is_alias  INTEGER NOT NULL CHECK (is_alias IN (0, 1))
  ) STRICT;

  -- No tag has two names. Checked row by row: an alias takes the place of the name in two
  -- statements, the name made an alias first.
  CREATE UNIQUE INDEX tag_names_primary ON tag_names (tag_id) WHERE is_alias = 0;
  -- The aliases of one tag, and the rows to delete with it, without reading every name.
  CREATE INDEX tag_names_tag  ON tag_names (tag_id, is_alias);
  CREATE INDEX tag_names_fold ON tag_names (fold);

  -- A tag is below each of its parents. These links never form a loop: that is checked before
  -- one is added, since the schema cannot.
  CREATE TABLE tag_parents (
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    parent_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, parent_id),
    CHECK (tag_id <> parent_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX tag_parents_parent ON tag_parents (parent_id, tag_id);

  CREATE TABLE file_tags (
    file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, tag_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX file_tags_tag ON file_tags (tag_id, file_id);
  `,
];

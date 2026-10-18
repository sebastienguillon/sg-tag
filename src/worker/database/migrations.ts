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
];

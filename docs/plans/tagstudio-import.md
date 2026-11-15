# Import from TagStudio

The plan for bringing the tags of a [TagStudio](https://github.com/TagStudioDev/TagStudio) library
into SG Tag. Decided on 2026-11-15, once parent tags and aliases had landed
(`parent-tags-and-aliases.md`). Delete this file once its pull request has landed.

TagStudio facts below were read from its source (`src/tagstudio/core/library/alchemy`, `main`,
database version 400) and checked against a real library at version 102.

## Settled

1. **Built into the app**: Settings → Tags → Import from TagStudio…, a folder picker, then the
   preview and import that tags exports already have. Nothing is written before the preview is
   applied, and the import only adds.
2. **Names SG Tag refuses are rewritten**, each rewrite listed in the preview: a comma becomes a
   space, a double quote a single quote, a leading `=` and control characters go. A name still
   refused after that (empty, too long) is left out and listed.
3. **Files found by name are accepted**: a file no longer at its TagStudio path is the one file on
   disk of the same name in the library folder, as TagStudio's own "Fix Unlinked Entries" relinks
   it (`unlinked_registry.py`). When another entry is already at that file's path, the file gets
   the tags of both, as TagStudio merges the two entries (`merge_entries`). Several files of that
   name: not found, and listed.
4. **Only `ts_library.sqlite`** (TagStudio 9.5 and later). A library still in `ts_library.json`
   is refused with a sentence saying to open it once in a recent TagStudio, which converts it.
5. **Built-in tags** (ids 0 to 999: Archived, Favorite) come over only when a file has them or a
   tag that comes over has them as a parent tag. The Meta Tags category never does.
6. **A folder picker only**: TagStudio's list of libraries is not read.

## What comes over

| TagStudio                     | SG Tag                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| tag name                      | tag name (rewritten if refused, see Settled 2)                                          |
| aliases, shorthand            | aliases; one shared by several tags stays with the first (a tag's name wins)            |
| parent tags (several)         | parent tags; links that would make a loop are left out (`applyDefinitions`)             |
| same name, same parent tags   | one tag                                                                                 |
| same name, other parent tags  | `Name (Parent)`, the disambiguation parent first, then each parent; then `Name (P) (2)` |
| tags of a file                | tags of the file found                                                                  |
| tags on no file               | made all the same (kept, as any tag an import describes)                                |
| colours, icons, categories    | not carried over: counted in the preview                                                |
| hidden (Archived by default)  | an ordinary tag: the setting is counted as not carried over                             |
| fields (title, notes, dates…) | not carried over: counted                                                               |
| rows pointing at nothing      | dropped and counted (TagStudio does not enforce foreign keys)                           |

## TagStudio's database

- Version: `versions` row `CURRENT` (table since 101), else `preferences` row `DB_VERSION`
  (dropped in 104). Versions 6 to 499 are read: TagStudio itself opens a library whose major
  version (`version / 100`, from 100 on) is not above its own, and this is major 4.
- `tag_parents (parent_id, child_id)`: below version 100 the two columns are swapped
  (`MigrationTo100`).
- `tags`: `id`, `name`, `shorthand`, `color_slug`, `is_category`, `icon`, `disambiguation_id`;
  `is_hidden` since 103. Columns are looked up, so a version without one reads it as empty.
- `entries (id, path)`: `path` is relative to the library folder, `/`-separated (`as_posix`).
  Up to version 299 entries also have `folder_id` and there is a `folders` table: a library has
  one folder. When several are listed, the entries of the first are read and the others counted.
- `tag_entries (tag_id, entry_id)`, `tag_aliases (id, name, tag_id)`.
- Fields: `text_fields`, `datetime_fields`, and `boolean_fields` up to 199.

## Reading it safely

- The database is copied into the data folder (`imports/`) and the copy opened read-only, then
  deleted: a running TagStudio is neither locked nor disturbed. Refused above 1 GiB.
- `trusted_schema` off; every table read must be a plain table (no view, no virtual table) and no
  column read may be generated, so that reading runs no code from the file.
- Texts are read only if short enough (names 4,096 units, paths `MAX_REL_LENGTH`); the same limits
  as a tags export on tags per file, aliases and parents per tag, and distinct tags.
- Paths of the file are never opened: they are looked up in the index, within the chosen folder.
  `..`, empty segments and, on Windows, `\` or `:` in a segment make an entry unreadable.
- Rows are read a slice at a time (`Slicer`), so that a large library never holds the worker.

## Design

- `tagstudio-library.ts` reads the library into a `ParsedTagFile`: its one library folder is the
  folder chosen on this computer (not the path TagStudio stored), each tagged file an entry
  without size or content, the tags definitions written in two passes (names first, then aliases
  and parents), so that a tag's name always wins over another tag's alias in `applyDefinitions`.
  It also returns what the preview says of TagStudio: version, rewritten names, what is not
  carried over.
- `tagstudio-matcher.ts` returns a `MatchResult` from the index alone: at its path (present or
  missing), else by name as in Settled 3; not found because SG Tag does not index that kind of
  file (`notMedia`), because several files have its name (`ambiguous`), because it is outside the
  library folders (`folder`), or not found. No file is read.
- `TagImporter.openTagStudio(folder)` opens such a session; `plan` and `apply` work as for a tags
  export, choosing the matcher by the kind of session. `TagImportSource` gains `kind` and
  `tagStudio`.
- Main: `tags:open-tagstudio-import` shows a folder picker (choosing the `.TagStudio` folder
  itself works too) and hands the folder to the indexer.
- Renderer: the button, and the preview's words where they speak of a tags export.

## Not in this pull request

`ts_library.json`; reading TagStudio's list of libraries; colours; fields as tags; keeping a
TagStudio library in step with SG Tag after the import.

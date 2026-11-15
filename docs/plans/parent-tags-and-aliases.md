# Parent tags and aliases

The plan for replacing the `/` path hierarchy of tags with declared parent tags, and for giving a
tag several names. Decided on 2026-11-15, after a first draft was reviewed from eight angles (SQL by
experiment, search, tag lifecycle, export/import, interface, TagStudio's source, prior art, scope)
and every finding re-checked. Delete this file once the last pull request has landed.

Measurements quoted here were made on synthetic libraries with Node's built-in SQLite (3.53), not
inside the app (better-sqlite3): trust the ratios, not the absolute values.

## Settled

1. Declared parents replace the `/` path hierarchy; a tag may have several parents.
2. An alias is another name of one tag. Merge collapses two tags into one.
3. `/` is an ordinary character in a name; no `parent/child` shorthand in the tag input.
4. Free text also returns the files of tags below a matching tag.
5. The tag manager is its own `/tags` page.
6. Case never distinguishes two tags; accents do; search ignores both.
7. Deleting a tag moves its child tags up to its parents.
8. Tags exports made before this change (version 1) are refused: there are no users to strand.
9. The existing tags of a library are not migrated.
10. Characters nobody sees (a zero-width space or a soft hyphen pasted from a web page, direction
    marks) never distinguish two tags.

## What the review confirmed

- **Expanding parents at search time is right.** Danbooru writes the parent tag onto each file: it
  then leaves tags behind when a link is removed and puts back a parent tag the user removes. Hydrus
  moved to parents computed at search time.
- **TagStudio works the same way on both features** (read from its source, commit 7b39ccef): an
  alias is a row `tag_aliases(id, name, tag_id)`, a plain extra name of one tag, searched exactly
  like the name; a tag term finds the tag and everything below it at any depth through a recursive
  query; a file shows only its own tags.
- **The search SQL works as written and is fast.** The recursive set is built once per statement.
  At 100,000 files: a tag on 295 files 0.4 ms (44 ms today); a tag covering 37,000 files 70 ms
  (91 ms today). At 1,000,000 files: 4.7 ms against 419 ms; 948 ms against 1,212 ms. Never slower
  than today in any tested case.
- **Nothing outside the tag code reads tag paths**: duplicates, the Trash guard, the reconciler and
  missing-file logic use tag ids only.

## Data model (migration 3)

```sql
DROP TABLE file_tags;  -- drops first, in this order; no PRAGMA inside the transaction
DROP TABLE tags;       -- (first: UPDATE tags SET parent_id = NULL, for chains deeper than ~1,000)

CREATE TABLE tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- ids are never reused after a delete
  kept        INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),  -- made or edited on purpose
  created_at  INTEGER NOT NULL
) STRICT;

-- A tag's name and its aliases, in one namespace: each resolves to exactly one tag.
CREATE TABLE tag_names (
  key       TEXT    PRIMARY KEY,   -- identity: lower-cased (Unicode), NFC, computed in JavaScript
  fold      TEXT    NOT NULL,      -- key without diacritics: what search compares
  name      TEXT    NOT NULL CHECK (name <> ''),  -- as typed
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  is_alias  INTEGER NOT NULL CHECK (is_alias IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX tag_names_primary ON tag_names (tag_id) WHERE is_alias = 0;
CREATE INDEX tag_names_tag  ON tag_names (tag_id, is_alias);  -- aliases of a tag; delete cascade
CREATE INDEX tag_names_fold ON tag_names (fold);

CREATE TABLE tag_parents (
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  parent_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, parent_id),
  CHECK (tag_id <> parent_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX tag_parents_parent ON tag_parents (parent_id, tag_id);

CREATE TABLE file_tags ( … same shape as today … );
```

Changes from v1 and why:

- `COLLATE NOCASE` is gone. It folds ASCII letters only: `Été` and `été` were two tags, `tag:ÉTÉ`
  found nothing, and free text `ete` found a file _named_ Été but not a file _tagged_ Été.
  Identity ignores case for every letter (`Été` = `été` = `ÉTÉ`) and
  keeps accents (`côte` and `côté` can both exist); search ignores accents (`tag:ete` finds `Été`);
  typing `Egypte` picks the existing `Égypte` when it is the only tag that matches without accents.
  The same function replaces `tagKey` in the export/import code. Known edges of the case rule,
  kept for simplicity: `Straße` and `STRASSE` are two tags, and so are the Turkish dotted `İ` and
  `i`; the Greek final sigma and the sigma are one letter.
- `tag_names_tag`: without it, reading a tag's aliases and deleting a tag scan the whole table
  (deleting 1,000 tags: 500 ms against 70 ms).
- `AUTOINCREMENT`: without it the id of a deleted tag goes to the next tag created, and the new
  calls (delete, merge) act by id.
- `kept`: see Cleanup.
- Invariant, tested after every repository operation: each tag has exactly one name row. Swapping a
  name and an alias is two statements (demote, then promote): one statement fails in one row order.
- `migrate()` refuses, in a plain sentence, a library made by a newer build; the main process shows
  it instead of restarting the indexer in a loop.
- The closure-table fallback is dropped: measured, it gains nothing (time goes to reading and
  sorting the files, not to walking the tags).

## Names

One `normalizeTagName` in `src/shared`, used by the tag input, the editor, the repository and every
import. A text that is compared with names and need not be one (a `tag:` term, free text, what is
typed for suggestions) goes through its first step only (`tagNameText`), without the checks. The
rule:

- NFC, runs of whitespace to one space, trimmed. Nothing special about `/`.
- Refused (`invalid`, with the reason): empty, or made only of characters nobody sees or of
  combining marks; control characters; a double quote; a comma; a leading `=`; more than 1,024
  characters or a run of more than 30 combining marks (so that no tag can exist that a tags export
  cannot hold).
- Characters nobody sees (Unicode's default ignorable code points: zero-width space and joiners,
  soft hyphen, word joiner, direction marks, variation selectors) are left out when two names are
  compared, by identity and by search alike, and a space counts no more for having one beside it.
  The name is stored as typed all the same, since some of them shape the letters around them
  (Persian, the scripts of India) or join emoji; only a byte order mark is removed, which
  JavaScript takes for whitespace, and whitespace is collapsed and trimmed through them. Blanks
  pasted as spaces (Hangul fillers, the blank Braille pattern) compare as a space. The two bidi
  overrides, which reorder the letters drawn, are refused. Accepted consequences: a heart in colour
  and the same heart as text are one tag, and so are a family emoji and its members side by side,
  and a Persian or Mongolian word with and without the character that shapes it. One exception:
  the tag characters of a well-formed flag stay, as they are all that tells the flags of England,
  Scotland and Wales apart. Free text leaves them out for the names of files and folders too, and
  also searches the text as typed, since a name on disk may hold one (a joined emoji).
- Why the comma: the `tag:` list splits on commas even inside quotes, so the chip of a tag named
  `Paris, France` searched "Paris or France" (this bug exists today, by pasting). One rule
  everywhere: a comma separates tags.
- Limits enforced in the repository: 100 aliases and 100 parents per tag (`limit`).
- A shared `tagTerm(name)` builds the query for chips; a test checks that every valid name survives
  chip → parse → lookup.
- Two tags cannot share a name. Convention for look-alikes, said in the search help:
  `Paris (Texas)`.

## Search

- `tag:France` — a name or alias equal to the term (ignoring case and accents), plus every tag
  below it. `tag:France,FR`, `-tag:France` as before.
- `tag:=France` — **new in v1**: files tagged France itself, not the tags below. It is the query for
  the first job after adding parents (find files tagged at country level to refine them to a city),
  and the compiler only leaves out the recursive part. `=` applies per item of a comma list.
- Free text — a name or alias _containing_ the text, plus every tag below. This is what the app
  does today for names (a path contains its ancestors' names), so answering "no" would lose
  something; results only shrink as letters are typed.
- The parser stops stripping `/` from tag terms.
- **Refresh.** v1 missed this: after adding France above Paris, a grid already showing `tag:France`
  did not change, because the renderer only searches again when files change. A new event
  (tag definitions changed) makes the grid search again when the query holds a `tag:` term or free
  text; other views (`is:untagged`) and the selection are left alone.

## A tag's life

**Cleanup.** A tag made only by tagging a file disappears with its last file, as today; a tag
made or edited on purpose (`kept = 1`: New tag, rename, alias, parent link on either side, merge
target, import definition) stays until deleted by hand. `/tags` gets an "Unused" filter.

**Operations** — one call per gesture, each one transaction, each returning
`{ ok: true, tag }` or `{ ok: false, error }` (a thrown error crosses the RPC as text only):

| Call                                               | Notes                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `createTag(name)`                                  | existing name → `taken`                                                                      |
| `renameTag(id, name)`                              | case-only change allowed; to its own alias → swap; old name kept as an alias only when asked |
| `addTagAlias(id, name)` / `removeTagAlias`         | own name → no-op; another tag's name → `taken` with the owner, and the editor offers Merge   |
| `addTagParent(id, parentName)` / `removeTagParent` | resolves a name or alias, creates the parent when unknown; `loop` names the tag in between   |
| `deleteTag(id)`                                    | see below                                                                                    |
| `mergeTags(fromId, intoId)`                        | see below                                                                                    |
| `getTagDetails(id)`                                | own file count, count with the tags below, tags below; numbers for confirmations             |
| `addTags(fileIds, names)`                          | now returns, per name: added, already there, or refused and why                              |

Errors: `gone` (deleted meanwhile), `busy` (an export is being written or an import applied),
`taken` (with the owning tag), `loop`, `invalid`, `limit`.

**Merge** (v1 had no rule; re-pointing rows stored a loop or failed on four ordinary cases):
refused with `loop` when one tag is above the other with a tag in between, in either direction;
otherwise the link between the two is dropped, files / parents / child tags move with
insert-or-ignore, the merged tag's name and aliases become aliases of the kept tag, the merged tag
is deleted. Confirmation: files moved, files that had both, "cannot be undone".

**Delete.** With a plain cascade, deleting France in Europe › France › Paris would leave Paris
top-level, and `tag:Europe` would stop finding Paris files. So child tags move up to the deleted
tag's parents (it cannot make a loop). The confirmation says: n files lose this tag (m are
missing from disk and will be forgotten); its aliases go; k child tags move up to X; those n files
are no longer found under X. TagStudio does the plain cascade. A delete that would leave a child
tag with more than 100 parent tags is refused (`limit`): the limit holds for every tag at all
times.

**While tags are exported or imported**: definition edits answer `busy`; tagging files stays
allowed.

**For the importers** (tags import, TagStudio, classification catalogue), in `TagsRepository`:
`resolve(names)` (writes nothing), one additive `applyDefinitions([{ name, aliases, parents }])`
with a dry run for previews, returning what it created, added and skipped and why, and
`attach(fileIds, tagIds)`. Loops in a bulk set: one linear pass finds groups of tags that would
loop; every imported link inside a group is skipped (checking link by link took 30 s for 8,000
links listed leaf-first).

## Tags export and import

Order changed: the format work comes **before** the interface, so no build can create what its
export cannot hold.

- `TAG_FILE_VERSION = 2` in the same pull request that makes tags plain names.
- Tag lines `{"tag", "aliases", "parents"}` before the file lines, for **every kept tag** (v1 said
  "tags with aliases or parents", which lost a tag made on purpose and not yet on a file). A line's
  kind comes from its keys; the end line counts `files` and `tags`; names are resolved once all
  lines are read; all tag lines are written from one read.
- An exported tag is: the tag its name resolves to here (name or alias); else the one tag all its
  aliases resolve to; else a new tag. Then only additions: free aliases, missing parent links.
  Files are compared by tag, not by written name (v1 would announce additions that add nothing).
- The preview lists what is added (tags, aliases, parent links), what is skipped and why (with the
  owning tag), tags known here under another name, and, for a link added to a tag that already has
  files, how many files newly match the parent.
- Export allowed when any tag exists (today: only when a file is tagged); a file holding only tag
  lines can be imported; an import that adds only aliases or links refreshes the app and says so.
- Version 1 files are refused with a truthful sentence ("made by an earlier version of SG Tag: it
  can no longer be imported"), and migration 3 clears the "Last exported" record. Reading them
  instead would take about 150 lines plus tests: each path would become a tag named by its whole
  path, under the path above it.

## Interface

- **One tag editor component**, keyed by tag id, applying each change at once. Shown inline in the
  details panel below the chips, and as the right-hand column of `/tags`. Not a popover on the chip
  as v1 said: the chip list is rebuilt on every tag change, which closes it, and the renderer specs
  (jsdom) cannot open popovers.
- First fix: in a multi-selection every tag change destroys and rebuilds all chips; make them keep
  their previous value while reloading.
- Fields: name, parent tags, child tags, aliases, counts (own / with the tags below), Delete.
  **Child tags are editable too**: open France, add twenty cities.
- Pickers behave like the tag input: a name, an alias (`Hexagone → France`), or `France: new tag`;
  the tag itself and the tags below it are shown disabled with the reason.
- Tag input: Tab no longer completes (its reason was `/`); matches names and aliases with the
  worker's own folding; exact match first, then prefix, then the rest; `Paname → Paris` adds Paris;
  an explicit last row `pari: new tag`; a tag the selection already has shows as
  `Paris: already added — Enter to edit`; placeholder "Add a tag". New spec file first (none
  exists).
- Keyboard path for "Paris is tagged; put France above it": T, `par`, ↓, Enter, Tab, `France`,
  Enter, Escape, ending in the tag input. Escape returns the focus to where it came from.
- Under the chips, one muted line: "Also found under: France (through Paris), Europe", each a
  button that searches. It explains a match made through a parent, and why removing France from a
  file tagged Paris does not take it out of `tag:France`.
- Confirmations use the existing inline pattern (Cancel focused, Escape cancels).
- `/tags`: a flat virtualised list sorted by name (name, parents, own count, "N tags below");
  filter box; "Unused" and "No parent" filters; arrows, Enter into the editor, Escape back; New
  tag; Merge into…; a shortcut matched on the character typed, handled at app level.
- `listTags` keeps own counts only (counts with the tags below for every tag: about 1 s).
- Words: **aliases**, **parent tags**, **child tags**, **the tags below it** (any depth). Never
  "sub-tag", "nested", "inherited".

## Delivery: four pull requests

1. `feat!:` **tags have names, aliases and parent tags.** Migration 3 and the `migrate()` guard;
   repository (operations, cleanup, merge, `resolve` and `attach`); name rule; parser and compiler
   with `tag:=`; events and `busy`; export/import by name, version 2, path mechanisms removed;
   renderer `path` → `name`, tag input placeholder and Tab; doc lines made false. Nothing can
   create an alias or a parent yet. No release.
2. `feat:` **the tags export carries aliases and parent tags.** `applyDefinitions`, tag lines,
   resolution rules, preview and result, export gates, search refresh (an import can change
   definitions alone). No release (nesting by `/` is gone with nothing in its place).
3. `feat:` **edit a tag from the details panel.** Editor, pickers, autocomplete on aliases, "Also
   found under", Delete, Merge offered when an alias is taken. First state worth a release: both
   needs are delivered.
4. `feat:` **the tags page.**

Each pull request passes `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
pnpm build` and changes the doc lines it makes false (no separate docs phase). Try builds with
`pnpm dev` (its own `.dev-data/`): `pnpm start` migrates the real library for good.

Size: 28 source files (about 6,600 lines) and 16 of the 37 spec files (6,300 of 9,950 spec lines)
change. The export/import code is the largest part: about 2,000 lines of worker code and 2,800 of
specs.

**The other two branches.** This plan's first pull request takes migration 3 and lands before
either writes tag code; they rebase onto it and use the bulk operation.

## Carried forward from the review of pull request 1

Pull request 1 was reviewed from seven areas, every finding re-checked. What was not fixed there
belongs to a later step:

**Settled in pull request 2**

- The format stays version 2 (never released without tag lines). A tag line is
  `{"tag", "aliases"?, "parents"?}`, empty lists left out; the end line counts `tags` too, and may
  leave it out when there is no tag line.
- `TagsRepository.applyDefinitions(definitions, dryRun)` works everything out in memory, then
  writes unless `dryRun`: the preview and the import run the same code. A parent tag named by no
  definition and no tag is made only if one of its links is kept.
- "Known here under another name" also covers a tag found through its exported name being an alias
  here (Paris, an alias of Lutetia), not only through its aliases.
- The number of files a link newly makes a parent find is worked out for the first 100 links listed,
  on the library's links as they are before the import.
- `TagImportAdditions.newTags` no longer counts the tags that the tag lines make
  (`TagDefinitionCounts.created`), so the interface adds the two.

**Settled in pull request 3**

- Two worker calls for the editor: `addTagChild` (`addTagParent` seen from the parent, making the
  child when no tag has its name) and `getMergePreview` (files moved, files that had both, and the
  refusal the merge would answer, from the same checks as the merge).
- The editor is a component keyed by tag id, independent of the selection; the details panel closes
  it when the selection changes. Pickers are the tag input with tags shown disabled and their reason.
- The delete confirmation does not say how many files the parent tags stop finding: `TagDetails`
  cannot tell whether such a file has another tag below them, so the number could be false.

**Settled in pull request 4**

- Listing tags keeps the place of each tag in the order of names and sorts again only after a
  rename, or when a tag is new to it: 5,000 tags list in about 10 ms instead of 30, 20,000 in
  about 45 ms instead of 150 (the rest is reading the rows).
- The merge preview says itself what the tag that goes brings: its aliases, and how many parent
  and child tags it has besides the tag kept.

**Outside this plan** (older than it, found on the way)

- A library that cannot be opened for any reason other than "made by a newer version" leaves the
  indexer running and silent: no message, and the window waits for ever.
- Three kinds of pasted search text make a search throw (a NUL character, one term longer than
  50,000 bytes, more than about 1,000 terms), and a pasted run of tens of thousands of combining
  marks holds the search for seconds.
- An export of more than 1,000,000 distinct tags is saved although its import refuses it.
- Free text that matches tens of thousands of tags is 1.2 to 1.3 times slower than before: the
  price of also finding the files of the tags below.
- A hyphen pasted from Word or a web page (U+2010, or the non-breaking U+2011) is drawn as `-` and
  makes another tag: `Saint-Tropez` can exist three times. Not a character nobody sees, so outside
  that rule; folding look-alike punctuation would be a rule of its own.
- A file whose own name holds a character nobody sees (`Ber`, a soft hyphen, `lin.jpg`) is not found
  by `Berlin`: that needs an index of names without them.

## For the TagStudio import

Moved to its own plan, `tagstudio-import.md`.

## Not in v1

Colours and categories; showing inherited tags as chips; a tree view or drag and drop; selecting
several tags on `/tags`; matched tags in the status bar; refusing a parent that is already above
through another tag.

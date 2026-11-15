# Tags from a classification catalogue

The plan for turning the catalogue that the `media-classification` skill writes, a CSV file, into
tags: one file at a time from the details panel, or all at once through the preview and import that
tags exports and TagStudio libraries already have. Experimental. Decided on 2026-11-15, with parent
tags and aliases and the TagStudio import on `master`. Delete this file once its pull request has
landed.

Facts below come from the author's latest catalogue (`media_catalog_5770_updated.csv`: 5,770 rows,
72 columns, UTF-8 with a byte order mark, no line break inside a field) read against their library,
both read-only.

## Settled

1. **A file's subcategory is its tag, and its category is the parent tag of that subcategory.**
   Files carry one subject tag; `tag:<category>` finds the files of all its subcategories through
   the link. No tag above the categories.
2. **Labels come in as the catalogue writes them.** Renaming is done in SG Tag: a tag renamed with
   "Keep … as an alias", or merged into another, is found again by its old name on the next import.
   No mapping table.
3. **The import leaves out, by default**, rows of low confidence, rows marked `Needs further review`
   = `True`, and the category "Needs context or audio review", each with a checkbox to include it.
   In the real catalogue that is 35, 757 and 34 rows: 5,003 of 5,770 remain, in 19 categories and 45
   subcategories.
4. **Format tags** (`Format and secondary tags`): the import gives a file one only when a tag of the
   library has that name or alias, and never makes one. Its preview lists the most frequent labels
   left out, as candidates. The details panel offers every one, and adding one there makes it.
   (801 labels on 751 files, 615 of them on one file; 8 are names of tags the library has.)
5. **"Add all" in the details panel ignores the import's filters**: the user decides by eye.

## What a catalogue gives

| Column                                                             | Use                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `Source path`                                                      | required: the file, by its absolute path on this computer |
| `Suggested category`, `Subcategory`                                | required: tags, the subcategory below the category        |
| `Original size bytes`, `Original mtime nanoseconds`                | finding the file (see Finding files)                      |
| `Format and secondary tags`                                        | format tags, separated by `;`                             |
| `Confidence in category`, `Needs further review`                   | the import's filters                                      |
| `Topic detail`, `Visible content`, `Review notes`, `Review status` | shown in the details panel, never tags                    |
| every other column                                                 | not read                                                  |

Columns are found by their header, as the skill writes it. A file without the three required
columns is refused, saying which one is missing. An empty `Needs further review` (older rows) is not
`True`.

## Reading it

- `src/worker/catalogue/catalogue-file.ts` reads CSV as RFC 4180 has it: quoted fields, doubled
  quotes, line breaks inside quotes, CRLF or LF; a byte order mark is dropped. UTF-8 only: a file
  that is not valid UTF-8 is refused.
- Refused above 256 MiB (the real one is 7.6 MB) or 1,000,000 rows. A row without a path, with a
  path that is not absolute or holds a `..` segment, without a category or subcategory, or with a
  field longer than 32,767 characters, is left out and counted, the first few named by row number
  without quoting the file, as tags exports do.
- Read a slice at a time (`Slicer`), so that the indexer keeps answering searches. Only the columns
  used are kept.
- A label SG Tag refuses as a tag name is rewritten as the TagStudio import rewrites one (`rewrite`:
  a comma becomes a space, a double quote a single quote, a leading `=` and control characters go),
  each rewrite counted; one still refused is left out. None in the real catalogue.
- The catalogue is kept in memory by the indexer: read when chosen, when the indexer starts, and
  again when its size or modification time changed, checked when a file's row is asked for. One
  that can no longer be read stays chosen, and Settings says why.
- Nothing in it is opened or run: its paths are only looked up in the index, its text only shown.

## Finding files

A row is the file:

1. at its path in the index, present or missing from disk, when its size and date agree (the date
   within `MTIME_TOLERANCE_MS`, as the indexer compares them), or when the row gives neither:
   `samePlace`;
2. at its path, with another size or date: `changed`. The import tags it only with its changed files
   (the existing checkbox), and the details panel says "Changed since it was classified";
3. else the one file on disk in the library folders with its name, size and date: `moved`; several:
   `ambiguous`. This finds files after they were sorted into the catalogue's suggested folders. The
   TagStudio import takes a file by its name alone; the size and date make this stricter;
4. else `notMedia` (SG Tag indexes only images and videos), `folder` (outside every library folder)
   or `notFound`.

`catalogue-matcher.ts`, on the model of `tagstudio-matcher.ts`, gives the importer its `MatchResult`
from the index alone; no file is read. The details panel asks the same question the other way round
(which row is this file?) through the same rules: a row found by name belongs to a file only when no
file is at the row's path. In the real catalogue, 5,766 rows are found at their path with their size
and date; 4 are not found.

## Details panel

- A "Classification" section below the tags, for one selected file that a row is found for. None for
  a multi-selection, or a file the catalogue does not list.
- It shows category › subcategory, the confidence, topic detail, visible content and review notes,
  and says when the row is flagged for further review, when the file changed since it was
  classified, and where the file was when it was found elsewhere.
- Suggested tags: the subcategory, with its category beside it, then the format tags. Each is a
  button that adds it; "Add all" adds those not added yet. A suggestion that is the name or an alias
  of a tag the file has shows as added, so a renamed tag still counts.
- Adding the subcategory also makes its category its parent tag (`applyDefinitions` with the two,
  then `attach`): a file tagged from the panel and one tagged by the import are alike. A format tag
  is added as the tag input adds a tag (`addTags`): made by tagging a file, it goes with its last
  file.
- Worker calls: `getCatalogueEntry(fileId)` answers the row (or `null`) and which suggestions are
  added; `addCatalogueTags(fileId, names)` answers per name, as `addTags` does. Events:
  `tagsChanged`, and `tagDefinitionsChanged` when a tag or a link was made.
- Keyboard: the buttons follow the tag input in the tab order. No new shortcut.

## Import

- Settings → Tags: "Import from catalogue…", beside Import from TagStudio…, disabled until a
  catalogue is chosen. It opens the preview of a tags import at once: the catalogue is already read.
- `TagImportKind` gains `catalogue`. `TagImporter.openCatalogue(filters)` builds a `ParsedTagFile`
  from the catalogue in memory: one library folder (the deepest folder holding every row), each kept
  row an entry with its size, date and tags, and a definition for each category and each
  subcategory, below its category, that the kept rows use. `plan` uses `matchCatalogueEntries`.
- Format tags: `plan` keeps those whose name is a tag here (`resolve`) and counts the rest; `apply`
  looks each up again and skips one that no longer names a tag, so the import never makes one.
- The preview's three filter checkboxes open the catalogue again with the new filters and plan again.
- Besides what any import says, the preview says (`TagImportSource.catalogue`): rows read, rows left
  out by each filter, unreadable rows, labels rewritten, and format labels without a tag: how many,
  on how many files, and the 20 most frequent with their file counts.
- Importing again adds nothing.

Expected on the author's library: 19 categories and 45 subcategories made, 45 parent links, about
5,000 files tagged, and format tags only on the few files with the 8 labels the library already has.

## Settings

- Its own section, "Classification catalogue", after Tags: experimental, the chosen file's path,
  how many files it classifies and the rows it could not read, Choose catalogue… (Choose another…
  once one is chosen) and Stop using it.
- Choose… opens a file dialog (CSV files) in the main process, as the other imports do; the indexer
  reads the file and only then remembers it. A file that is not a catalogue is refused with the
  reason, and the catalogue chosen before stays.
- Remembered in the `settings` table under its own key, as `lastTagExport` is, not as a `Settings`
  preference.
- `WorkerHostApi.openCatalogue(path)` (main, after the dialog); `LibraryApi.getCatalogue()` and
  `forgetCatalogue()`; the event `catalogueChanged` when one is chosen, forgotten or read again.

## Words

**Classification catalogue** in full where it is first named, then **catalogue**; **category**,
**subcategory** and **format tags**, as the skill calls them. Added to the terminology in
`PRODUCT.md`.

## Delivery

One pull request from `feat/classification-tags`, rebased onto `master`, in two commits:

1. `feat: show a file's classification and add its tags`: reading, finding a file's row, Settings,
   the details panel.
2. `feat: import tags from a classification catalogue`: the import kind, its matcher, the preview.

Each passes `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` and changes
the doc lines it makes false (`PRODUCT.md`, `README.md`). Try builds with `pnpm dev`; run the import
on a copy of the real `library.db` and compare with the numbers above.

## Not in this plan

- Location, people and AI-origin tags (`Subject location tags`, `People tags`…), which this
  catalogue has none of: once one has them, read accepted tags only, never candidates.
- Several catalogues at once, or picking the latest of a folder of checkpoints.
- Classification for a multi-selection.
- Keeping tags in step with a revised catalogue: the import only adds.
- `Category code` (`P5`) as aliases: the codes mean nothing outside the catalogue.
- Undoing an import.

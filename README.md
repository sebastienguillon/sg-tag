<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg" />
    <img alt="SG Tag" src="docs/brand/lockup-light.svg" height="64" />
  </picture>
</h1>

Tag and retrieve the images and videos on your computer, fast. macOS, Windows and Linux.

- Indexes every image and video below the library folders you choose, and keeps the index live.
- Virtualised thumbnail grid with adjustable size; the type of each file is shown on its tile.
- Videos play in the details panel when Chromium can decode them (H.264, VP9, AV1, and HEVC where
  the platform decodes it); Open hands any other format to the system player.
- Search filters on every keystroke: names, folders, tags, and operators (`tag:`, `type:`, `ext:`,
  `size:`, `in:`, `is:`). Press `?` in the search field for the syntax.
- Tags are plain names (`Japan 2024`, `Ana`). Letter case never distinguishes two tags, accents do,
  and search ignores both: `tag:ete` finds the files tagged `Été`. Characters nobody sees, such as
  a zero-width space pasted from a web page, never distinguish two tags either.
- Tags can have aliases and parent tags: put `Paris` below `France`, and `tag:France` also finds
  the files tagged Paris (`tag:=France` finds France itself only). Edit a tag from the details
  panel: the pencil next to it, or Enter on “already added” in the tag input.
- All your tags on one page (Tags in the toolbar, or ⌘/Ctrl-Shift-T): filter them by name or alias,
  list the unused ones or those without a parent, make new ones, and edit the one you pick.
- Finds identical files (Find duplicates in the toolbar, `is:duplicate`): give the copies the same
  tags, or move the ones you do not need to the Trash.
- **Files are never modified.** Tags live in the app's own database (see [Tags and files](#tags-and-files)).
  The only change made on disk is moving a duplicate to the Trash when you ask. Besides that, the
  only file it writes is a tags export, where you choose.

## Requirements

- Node.js 24 (see `.nvmrc`) and pnpm 12. The exact pnpm version is pinned in `package.json`
  (`packageManager`); pnpm switches to it by itself.
- `ffmpeg` and `ffprobe` for video thumbnails and metadata. In development, the ones on the `PATH`
  are used (e.g. `brew install ffmpeg`). For packaged builds, place them in `resources/bin/<mac|win|linux>/`.
  Without them, macOS and Windows fall back to the system thumbnailer.

## Scripts

| Command                                | What it does                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm dev`                             | Angular dev server + Electron: UI edits reload live, Electron-side edits restart the app |
| `pnpm start`                           | Production build, then run it **on your real library**                                   |
| `pnpm build`                           | Renderer (Angular CLI) and Electron side (esbuild) into `dist/`                          |
| `pnpm package[:dir]`                   | Installers (or an unpacked app) in `release/`                                            |
| `pnpm test`                            | Renderer tests (`ng test`, Vitest) and Electron-side tests (Vitest)                      |
| `pnpm test:renderer` / `test:electron` | One half of `pnpm test`                                                                  |
| `pnpm lint` / `typecheck`              | ESLint (type-aware, both sides) / every TypeScript project                               |
| `pnpm lint:fix`                        | ESLint, applying its automatic fixes                                                     |
| `pnpm format` / `format:check`         | Prettier: rewrite files / only report them, as CI does                                   |

`pnpm dev` keeps its own data folder in `.dev-data/` and serves the UI on port 4317; quitting the
app, or Ctrl-C in the terminal, ends the session. `pnpm start` uses the installed app's data folder,
with your real tags. `SG_TAG_USER_DATA` points either command at another data folder
(`SG_TAG_USER_DATA=.dev-data pnpm start`), and `SG_TAG_DEV_PORT` changes the port.

A library last opened by version 2026.10.0-alpha.3 or earlier loses all its tags the first time a
later version opens it, and the tags exports made by those versions can no longer be imported. There
is no way back: those versions can no longer use a library a later one has opened. So copy the data
folder before `pnpm start` opens such a library, or use `pnpm dev` or `SG_TAG_USER_DATA` instead.

Electron-side tests run on Electron's own Node runtime, so native addons are tested exactly as they
ship.

## Architecture

```
Renderer (Angular 22)  ──MessagePort──▶  Indexer (Electron utility process)
  search, grid, tags                       SQLite + FTS5, scanner, watcher, thumbnails
        │  thumb://, app://, ipc                   ▲
        ▼                                          │ parent port
Main process: window, protocols, dialogs, shell ───┘
```

- **Indexer** (`src/worker`): owns the database (`better-sqlite3`, WAL, trigram FTS5), crawls roots
  (`fdir`), follows changes (`@parcel/watcher`), renders thumbnails (`sharp`, `ffmpeg`) into a WebP
  cache. Nothing heavy runs in the main process or the renderer.
- **Renderer** (`src/renderer`): standalone components, signals, zoneless, OnPush (the v22
  default). The grid is CDK-virtualised by rows; tiles fetch their data lazily. Searches are
  "latest wins": one in flight, intermediate keystrokes collapsed.
- **Main** (`src/main`): serves the renderer over `app://` (strict CSP), thumbnails over `thumb://`
  (falling back to QuickLook / Windows Shell thumbnails for HEIC, RAW…), restarts the indexer if it
  crashes.
- **Shared contracts** (`src/shared`): typed RPC and the domain model. ESLint enforces that layers
  only meet there.

## Tags and files

Tags are stored only in `library.db` in the app data folder (shown in Settings). Files stay
byte-identical, which also means:

- **Back up your tags**: they exist only in the data folder. Settings → **Export tags…** saves them
  to a file you choose; **Import tags…** adds them back, on this computer or another.
- Tags are not visible to other apps or machines, except through a tags export.
- Files renamed or moved outside the app, within or between library folders, stay the same file
  (tags, thumbnail): they are recognised by device + inode (same volume) or by a content fingerprint
  (another volume). A tagged file that disappears is kept as missing (`is:missing`) until it is
  found again; an untagged one is forgotten after 30 minutes. When the new path is noticed before
  the deletion (a move to another drive is a copy, then a deletion), the deletion must follow within
  30 minutes. Among identical files, the one with the most similar name and folders is taken.
- Identical copies are found in steps: same size (no reading), same fingerprint (first and last
  64 KiB), then the same SHA-256 of the whole file. Only the last step reads whole files, and only
  for likely copies; what was read is kept until a file changes. A link to a file (hard or symbolic)
  is the same file, not a copy. Before a copy goes to the Trash, the app checks that another copy is
  still on disk, unchanged, and gives it the copy's tags; if the copy cannot be trashed after all,
  those tags are taken back.
- Folders on drives that are not connected are marked offline; their files and tags are kept, and
  their cached thumbnails stay browsable.

### Exporting and importing tags

A tags export describes every tag you made or edited on purpose, with its aliases and parent tags,
even when no file has it, and lists every tagged file, including missing ones and those on drives
that are not connected, with its tags. The only tags it leaves out are those past 1,000 on one file:
Settings says how many. Importing it adds the tags it describes and the aliases and parent tags they
lack: a tag known in your library under another name gets the exported name as an alias, and an
alias that another tag already has, or a parent tag that would put a tag below itself, is left out
and listed. A tags export holds up to 256 MiB, about 670,000 tagged files with long paths and
near a million with short ones, and lists every library folder whatever its path, up to 10,000 of
them (tens at the longest paths a computer takes): Export tags… refuses a larger one rather than
save a file that Import tags… would refuse. A tags export made by an earlier version of SG Tag
(version 1 of the format) can no longer be imported. Importing a tags export shows what it would add
before writing anything, only ever adds tags, and can be repeated: tags already there are skipped,
and the library's own spelling of a tag wins. A file is recognised by its content (same size and
fingerprint, or same name, size and modification time), even if it was renamed, moved, or its
library folder has another path on this computer; a file at the very same path whose content changed
since keeps its tags, as when the app follows it, unless most files around it changed too. Files not
found are listed with the reason, and their tags are not imported: add their folder or connect their
drive, then import the same tags export again. Tags removed on one computer come back when importing
from another that still has them. Importing does not look for duplicates; use Find duplicates. If
saving an export fails part way, the file is removed rather than left cut short, so an earlier
export of the same name is lost: the default name carries the date to avoid that.

### Importing from TagStudio

Settings → **Import from TagStudio…** brings the tags of a [TagStudio](https://github.com/TagStudioDev/TagStudio)
library into SG Tag: choose the library's folder (or its `.TagStudio` folder). As with a tags
export, it shows what it would add before writing anything, only ever adds tags, and can be
repeated. TagStudio libraries saved by TagStudio 9.5 and later are read (`ts_library.sqlite`,
database versions 6 to 499); one still in TagStudio 9.4's format must be opened once in a recent
TagStudio, which converts it. SG Tag reads a copy of the database, made in its data folder and
deleted once read, so TagStudio may stay open and its library is never changed.

- Tag names, aliases, shorthands (as aliases) and parent tags come over. Tags with one name and the
  same parent tags become one tag; with other parent tags, `Name (Parent)`. A comma, a double
  quote, a leading `=` or a control character, which a name here cannot hold, is rewritten (a
  comma becomes a space, a double quote a single quote), and each name written otherwise is listed.
- A file is found at its path below the library's folder, or else, as TagStudio's "Fix Unlinked
  Entries" relinks it, as the one file of that name below it; when another TagStudio entry is at
  that file's path, the file gets the tags of both. Files TagStudio lists that SG Tag does not
  index (not images or videos), and files of a name several files have, are listed and not tagged.
- Not carried over, and counted: colours, icons, categories, the hidden setting (hidden tags come
  over as ordinary tags), fields, and the built-in tags Archived and Favorite when no file has
  them, and Meta Tags.

### Tags from a classification catalogue (experimental)

The `media-classification` skill writes a catalogue of the images and videos it classifies: a CSV
file with one row per file. Choose it in Settings → **Classification catalogue**; SG Tag remembers
it, reads it again when it changes, and never writes it. The details panel then shows, for one
selected file, what the catalogue says of it (category and subcategory, confidence, topic, visible
content, review notes) and suggests its tags: each is added with its own button, or all at once
with **Add all**.

- The subcategory is the tag a file gets, with its category as its parent tag, so `tag:<category>`
  finds the files of all its subcategories. Format tags (`Format and secondary tags`) are plain tags.
- Labels come in as the catalogue writes them. Rename a tag with "Keep … as an alias", or merge two,
  and the catalogue's label still names it. A label a tag name cannot hold (a comma, a double
  quote, a leading `=`) is rewritten, as the TagStudio import does.
- A file is the one at the catalogue's `Source path`, or, once moved, the one file in the library
  folders with its name, size and date (`Original size bytes`, `Original mtime nanoseconds`). A file
  found at its path with another size or date is said to have changed since it was classified.
- Required columns: `Source path`, `Suggested category` and `Subcategory`. Also read when there:
  `Original size bytes`, `Original mtime nanoseconds`, `Format and secondary tags`,
  `Confidence in category`, `Needs further review`, `Review status`, `Topic detail`,
  `Visible content` and `Review notes`. UTF-8, up to 256 MiB.

Settings → **Import from catalogue…** then tags every file the catalogue lists at once. As with a
tags export, it shows what it would add before writing anything, only ever adds tags, and can be
repeated.

- Each file gets its subcategory, below its category. Rows of low confidence, rows marked
  `Needs further review`, and the category "Needs context or audio review" are left out unless
  their checkbox in the preview includes them.
- A format tag is given only when a tag of the library already has its name, as its name or an
  alias: the import never makes one. The preview lists the most frequent left out; make a tag of
  one (or give its label to a tag as an alias) and import again to add it.
- Files found at their path with another size or date are tagged only if the import includes the
  files that changed.

### Tags export format

UTF-8 [JSON Lines](https://jsonlines.org): a header (`format: "sg-tag/tags"`, `version: 2`, `app`,
`exportedAt`, `platform`, `fingerprint` scheme, `roots`), one line per tag made or edited on
purpose (`tag`, and `aliases` and `parents` when it has any), one line per tagged file (`root`,
`rel`, `path`, `size`, `mtimeMs`, `fingerprint`, `sha256`, `missing`, `tags`), then
`{"end":true,"files":N,"tags":M}`. Fields may be added within a version; readers should ignore
fields they do not know. For example,
`jq -c 'select(.rel) | {path, tags}' "SG Tag tags 2026-10-19.jsonl"` lists each file with its tags.

```
{"format":"sg-tag/tags","version":2,"app":"2026.10.0-alpha.1","exportedAt":"2026-10-19T08:30:00.000Z","platform":"darwin","fingerprint":"sha256(size,head64k,tail64k)/32","roots":[{"path":"/Users/seb/Pictures"},{"path":"/Volumes/Archive"}]}
{"tag":"Japan 2024","aliases":["Nihon 2024"],"parents":["Trips"]}
{"tag":"Trips"}
{"root":0,"rel":"2024/Japan/IMG_1234.JPG","path":"/Users/seb/Pictures/2024/Japan/IMG_1234.JPG","size":4718233,"mtimeMs":1717171717000,"fingerprint":"9f86d081884c7d659a2feaa0c55ad015","sha256":null,"missing":false,"tags":["Ana","Japan 2024"]}
{"root":0,"rel":"2023/beach.mov","path":"/Users/seb/Pictures/2023/beach.mov","size":81234567,"mtimeMs":1690000000000,"fingerprint":"0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","missing":true,"tags":["family"]}
{"root":1,"rel":"Scans/1998/scan-0001.tif","path":"/Volumes/Archive/Scans/1998/scan-0001.tif","size":31457280,"mtimeMs":1012345678000,"fingerprint":null,"sha256":null,"missing":false,"tags":["family","grandparents"]}
{"end":true,"files":3,"tags":2}
```

## Releasing

Versions follow calendar versioning, `YYYY.M.PATCH` (no zero-padding, PATCH restarts at 0 each
month), with `-alpha.N` / `-beta.N` suffixes before a stable release.

1. Set `version` in `package.json`, commit it as `chore(release): <version>`.
2. Tag that commit `v<version>` (annotated) and push the branch and the tag.
3. The **Release** workflow checks the tag against `package.json`, runs CI, builds the installers
   on macOS, Windows and Linux, and attaches them to a **draft** GitHub release (marked as a
   pre-release for `-alpha`/`-beta` versions).
4. Review the draft and its notes on GitHub, then publish it.

To try packaging without releasing, run the **Release** workflow manually on a branch
(`gh workflow run release.yml --ref master`): the installers are kept as workflow artifacts for a
week.

## Conventions

Conventional Commits, enforced by commitlint. Git hooks are managed by lefthook and installed by
`pnpm install`: ESLint and Prettier on staged files before each commit, and type checks plus tests
before each push.

CI runs on every push to `master` and on pull requests: workflow lint (actionlint), format, lint
and type checks, then tests and a build on Linux, macOS and Windows.

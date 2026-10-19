# SG Tag

Tag and retrieve the images and videos on your computer, fast. macOS, Windows and Linux.

- Indexes every image and video below the library folders you choose, and keeps the index live.
- Virtualised thumbnail grid with adjustable size; the type of each file is shown on its tile.
- Videos play in the details panel when Chromium can decode them (H.264, VP9, AV1, and HEVC where
  the platform decodes it); Open hands any other format to the system player.
- Search filters on every keystroke: names, folders, tags, and operators (`tag:`, `type:`, `ext:`,
  `size:`, `in:`, `is:`). Press `?` in the search field for the syntax.
- Hierarchical tags (`trips/2024/japan`). Searching `tag:trips` includes everything below it.
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

A tags export lists every tagged file, including missing ones and those on drives that are not
connected, with its tags. Tags it cannot hold are left out: longer than 1,024 characters, nested
more than 64 levels deep, with more than 30 combining marks in a row, or past 1,000 on a file.
Settings says how many, and a file left with none is not listed. A tags export holds up to 256 MiB,
about 670,000 tagged files with long paths and near a million with short ones, and lists every
library folder whatever its path, up to 10,000 of them (tens at the longest paths a computer takes):
Export tags… refuses a larger one rather than save a file that Import tags… would refuse. Importing
a tags export shows what it would add before writing anything, only ever adds tags, and can be
repeated: tags already there are skipped, and the library's own spelling of a tag wins. A file is
recognised by its content (same size and fingerprint, or same name, size and modification time),
even if it was renamed, moved, or its library folder has another path on this computer; a file at
the very same path whose content changed since keeps its tags, as when the app follows it, unless
most files around it changed too. Files not found are listed with the reason, and their tags are not
imported: add their folder or connect their drive, then import the same tags export again. Tags
removed on one computer come back when importing from another that still has them. Importing does
not look for duplicates; use Find duplicates. If saving an export fails part way, the file is
removed rather than left cut short, so an earlier export of the same name is lost: the default name
carries the date to avoid that.

### Tags export format

UTF-8 [JSON Lines](https://jsonlines.org): a header (`format: "sg-tag/tags"`, `version`, `app`,
`exportedAt`, `platform`, `fingerprint` scheme, `roots`), one line per tagged file (`root`, `rel`,
`path`, `size`, `mtimeMs`, `fingerprint`, `sha256`, `missing`, `tags`), then
`{"end":true,"files":N}`. Fields may be added within a version; readers should ignore fields they do
not know. For example, `jq -c 'select(.tags) | {path, tags}' "SG Tag tags 2026-10-19.jsonl"` lists
each file with its tags.

```
{"format":"sg-tag/tags","version":1,"app":"2026.10.0-alpha.1","exportedAt":"2026-10-19T08:30:00.000Z","platform":"darwin","fingerprint":"sha256(size,head64k,tail64k)/32","roots":[{"path":"/Users/seb/Pictures"},{"path":"/Volumes/Archive"}]}
{"root":0,"rel":"2024/Japan/IMG_1234.JPG","path":"/Users/seb/Pictures/2024/Japan/IMG_1234.JPG","size":4718233,"mtimeMs":1717171717000,"fingerprint":"9f86d081884c7d659a2feaa0c55ad015","sha256":null,"missing":false,"tags":["people/Ana","trips/2024/japan"]}
{"root":0,"rel":"2023/beach.mov","path":"/Users/seb/Pictures/2023/beach.mov","size":81234567,"mtimeMs":1690000000000,"fingerprint":"0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","missing":true,"tags":["family"]}
{"root":1,"rel":"Scans/1998/scan-0001.tif","path":"/Volumes/Archive/Scans/1998/scan-0001.tif","size":31457280,"mtimeMs":1012345678000,"fingerprint":null,"sha256":null,"missing":false,"tags":["family/grandparents"]}
{"end":true,"files":3}
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

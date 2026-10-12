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
  The only change made on disk is moving a duplicate to the Trash when you ask.

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

- **Back up the data folder**: it is the only copy of your tags.
- Tags are not visible to other apps or machines.
- Files renamed or moved outside the app, within or between library folders, stay the same file
  (tags, thumbnail): they are recognised by device + inode (same volume) or by a content fingerprint
  (another volume), whether the new path or the deletion is noticed first. A tagged file that
  disappears is kept as missing (`is:missing`) until it is found again; an untagged one is forgotten
  after 30 minutes.
- Identical copies are found in steps: same size (no reading), same fingerprint (first and last
  64 KiB), then the same SHA-256 of the whole file. Only the last step reads whole files, and only
  for likely copies; what was read is kept until a file changes. Before a copy goes to the Trash,
  the app checks that another copy is still on disk, unchanged, and gives it the copy's tags.
- Folders on drives that are not connected are marked offline; their files and tags are kept, and
  their cached thumbnails stay browsable.

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

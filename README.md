# SG Tag

Tag and retrieve the images and videos on your computer, fast. macOS, Windows and Linux.

- Indexes every image and video below the library folders you choose, and keeps the index live.
- Virtualised thumbnail grid with adjustable size; the type of each file is shown on its tile.
- Search filters on every keystroke: names, folders, tags, and operators (`tag:`, `type:`, `ext:`,
  `size:`, `in:`, `is:`). Press `?` in the search field for the syntax.
- Hierarchical tags (`trips/2024/japan`). Searching `tag:trips` includes everything below it.
- **Files are never modified.** Tags live in the app's own database (see [Tags and files](#tags-and-files)).

## Requirements

- Node.js 24 (see `.nvmrc`) and pnpm 12. The exact pnpm version is pinned in `package.json`
  (`packageManager`); pnpm switches to it by itself.
- `ffmpeg` and `ffprobe` for video thumbnails and metadata. In development, the ones on the `PATH`
  are used (e.g. `brew install ffmpeg`). For packaged builds, place them in `resources/bin/<mac|win|linux>/`.
  Without them, macOS and Windows fall back to the system thumbnailer.

## Scripts

| Command                   | What it does                                                             |
| ------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev`                | Angular dev server + Electron, restarted when Electron-side code changes |
| `pnpm start`              | Production build, then run it                                            |
| `pnpm build`              | Renderer (Angular CLI) and Electron side (esbuild) into `dist/`          |
| `pnpm package[:dir]`      | Installers (or an unpacked app) in `release/`                            |
| `pnpm test`               | Renderer tests (`ng test`, Vitest) and Electron-side tests (Vitest)      |
| `pnpm lint` / `typecheck` | ESLint (type-aware, both sides) / every TypeScript project               |

`pnpm dev` uses a separate profile in `.dev-data/` and port 4317 (`SG_TAG_USER_DATA`,
`SG_TAG_DEV_PORT` override them). Electron-side tests run on Electron's own Node runtime, so native
addons are tested exactly as they ship.

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
- Files renamed or moved outside the app keep their tags: they are recognised by device + inode
  (same volume) or by a content fingerprint (another volume). A tagged file that disappears is kept
  as missing (`is:missing`) until it is found again.
- Folders on drives that are not connected are marked offline; their files and tags are kept, and
  their cached thumbnails stay browsable.

## Conventions

Conventional Commits, enforced by commitlint. Git hooks are managed by lefthook and installed by
`pnpm install`: ESLint and Prettier on staged files before each commit, and type checks plus tests
before each push.

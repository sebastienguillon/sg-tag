# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The author, first: SG Tag is a personal tool for tagging and finding the images and videos in their
own folders. A free, open-source (MIT) public release is planned, so other people who keep their
media in local folders will use it later; no outside users exist yet.

## Product Purpose

Tag and retrieve local images and videos, fast. SG Tag indexes every image and video below the
library folders the user picks, keeps that index live, and lets them find any file in a moment by
name, folder, tag or property, then tag one file or many at once.

Success: finding a file or a set of files takes seconds, tagging is quick enough to do as a habit,
and nothing about the files on disk changes unless the user asks to trash a duplicate.

## Positioning

Four commitments define SG Tag, and future work must not trade any of them away:

- **Files are never modified.** Tags live only in the app's own database (`library.db` in the data
  folder): no sidecar files, no metadata written into files. The one change SG Tag makes on disk is
  moving a duplicate to the Trash, when the user asks, after checking that an identical copy stays
  on disk and giving it the duplicate's tags.
- **Speed.** Search filters on every keystroke, and stays instant on large libraries.
- **Folders as they are.** No import and no managed library: SG Tag indexes existing folders in
  place, watches them, and adapts to the file system rather than reorganising it. A file renamed or
  moved outside the app, within or between library folders, stays the same file (same tags and
  thumbnail); tagged files that disappear are kept as missing; folders on disconnected drives stay
  browsable as offline.
- **Keyboard-first.** Searching, selecting, tagging and navigating all work without the mouse.

## Operating Context

- Desktop app (Electron) for macOS, Windows and Linux. The interface is rendered as a web page, with
  desktop conventions: macOS inset title bar, platform names for "Show in Finder" / "Show in
  Explorer", the system light or dark appearance.
- Libraries are ordinary folders, including external drives and network shares that come and go.
- Video thumbnails and metadata use `ffmpeg`/`ffprobe` when present; macOS and Windows fall back to
  the system thumbnailer without them.
- The data folder (shown in Settings) holds the only copy of the tags, so users must back it up.
  Tags are not visible to other apps or machines.
- Status: alpha (2026.10.0-alpha.1), released through GitHub.

## Capabilities and Constraints

- Thumbnail grid with adjustable tile size, sorted by date modified, name or size; each tile shows
  the file type.
- Details panel (resizable) for the selected file: preview, metadata, location, Open and Show in
  Finder/Explorer; tag editing for one file or a multi-file selection, showing partial tags as
  `n/total`.
- Duplicates: files with byte-identical content. Find duplicates checks the whole library on
  request, and tagging a file checks it; `is:duplicate` lists them side by side. The details panel
  lists a file's identical copies, can give all copies the same tags, and moves a chosen copy to the
  Trash. Checks compare size, then a fingerprint, and read whole files only for likely copies.
- Video preview: the details panel plays a video in place, on request, when Chromium decodes it
  (H.264, VP9, AV1, and HEVC where the platform decodes it, in MP4, MOV, MKV or WebM). Guardrail:
  **SG Tag previews; real playback belongs to the system player.** No transcoding and no player
  features beyond the built-in controls; other formats go to Open.
- Hierarchical tags separated by `/` (`trips/2024/japan`); `tag:trips` matches everything below.
- Search syntax: free text, `"exact phrase"`, `tag:`, `type:`, `ext:`, `size:`, `in:`, `is:`
  (`untagged`, `tagged`, `missing`, `offline`, `duplicate`), and a leading `-` to exclude.
- Keyboard: ⌘/Ctrl-F or `/` to search, `T` to tag the selection, ⌘/Ctrl-, for Settings, and grid
  navigation and selection from the keyboard.
- Settings: library folders (add, remove, file and tagged counts, offline state) and diagnostics.
- Terminology: _library folders_ (the roots the user adds), _data folder_, _tags_, _selection_,
  _details panel_, _missing_ and _offline_ files, _indexing_.
- Heavy work (indexing, watching, thumbnails, database) runs in a separate indexer process, never
  in the interface.
- License: MIT, for the app's own code. Installers also ship LGPL components (libvips inside
  `sharp`, and `ffmpeg`/`ffprobe` when bundled): their license texts, and for ffmpeg a pointer to
  its source, must accompany public releases.

## Brand Commitments

- Name: **SG Tag**. Tagline: "Tag and retrieve local images and videos, fast."
- No logo or app icon exists yet.

## Evidence on Hand

- The working app and its README; no screenshots, users, testimonials or reviews yet.
- The status bar measures each search's time live, but no published benchmarks exist: do not quote
  performance figures that have not been measured.

## Product Principles

1. **The user's files are theirs.** SG Tag reads files; it never writes or renames them, and the
   only file it moves is a duplicate the user sends to the Trash, once an identical copy is safe on
   disk with its tags. When an action loses tags (removing a library folder), say so plainly before
   it happens.
2. **Instant is the feature.** A change that makes search, scrolling or tagging feel slower is a
   regression, whatever it adds.
3. **The file system stays in charge.** Follow what happens on disk (renames, moves, missing files,
   offline drives) instead of asking the user to work through the app.
4. **Keyboard first, mouse welcome.** Every core flow must stay fully operable from the keyboard.
5. **Built for one, shared with all.** Decisions serve the author's real library first, while
   staying general enough for anyone once it is open source.

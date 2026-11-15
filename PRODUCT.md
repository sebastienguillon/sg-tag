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
  on disk and giving it the duplicate's tags. Besides that, the only file SG Tag writes outside its
  data folder is a tags export, to the place the user chooses in a save dialog.
- **Speed.** Search filters on every keystroke, and stays instant on large libraries.
- **Folders as they are.** No importing of media and no managed library: SG Tag indexes existing
  folders in place, watches them, and adapts to the file system rather than reorganising it. A file
  renamed or moved outside the app, within or between library folders, stays the same file (same
  tags and thumbnail); tagged files that disappear are kept as missing; folders on disconnected
  drives stay browsable as offline.
- **Keyboard-first.** Searching, selecting, tagging and navigating all work without the mouse.

## Operating Context

- Desktop app (Electron) for macOS, Windows and Linux. The interface is rendered as a web page, with
  desktop conventions: macOS inset title bar, platform names for "Show in Finder" / "Show in
  Explorer", the system light or dark appearance.
- Libraries are ordinary folders, including external drives and network shares that come and go.
- Video thumbnails and metadata use `ffmpeg`/`ffprobe` when present; macOS and Windows fall back to
  the system thumbnailer without them.
- The data folder (shown in Settings) holds the only live copy of the tags, so users must back it up
  or export them: Export tags… saves them to a file the user chooses, and Import tags… adds them
  back, on this computer or another. Tags are not visible to other apps except through a tags
  export.
- Status: alpha (2026.10.0-alpha.3), released through GitHub.

## Capabilities and Constraints

- Thumbnail grid with adjustable tile size, sorted by date modified, name or size; each tile shows
  the file type.
- Details panel (resizable) for the selected file: preview, metadata, location, Open and Show in
  Finder/Explorer; tag editing for one file or a multi-file selection, showing partial tags as
  `n/total`, and under them the tags above them that also find the files ("Also found under").
- Duplicates: files with byte-identical content. Find duplicates checks the whole library on
  request, and tagging a file checks it (importing tags does not, since it may tag thousands of
  files at once); `is:duplicate` lists them side by side. The details panel lists a file's identical
  copies, can give all copies the same tags, and moves a chosen copy to the Trash. Checks compare
  size, then a fingerprint, and read whole files only for likely copies.
- Video preview: the details panel plays a video in place, on request, when Chromium decodes it
  (H.264, VP9, AV1, and HEVC where the platform decodes it, in MP4, MOV, MKV or WebM). Guardrail:
  **SG Tag previews; real playback belongs to the system player.** No transcoding and no player
  features beyond the built-in controls; other formats go to Open.
- Tags are plain names: letter case never distinguishes two tags, accents do, and search ignores
  both (`tag:ete` finds the files tagged `Été`). Characters nobody sees (a zero-width space or a
  soft hyphen pasted from a web page) never distinguish two tags either, and search ignores them
  too. A name cannot contain a comma or a double quote, nor start with `=`; `/` is an ordinary
  character in it.
- Aliases and parent tags: a tag may have other names (aliases), each the name of no other tag, and
  parent tags (`Paris` below `France`, any number, never in a loop). `tag:France` finds the files of
  France and of the tags below it, by a name or an alias; `tag:=France`, those of France itself.
  The tag editor, opened from a tag in the details panel or on the tags page, renames a tag, gives
  it aliases, parent tags and child tags, merges it into another tag or deletes it, each change at
  once; deleting a tag moves its child tags up to its parent tags. A change that would put a tag
  below itself, or give a tag more than 100 aliases or parent tags, is refused with the reason.
- Tags page (Tags in the toolbar, or ⌘/Ctrl-Shift-T from any page): every tag in one list sorted by
  name, each with its parent tags, how many files have it and how many tags are below it; a filter
  by name or alias, combined with Unused (no file has the tag) and No parent; New tag, for a tag no
  file has yet; and beside the list, the tag editor of the tag selected. The arrows move through
  the list, Enter goes into the editor and Escape comes back to the list.
- Search syntax: free text, `"exact phrase"`, `tag:`, `type:`, `ext:`, `size:`, `in:`, `is:`
  (`untagged`, `tagged`, `missing`, `offline`, `duplicate`), and a leading `-` to exclude.
- Keyboard: ⌘/Ctrl-F or `/` to search, `T` to tag the selection, ⌘/Ctrl-Shift-T for the tags page
  and ⌘/Ctrl-, for Settings (both from any page, matched on the character typed), and grid
  navigation and selection from the keyboard.
- Zoom: ⌘/Ctrl with `+` or `=`, `-` and `0` (keypad too, on any keyboard layout), Ctrl + mouse wheel
  on Windows and Linux, or the View menu; 50% to 300%, remembered across launches.
- Settings: library folders (add, remove, file and tagged counts, offline state), tags (data folder,
  Export tags…, Import tags… and Import from TagStudio…), the classification catalogue, and
  diagnostics (versions of the app, ffmpeg, ffprobe and SQLite).
  One Check for updates covers ffmpeg and ffprobe, which come with the same FFmpeg release: it asks
  ffmpeg.org for its latest release and links to its download page when that is newer. SG Tag
  contacts no website otherwise. A tool not found gets a link to install FFmpeg.
- Tags export and import: a tags export describes every tag made or edited on purpose, with its
  aliases and parent tags, whether or not a file has it, and lists every tagged file (missing and
  offline ones included) with its tags, except those past 1,000 on one file, which it leaves out and
  counts. It can be made as soon as the library has a tag. Importing it adds the tags it describes,
  the aliases and parent tags they lack, and lists what it leaves out and why (an alias another tag
  has, a parent tag that would make a loop, the limits of 100 aliases and 100 parent tags). It
  holds up to 256 MiB (about 670,000 tagged files) and 10,000 library folders (tens at the longest
  paths), and Export tags… refuses a larger one rather than save a file Import tags… would refuse.
  Importing it only adds tags, finds files by their content even if they were renamed, moved, or
  their library folder has another path, and shows what it will add before writing anything. Tags
  exports are file version 2: one made by an earlier version of SG Tag (version 1) can no longer be
  imported. A library last opened by such a version (2026.10.0-alpha.3 or earlier) loses its tags
  the first time a later version opens it, and those versions can no longer use it: only a copy of
  the data folder made beforehand keeps its tags.
- Import from TagStudio: reads a TagStudio library (9.5 and later) from a copy of its database made
  in the data folder, never changing it, and adds its tags, aliases, shorthands (as aliases) and
  parent tags, with the same preview and the same only-adds guarantee as a tags export. Files are
  found by their place below the library's folder, or, as TagStudio's "Fix Unlinked Entries" does,
  as the one file of their name there. Names a tag cannot have here are rewritten, tags of one name
  with other parent tags become `Name (Parent)`, and the preview lists both, and counts what does
  not come over (colours, icons, categories, the hidden setting, fields, unused built-in tags).
- Classification catalogue (experimental): SG Tag reads the catalogue that the
  `media-classification` skill writes (a CSV file, chosen in Settings and remembered, read again
  when it changes, never written). For one selected file, the details panel shows its category and
  subcategory, confidence, topic, visible content and review notes, and suggests its tags: the
  subcategory, below its category as a parent tag, and its format tags, each added on its own or
  all at once. A file is the one at the catalogue's path, or, after a move, the one file in the
  library folders with its name, size and date; one that changed since it was classified says so.
- Terminology: _library folders_ (the roots the user adds), _data folder_, _tags_, _tags export_,
  _selection_, _details panel_, _tags page_, _missing_ and _offline_ files, _indexing_,
  _classification catalogue_ (then _catalogue_), _category_, _subcategory_, _format tags_.
- Heavy work (indexing, watching, thumbnails, database) runs in a separate indexer process, never
  in the interface.
- License: MIT, for the app's own code. Installers also ship LGPL components (libvips inside
  `sharp`, and `ffmpeg`/`ffprobe` when bundled): their license texts, and for ffmpeg a pointer to
  its source, must accompany public releases.

## Brand Commitments

- Name: **SG Tag**. Tagline: "Tag and retrieve local images and videos, fast."
- App icon: a 3 × 3 grid of thumbnails on an olive-black ground (`#131510`). Tagged ones are
  shaped like tags, coloured from yellow to teal along the diagonal (`#f4ce23`, `#a8c70b`,
  `#48c063`, `#0da995`, built in OKLCH around the author's own colour `#a8c70b`); the untagged
  diagonal between them stays dark (`#2d2f27`). `scripts/build-icons.ts` draws it and writes the
  installer icons (`pnpm icons`).
- Wordmark: "SG Tag" in Schibsted Grotesk Bold, outlined. Lockups for dark and light backgrounds and
  a one-colour mark are in `docs/brand/`.

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

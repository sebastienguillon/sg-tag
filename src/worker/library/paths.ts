import path from 'node:path';
import { formatOf } from './formats';

/** macOS and Windows volumes are case-insensitive by default. */
export const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

/** Directory names never worth indexing: VCS/tool folders, OS junk, NAS metadata. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  '@eadir',
  '#recycle',
  '#snapshot',
  '__macosx',
  'lost+found',
]);

/** Packages that hold derived or private copies (Photos, Lightroom, Final Cut…), not user files. */
const IGNORED_BUNDLE_SUFFIXES = [
  '.photoslibrary',
  '.photolibrary',
  '.aplibrary',
  '.lrdata',
  '.lrlibrary',
  '.fcpbundle',
  '.imovielibrary',
  '.tvlibrary',
  '.app',
  '.bundle',
  '.framework',
];

export function isIgnoredDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith('.') ||
    IGNORED_DIRECTORIES.has(lower) ||
    IGNORED_BUNDLE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

/** Hidden files (including macOS `._` AppleDouble files on external drives) are skipped. */
export function isIndexable(filePath: string): boolean {
  const name = path.basename(filePath);
  return !name.startsWith('.') && formatOf(extensionOf(name)) !== undefined;
}

/** True when a folder between `root` and `filePath` is one the crawler skips. */
export function isInIgnoredDirectory(root: string, filePath: string): boolean {
  const segments = path.relative(root, filePath).split(path.sep);
  return segments.slice(0, -1).some(isIgnoredDirectory);
}

export function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export interface PathParts {
  /** Folder relative to the root, `/`-separated, Unicode NFC; empty at the root. */
  readonly dir: string;
  /** File name, Unicode NFC (macOS may hand back decomposed names). */
  readonly name: string;
  readonly ext: string;
}

export function splitPath(root: string, filePath: string): PathParts {
  const dir = path.relative(root, path.dirname(filePath)).split(path.sep).join('/');
  const name = path.basename(filePath);
  return { dir: dir.normalize('NFC'), name: name.normalize('NFC'), ext: extensionOf(name) };
}

/** Canonical form for comparing user-supplied root paths. */
export function normalizeRoot(input: string): string {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
}

function comparable(value: string): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/** True when `child` is `parent` itself or lives below it. */
export function isWithin(parent: string, child: string): boolean {
  const p = comparable(parent);
  const c = comparable(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function rootsOverlap(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * `a` and `b` name the same folder on this computer (Unicode NFC; any case on macOS and Windows).
 */
export function samePath(a: string, b: string, insensitive = caseInsensitive): boolean {
  const fold = (value: string): string => {
    const nfc = value.normalize('NFC');
    return insensitive ? nfc.toLowerCase() : nfc;
  };
  return fold(a) === fold(b);
}

/**
 * Segments of an absolute path written on `platform` (`win32`: either separator), empty ones
 * dropped.
 */
export function pathSegments(value: string, platform: string): string[] {
  return value.split(platform === 'win32' ? /[\\/]/ : '/').filter((segment) => segment !== '');
}

/**
 * How many trailing segments `a` and `b` share: 1 for the same name, 2 for the same name and
 * parent folder… The reconciler's `byLikeness` ranks identical files the same way.
 */
export function commonTail(a: readonly string[], b: readonly string[]): number {
  let same = 0;
  while (same < a.length && same < b.length && a[a.length - 1 - same] === b[b.length - 1 - same]) {
    same++;
  }
  return same;
}

/**
 * Bounds of the `path` range holding everything below `dir`, for an index range scan:
 * every descendant sorts strictly between `dir + sep` and `dir + (sep + 1)`.
 */
export function descendantRange(dir: string): readonly [string, string] {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const upper = prefix.slice(0, -1) + String.fromCharCode(path.sep.charCodeAt(0) + 1);
  return [prefix, upper];
}

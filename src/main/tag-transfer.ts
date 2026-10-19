import type { TagExportResult } from '@shared/model';
import path from 'node:path';
import type { WorkerHost } from './worker-host';

export const TAGS_EXPORT_FILTER: Electron.FileFilter = {
  name: 'SG Tag tags export',
  extensions: ['jsonl'],
};

/** `SG Tag tags 2026-10-19.jsonl`, in local time: successive exports sit side by side. */
export function exportFileName(date: Date): string {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  return `SG Tag tags ${day}.jsonl`;
}

/**
 * `child` is `parent` or inside it. macOS and Windows volumes ignore case (and macOS, Unicode
 * normalization), so the comparison does too there.
 */
export function isInside(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string =>
    platform === 'darwin' || platform === 'win32' ? value.normalize('NFC').toLowerCase() : value;
  const relative = paths.relative(fold(parent), fold(child));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

/**
 * Has the indexer export the tags to `destination`, chosen in the save dialog, unless it is in the
 * data folder: the export must never replace the library database or anything next to it.
 */
export async function exportTags(
  worker: Pick<WorkerHost, 'call'>,
  destination: string,
  options: { readonly appVersion: string; readonly dataDir: string },
): Promise<TagExportResult> {
  if (isInside(options.dataDir, destination)) {
    throw new Error('Choose a place outside SG Tag’s data folder for the tags export.');
  }
  return worker.call('exportTags', destination, options.appVersion);
}

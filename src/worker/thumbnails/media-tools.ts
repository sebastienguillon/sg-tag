import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export interface MediaTools {
  readonly ffmpeg: string | null;
  readonly ffprobe: string | null;
}

/** Package-manager locations that GUI-launched apps do not get on their PATH (macOS, Linux). */
const WELL_KNOWN_DIRS =
  process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/**
 * Finds ffmpeg/ffprobe: `SG_TAG_FFMPEG_DIR`, then binaries bundled with the app (`resources/bin`),
 * then the PATH and well-known install locations.
 */
export function locateMediaTools(resourcesDir: string | null): MediaTools {
  const dirs = [
    process.env['SG_TAG_FFMPEG_DIR'],
    resourcesDir === null ? undefined : path.join(resourcesDir, 'bin'),
    ...(process.env['PATH'] ?? '').split(path.delimiter),
    ...WELL_KNOWN_DIRS,
  ].filter((dir): dir is string => dir !== undefined && dir !== '');
  return { ffmpeg: find('ffmpeg', dirs), ffprobe: find('ffprobe', dirs) };
}

function find(name: string, dirs: readonly string[]): string | null {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

import type { MediaToolInfo } from '@shared/model';
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

/** A tool found by `locateMediaTools`, with the version it reports now. */
export async function describeMediaTool(
  file: string,
  resourcesDir: string | null,
): Promise<MediaToolInfo> {
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(file, ['-version'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    version = parseToolVersion(stdout);
  } catch {
    // Removed or broken since it was found: no version to show.
  }
  return {
    path: file,
    version,
    bundled: resourcesDir !== null && path.dirname(file) === path.join(resourcesDir, 'bin'),
  };
}

/** `ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers` → `7.1.1`. */
export function parseToolVersion(output: string): string | null {
  return /^\S+ version (\S+)/.exec(output)?.[1] ?? null;
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

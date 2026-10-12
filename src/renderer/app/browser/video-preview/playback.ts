import type { FileDetails } from '@shared/model';

/** Containers Chromium demuxes, by format label. */
const CONTAINERS: ReadonlySet<string> = new Set(['MP4', 'M4V', 'MOV', 'MKV', 'WEBM']);

/**
 * Video codecs Chromium decodes, by ffprobe name. HEVC has no software decoder: it only plays where
 * the platform decodes it, which `canPlayType` reports.
 */
const CODECS: ReadonlyMap<string, string | null> = new Map([
  ['h264', null],
  ['vp8', null],
  ['vp9', null],
  ['av1', null],
  ['hevc', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
]);

/**
 * Whether the details panel can play this file. Without ffprobe the codec is unknown: worth a try,
 * since the player falls back to the thumbnail when decoding fails.
 */
export function isPlayable(
  file: Pick<FileDetails, 'kind' | 'format' | 'codec'>,
  canPlayType: (type: string) => string,
): boolean {
  if (file.kind !== 'video' || !CONTAINERS.has(file.format)) {
    return false;
  }
  if (file.codec === null) {
    return true;
  }
  const type = CODECS.get(file.codec);
  return type === null || (type !== undefined && canPlayType(type) !== '');
}

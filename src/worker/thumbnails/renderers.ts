import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WebpOptions } from 'sharp';
import sharp from 'sharp';
import { THUMBNAIL_EDGE } from '@shared/model';
import type { MediaInfo } from '../library/files-repository';

const execFileAsync = promisify(execFile);

const WEBP: WebpOptions = { quality: 78, effort: 2 };

// Every thumbnail is a one-off: libvips' operation cache would only hold memory.
sharp.cache(false);
// Several thumbnails render in parallel; keep each one from claiming every core.
sharp.concurrency(2);

export async function renderImage(source: string, target: string): Promise<MediaInfo> {
  const image = sharp(source, { failOn: 'none', sequentialRead: true });
  const { autoOrient } = await image.metadata();
  await image
    .autoOrient()
    .resize({
      width: THUMBNAIL_EDGE,
      height: THUMBNAIL_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp(WEBP)
    .toFile(target);
  return { width: autoOrient.width, height: autoOrient.height, durationMs: null, codec: null };
}

/** Grabs a frame 10% into the video (skipping black intros), falling back to the first frame. */
export async function renderVideo(
  ffmpeg: string,
  ffprobe: string | null,
  source: string,
  target: string,
): Promise<MediaInfo> {
  const info = ffprobe === null ? null : await probeVideo(ffprobe, source).catch(() => null);
  const seekSeconds = ((info?.durationMs ?? 0) / 1000) * 0.1;
  let frame = await extractFrame(ffmpeg, source, seekSeconds).catch(() => null);
  if (!frame && seekSeconds > 0) {
    frame = await extractFrame(ffmpeg, source, 0);
  }
  if (!frame) {
    throw new Error('ffmpeg could not extract a frame');
  }
  await sharp(frame).webp(WEBP).toFile(target);
  return info ?? { width: null, height: null, durationMs: null, codec: null };
}

/** Decodes a still image with ffmpeg (formats libvips cannot read, on Linux). */
export async function renderWithFfmpeg(
  ffmpeg: string,
  source: string,
  target: string,
): Promise<MediaInfo> {
  const frame = await extractFrame(ffmpeg, source, 0);
  await sharp(frame).webp(WEBP).toFile(target);
  return { width: null, height: null, durationMs: null, codec: null };
}

/** Stores a PNG produced by the OS thumbnailer. */
export async function encodeThumbnail(png: Uint8Array, target: string): Promise<void> {
  await sharp(png).webp(WEBP).toFile(target);
}

async function extractFrame(ffmpeg: string, source: string, seconds: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-ss',
      seconds.toFixed(3),
      '-i',
      source,
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `scale=${THUMBNAIL_EDGE}:${THUMBNAIL_EDGE}:force_original_aspect_ratio=decrease`,
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ],
    { encoding: 'buffer', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (stdout.length === 0) {
    throw new Error('ffmpeg produced no frame');
  }
  return stdout;
}

interface ProbeOutput {
  streams?: {
    width?: number;
    height?: number;
    codec_name?: string;
    side_data_list?: { rotation?: number }[];
    tags?: { rotate?: string };
  }[];
  format?: { duration?: string };
}

async function probeVideo(ffprobe: string, source: string): Promise<MediaInfo> {
  const { stdout } = await execFileAsync(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,codec_name:stream_side_data=rotation:stream_tags=rotate:format=duration',
      '-of',
      'json',
      source,
    ],
    { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const output = JSON.parse(stdout) as ProbeOutput;
  const stream = output.streams?.[0];
  const rotation = Number(stream?.side_data_list?.[0]?.rotation ?? stream?.tags?.rotate ?? 0);
  const portrait = Math.abs(rotation) % 180 === 90;
  const width = stream?.width ?? null;
  const height = stream?.height ?? null;
  const duration = Number(output.format?.duration);
  return {
    width: portrait ? height : width,
    height: portrait ? width : height,
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
    codec: stream?.codec_name ?? null,
  };
}

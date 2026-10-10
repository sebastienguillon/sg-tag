import type { FileKind } from '@shared/model';

/**
 * How a thumbnail gets made. `system` defers to the OS thumbnailer, which only the main process can
 * reach (QuickLook on macOS, the Shell on Windows); it covers HEIC, camera RAW, JPEG XL and more.
 */
export type Decoder = 'sharp' | 'ffmpeg' | 'system';

export interface FormatInfo {
  readonly kind: FileKind;
  /** Short label shown on tiles. */
  readonly label: string;
  /** Decoders to try, in order. */
  readonly decoders: readonly Decoder[];
}

const hasSystemThumbnailer = process.platform === 'darwin' || process.platform === 'win32';

const decodable: readonly Decoder[] = hasSystemThumbnailer
  ? ['sharp', 'system']
  : ['sharp', 'ffmpeg'];
const osOnly: readonly Decoder[] = hasSystemThumbnailer ? ['system'] : ['ffmpeg'];
const video: readonly Decoder[] = hasSystemThumbnailer ? ['ffmpeg', 'system'] : ['ffmpeg'];

const image = (label: string, decoders = decodable): FormatInfo => ({
  kind: 'image',
  label,
  decoders,
});
const raw = (label: string): FormatInfo => image(label, osOnly);
const movie = (label: string): FormatInfo => ({ kind: 'video', label, decoders: video });

const FORMATS: ReadonlyMap<string, FormatInfo> = new Map<string, FormatInfo>([
  ['jpg', image('JPG')],
  ['jpeg', image('JPG')],
  ['jpe', image('JPG')],
  ['jfif', image('JPG')],
  ['png', image('PNG')],
  ['apng', image('APNG')],
  ['gif', image('GIF')],
  ['webp', image('WEBP')],
  ['avif', image('AVIF')],
  ['tif', image('TIFF')],
  ['tiff', image('TIFF')],
  ['svg', image('SVG')],
  ['bmp', image('BMP', osOnly)],
  ['heic', image('HEIC', osOnly)],
  ['heif', image('HEIF', osOnly)],
  ['jxl', image('JXL', osOnly)],
  ...['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef']
    .concat(['srw', '3fr', 'iiq', 'x3f', 'erf', 'rwl', 'kdc', 'dcr', 'mrw'])
    .map((ext): [string, FormatInfo] => [ext, raw(ext.toUpperCase())]),
  ['mp4', movie('MP4')],
  ['m4v', movie('M4V')],
  ['mov', movie('MOV')],
  ['qt', movie('MOV')],
  ['mkv', movie('MKV')],
  ['webm', movie('WEBM')],
  ['avi', movie('AVI')],
  ['wmv', movie('WMV')],
  ['asf', movie('ASF')],
  ['flv', movie('FLV')],
  ['f4v', movie('F4V')],
  ['mpg', movie('MPEG')],
  ['mpeg', movie('MPEG')],
  ['m2v', movie('MPEG')],
  ['ts', movie('TS')],
  ['mts', movie('MTS')],
  ['m2ts', movie('M2TS')],
  ['3gp', movie('3GP')],
  ['3g2', movie('3G2')],
  ['ogv', movie('OGV')],
  ['vob', movie('VOB')],
  ['mxf', movie('MXF')],
  ['dv', movie('DV')],
]);

/** `ext` is lower-case, without the dot. */
export function formatOf(ext: string): FormatInfo | undefined {
  return FORMATS.get(ext);
}

/** Extensions that share a label, so `ext:jpg` also finds `.jpeg` files. */
export function extensionAliases(ext: string): readonly string[] {
  const label = FORMATS.get(ext)?.label;
  if (label === undefined) {
    return [ext];
  }
  return [...FORMATS].filter(([, info]) => info.label === label).map(([alias]) => alias);
}

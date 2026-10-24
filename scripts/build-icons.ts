/**
 * Draws the app icon and writes every file the installers and the README use, from the geometry
 * below: `build/icon.icns` (macOS), `build/icon.ico` (Windows), `build/icons/*.png` (Linux) and
 * `docs/brand/icon.svg`. Run it after changing the design: `pnpm icons`.
 *
 * The icon is a 3 × 3 grid of thumbnails. Tagged ones are shaped like tags, in the four colours of
 * the palette from yellow to teal along the diagonal; the untagged diagonal between them stays dark.
 * Under 48 px, hand-drawn versions snapped to the pixel grid replace the scaled-down drawing.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/** Tag colours, built in OKLCH around #a8c70b at matching lightness and chroma. */
const TAG = { yellow: '#f4ce23', lime: '#a8c70b', green: '#48c063', teal: '#0da995' } as const;
const GROUND = '#131510';
const UNTAGGED = '#2d2f27';

type Cell = keyof typeof TAG | null;
/** The grid, row by row: the colours flow down the diagonal, the untagged tiles run across it. */
const CELLS: readonly Cell[] = [
  'yellow', 'lime', null,
  'lime', null, 'green',
  null, 'green', 'teal',
]; // prettier-ignore

interface Box {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** A tagged thumbnail: a square whose left side ends in a tag's point, with its string hole. */
function tagTile({ x, y, size }: Box, fill: string): string {
  const point = size * 0.3;
  const corner = size * 0.125;
  const hole = size * 0.08;
  const hx = x + point + hole;
  const cy = y + size / 2;
  return (
    `<path fill="${fill}" fill-rule="evenodd" d="` +
    `M${x + point} ${y}H${x + size - corner}a${corner} ${corner} 0 0 1 ${corner} ${corner}` +
    `V${y + size - corner}a${corner} ${corner} 0 0 1 ${-corner} ${corner}H${x + point}L${x} ${cy}Z` +
    `M${hx - hole} ${cy}a${hole} ${hole} 0 1 0 ${hole * 2} 0a${hole} ${hole} 0 1 0 ${-hole * 2} 0Z"/>`
  );
}

function plainTile({ x, y, size }: Box): string {
  const corner = size * 0.125;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${corner}" fill="${UNTAGGED}"/>`;
}

/** The ground and its grid, for a ground of side `side` at (`at`, `at`). */
function drawing(at: number, side: number): string {
  const inset = side * 0.165;
  const tile = side * 0.1942;
  const gap = (side - inset * 2 - tile * 3) / 2;
  const tiles = CELLS.map((cell, index) => {
    const box = {
      x: at + inset + (index % 3) * (tile + gap),
      y: at + inset + Math.floor(index / 3) * (tile + gap),
      size: tile,
    };
    return cell === null ? plainTile(box) : tagTile(box, TAG[cell]);
  });
  const ground = `<rect x="${at}" y="${at}" width="${side}" height="${side}" rx="${side * 0.2245}" fill="${GROUND}"/>`;
  return ground + tiles.join('');
}

const svg = (size: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${body}</svg>`;

/** macOS: the ground on Apple's icon grid (824 of 1024), with its drop shadow. */
const MAC = svg(
  1024,
  '<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">' +
    '<feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.32"/>' +
    `</filter></defs><g filter="url(#shadow)">${drawing(100, 824)}</g>`,
);

/** Windows and Linux: the same drawing, nearly full bleed. */
const FULL = svg(1024, drawing(32, 960));

/** Hand-drawn at 32 px: 6 px tiles two pixels apart, the point cut over two pixels, no hole. */
const PX32 = svg(
  32,
  `<rect x="2" y="2" width="28" height="28" rx="6.5" fill="${GROUND}"/>${CELLS.map(
    (cell, index) => {
      const x = 5 + (index % 3) * 8;
      const y = 5 + Math.floor(index / 3) * 8;
      return cell === null
        ? `<rect x="${x}" y="${y}" width="6" height="6" rx="1" fill="${UNTAGGED}"/>`
        : `<path fill="${TAG[cell]}" d="M${x + 2} ${y}H${x + 6}V${y + 6}H${x + 2}L${x} ${y + 3}Z"/>`;
    },
  ).join('')}`,
);

/** Hand-drawn at 16 px: 4 px tiles one pixel apart, the point reduced to two missing corners. */
const PX16 = svg(
  16,
  `<rect width="16" height="16" rx="3.5" fill="${GROUND}"/>${CELLS.map((cell, index) => {
    const x = 1 + (index % 3) * 5;
    const y = 1 + Math.floor(index / 3) * 5;
    return cell === null
      ? `<rect x="${x}" y="${y}" width="4" height="4" fill="${UNTAGGED}"/>`
      : `<path fill="${TAG[cell]}" d="M${x + 1} ${y}H${x + 4}V${y + 4}H${x + 1}V${y + 3}H${x}V${y + 1}H${x + 1}Z"/>`;
  }).join('')}`,
);

/** The source drawn at each size: hand-drawn below 48 px, scaled down from 1024 above. */
function sourceFor(size: number, large: string): string {
  if (size <= 16) {
    return PX16;
  }
  return size <= 32 ? PX32 : large;
}

const png = (source: string, size: number): Promise<Buffer> =>
  sharp(Buffer.from(source), {
    density: (72 * size) / Number(/viewBox="0 0 (\d+)/.exec(source)?.[1]),
  })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * An `ic04`/`ic05` entry: macOS reads no PNG at 16 and 32 px, but ARGB planes, each run-length
 * encoded. Literal runs of up to 128 bytes are valid encoding, and these images are tiny.
 */
async function argb(source: string, size: 16 | 32): Promise<Buffer> {
  const rgba = await sharp(Buffer.from(source), { density: 72 }).ensureAlpha().raw().toBuffer();
  const planes = [3, 0, 1, 2].map((channel) => {
    const plane = Buffer.alloc(size * size);
    for (let pixel = 0; pixel < plane.length; pixel++) {
      plane[pixel] = rgba[pixel * 4 + channel] ?? 0;
    }
    const runs: Buffer[] = [];
    for (let at = 0; at < plane.length; at += 128) {
      const run = plane.subarray(at, at + 128);
      runs.push(Buffer.from([run.length - 1]), run);
    }
    return Buffer.concat(runs);
  });
  return Buffer.concat([Buffer.from('ARGB', 'ascii'), ...planes]);
}

/** An .icns, by OSType (https://en.wikipedia.org/wiki/Apple_Icon_Image_format). */
async function icns(): Promise<Buffer> {
  const entries: [string, () => Promise<Buffer>][] = [
    ['ic04', () => argb(PX16, 16)],
    ['ic05', () => argb(PX32, 32)],
    // Retina entries draw the design at twice its size: 16 pt at 32 px is the 32 px drawing.
    ['ic11', () => png(PX32, 32)],
    ['ic12', () => png(MAC, 64)],
    ['ic07', () => png(MAC, 128)],
    ['ic13', () => png(MAC, 256)],
    ['ic08', () => png(MAC, 256)],
    ['ic14', () => png(MAC, 512)],
    ['ic09', () => png(MAC, 512)],
    ['ic10', () => png(MAC, 1024)],
  ];
  const chunks = await Promise.all(
    entries.map(async ([type, image]) => {
      const data = await image();
      const header = Buffer.alloc(8);
      header.write(type, 0, 'ascii');
      header.writeUInt32BE(data.length + 8, 4);
      return Buffer.concat([header, data]);
    }),
  );
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

/** An .ico of PNG entries (https://en.wikipedia.org/wiki/ICO_(file_format)). */
async function ico(): Promise<Buffer> {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => png(sourceFor(size, FULL), size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const at = 6 + index * 16;
    const image = images[index] ?? Buffer.alloc(0);
    header.writeUInt8(size % 256, at);
    header.writeUInt8(size % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

await rm('build/icons', { recursive: true, force: true });
await mkdir('build/icons', { recursive: true });
await mkdir('docs/brand', { recursive: true });
await writeFile('build/icon.icns', await icns());
await writeFile('build/icon.ico', await ico());
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await writeFile(`build/icons/${size}x${size}.png`, await png(sourceFor(size, FULL), size));
}
await writeFile('docs/brand/icon.svg', `${MAC}\n`);
console.log('Icons written to build/ and docs/brand/icon.svg');

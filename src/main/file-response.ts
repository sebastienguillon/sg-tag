import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Inclusive byte offsets. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Reads a `Range` header against a resource of `size` bytes. `null` means the header is ignored and
 * the whole resource served: absent, malformed, or several ranges, which media elements never ask for.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, first = '', last = ''] = match;
  if (first === '') {
    // A suffix: the last N bytes.
    if (last === '') {
      return null;
    }
    const length = Number(last);
    return length === 0 || size === 0
      ? 'unsatisfiable'
      : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) {
    return 'unsatisfiable';
  }
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return end < start ? null : { start, end };
}

/**
 * Serves a local file, answering byte ranges with `206 Partial Content` so that a media element can
 * seek without reading from the start. `net.fetch` ignores `Range` on `file:` URLs, hence this.
 */
export async function fileResponse(
  file: string,
  range: string | null,
  contentType: string,
): Promise<Response> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Response(null, { status: 404 });
  }
  const bounds = parseRange(range, size);
  if (bounds === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
  if (bounds === null) {
    return new Response(size === 0 ? null : read(file, { start: 0, end: size - 1 }), {
      headers: { ...headers, 'Content-Length': String(size) },
    });
  }
  return new Response(read(file, bounds), {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(bounds.end - bounds.start + 1),
      'Content-Range': `bytes ${bounds.start}-${bounds.end}/${size}`,
    },
  });
}

/** Streams the bytes; cancelling the response (the player seeks elsewhere) closes the file. */
function read(file: string, { start, end }: ByteRange): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
}

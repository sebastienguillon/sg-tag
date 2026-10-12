import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileResponse, parseRange } from './file-response';

describe('parseRange', () => {
  it('reads single ranges, open-ended ranges and suffixes', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('ignores what it cannot serve as one range, and rejects ranges past the end', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=20-10', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

describe('fileResponse', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sg-tag-file-response-'));
  const file = path.join(dir, 'clip.mp4');
  writeFileSync(
    file,
    Uint8Array.from({ length: 256 }, (_, index) => index),
  );
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bytes(response: Response): Promise<number[]> {
    return [...new Uint8Array(await response.arrayBuffer())];
  }

  it('serves the whole file when no range is asked for', async () => {
    const response = await fileResponse(file, null, 'video/mp4');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe('256');
    expect(await bytes(response)).toHaveLength(256);
  });

  it('serves the requested bytes as partial content', async () => {
    const response = await fileResponse(file, 'bytes=250-', 'video/mp4');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 250-255/256');
    expect(response.headers.get('Content-Length')).toBe('6');
    expect(await bytes(response)).toEqual([250, 251, 252, 253, 254, 255]);
  });

  it('rejects ranges past the end, and missing files', async () => {
    const outside = await fileResponse(file, 'bytes=300-', 'video/mp4');
    expect(outside.status).toBe(416);
    expect(outside.headers.get('Content-Range')).toBe('bytes */256');
    expect((await fileResponse(path.join(dir, 'gone.mp4'), null, 'video/mp4')).status).toBe(404);
  });
});

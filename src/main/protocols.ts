import { createLimiter } from '@shared/async';
import { createLogger } from '@shared/log';
import { THUMBNAIL_EDGE } from '@shared/model';
import { errorMessage } from '@shared/rpc';
import type { ThumbnailSource } from '@shared/worker-api';
import { nativeImage, net, protocol } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerHost } from './worker-host';

const log = createLogger('protocols');

/** Origin the production renderer is served from. */
export const APP_ORIGIN = 'app://bundle';

/**
 * Content Security Policy of the renderer. Component styles are injected at runtime, hence
 * `'unsafe-inline'` for styles only. Thumbnails come from the `thumb:` scheme.
 */
export function contentSecurityPolicy(devServer: string | null): string {
  const connect = devServer === null ? "'self'" : `'self' ${devServer.replace(/^http/, 'ws')}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' thumb: data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Must run before the app is ready. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
    { scheme: 'thumb', privileges: { standard: true, secure: true } },
  ]);
}

export function handleProtocols(worker: WorkerHost, rendererRoot: string): void {
  protocol.handle('app', (request) => serveApp(request, rendererRoot));
  protocol.handle('thumb', (request) => serveThumbnail(request, worker));
}

/** Serves the built Angular app, falling back to `index.html` for client-side routes. */
async function serveApp(request: Request, root: string): Promise<Response> {
  const relative = path
    .normalize(decodeURIComponent(new URL(request.url).pathname))
    .replace(/^[/\\]+/, '');
  const file = path.join(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  const target = relative !== '' && (await isFile(file)) ? file : path.join(root, 'index.html');
  const response = await net.fetch(pathToFileURL(target).toString());
  if (!target.endsWith('.html')) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', contentSecurityPolicy(null));
  return new Response(response.body, { status: response.status, headers });
}

const CACHE_HEADERS = { 'Cache-Control': 'private, max-age=31536000, immutable' };
const NOT_FOUND = (): Response => new Response(null, { status: 404 });

/** OS thumbnailers are heavy; a few at a time is plenty. */
const systemThumbnails = createLimiter(4);

/** `thumb://file/<id>?v=<mtime>`: the version only busts the renderer's image cache. */
async function serveThumbnail(request: Request, worker: WorkerHost): Promise<Response> {
  const id = Number(new URL(request.url).pathname.slice(1));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NOT_FOUND();
  }
  const source = await worker.call('thumbnail', id).catch((error: unknown): ThumbnailSource => {
    log.warn(`Thumbnail ${id} unavailable: ${errorMessage(error)}`);
    return { kind: 'none' };
  });
  switch (source.kind) {
    case 'file': {
      const response = await net.fetch(pathToFileURL(source.path).toString());
      return new Response(response.body, {
        status: response.status,
        headers: { 'Content-Type': 'image/webp', ...CACHE_HEADERS },
      });
    }
    case 'system':
      return renderWithSystem(worker, id, source.sourcePath);
    case 'none':
      return NOT_FOUND();
  }
}

/** QuickLook (macOS) / Shell thumbnails (Windows): HEIC, camera RAW, codecs ffmpeg lacks… */
async function renderWithSystem(
  worker: WorkerHost,
  id: number,
  sourcePath: string,
): Promise<Response> {
  const png = await systemThumbnails(async () => {
    try {
      const image = await nativeImage.createThumbnailFromPath(sourcePath, {
        width: THUMBNAIL_EDGE,
        height: THUMBNAIL_EDGE,
      });
      return image.isEmpty() ? null : new Uint8Array(image.toPNG());
    } catch {
      return null;
    }
  });
  await worker.call('storeThumbnail', id, png).catch(() => null);
  return png
    ? new Response(png, { headers: { 'Content-Type': 'image/png', ...CACHE_HEADERS } })
    : NOT_FOUND();
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

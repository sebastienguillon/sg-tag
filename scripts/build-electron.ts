import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { electronBuilds } from './electron-build.ts';

await rm('dist/electron', { recursive: true, force: true });
await Promise.all(electronBuilds({ dev: false }).map((options) => build(options)));
console.log('Electron bundles written to dist/electron');

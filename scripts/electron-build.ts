import type { BuildOptions } from 'esbuild';
import { readFileSync } from 'node:fs';

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

/** Runtime dependencies stay in node_modules (native addons, and electron-builder packs them). */
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

/** esbuild configurations for the Electron side: main + worker (ESM), preload (CommonJS). */
export function electronBuilds({ dev }: { readonly dev: boolean }): BuildOptions[] {
  const common: BuildOptions = {
    bundle: true,
    platform: 'node',
    target: 'node24',
    outdir: 'dist/electron',
    external,
    sourcemap: dev ? 'inline' : 'linked',
    legalComments: 'none',
    logLevel: 'warning',
  };
  return [
    {
      ...common,
      entryPoints: { main: 'src/main/main.ts', worker: 'src/worker/worker.ts' },
      format: 'esm',
      tsconfig: 'tsconfig.node.json',
    },
    {
      ...common,
      // Sandboxed preload scripts must be CommonJS.
      entryPoints: { preload: 'src/preload/preload.ts' },
      format: 'cjs',
      outExtension: { '.js': '.cjs' },
      tsconfig: 'tsconfig.preload.json',
    },
  ];
}

/**
 * Development loop: Angular dev server (HMR) for the renderer, esbuild in watch mode for the
 * Electron side, and Electron restarted whenever main, worker or preload code changes.
 */
import type { BuildContext, Plugin } from 'esbuild';
import { context } from 'esbuild';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { electronBuilds } from './electron-build.ts';

/** An uncommon default, so that another project's `ng serve` on 4200 is never picked up by mistake. */
const PORT = Number(process.env['SG_TAG_DEV_PORT'] ?? 4317);
const DEV_SERVER = `http://localhost:${PORT}`;
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const ngCli = require.resolve('@angular/cli/bin/ng.js');

let electron: ChildProcess | null = null;
let contexts: BuildContext[] = [];
let launched = false;
let restartTimer: NodeJS.Timeout | undefined;
/** Aborted once the dev session is ending. */
const session = new AbortController();

if (!(await isPortFree(PORT))) {
  console.error(`[dev] Port ${PORT} is already in use. Set SG_TAG_DEV_PORT to another port.`);
  process.exit(1);
}

const ng = spawn(process.execPath, [ngCli, 'serve', '--port', String(PORT)], { stdio: 'inherit' });
ng.on('exit', (code) => {
  void shutdown(code ?? 0);
});
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

const restartOnRebuild: Plugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (launched && result.errors.length === 0) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(restart, 150);
      }
    });
  },
};

contexts = await Promise.all(
  electronBuilds({ dev: true }).map((options) =>
    context({ ...options, plugins: [restartOnRebuild] }),
  ),
);
await Promise.all(contexts.map((ctx) => ctx.watch()));
await waitForDevServer();
if (!session.signal.aborted) {
  launch();
  launched = true;
}

function launch(): void {
  console.log('[dev] Starting Electron');
  const child = spawn(electronBinary, ['.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SG_TAG_DEV_SERVER_URL: DEV_SERVER,
      // Development never touches the library of the installed app.
      SG_TAG_USER_DATA: process.env['SG_TAG_USER_DATA'] ?? '.dev-data',
    },
  });
  electron = child;
  child.on('exit', () => {
    // Closing the app window ends the dev session; a restart replaces the child first.
    if (electron === child) {
      void shutdown(0);
    }
  });
}

function restart(): void {
  const previous = electron;
  electron = null;
  if (previous) {
    previous.once('exit', launch);
    previous.kill();
  } else {
    launch();
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once('error', () => {
        resolve(false);
      })
      .once('listening', () => {
        server.close(() => {
          resolve(true);
        });
      })
      .listen(port, 'localhost');
  });
}

async function waitForDevServer(): Promise<void> {
  for (let attempt = 0; attempt < 600 && !session.signal.aborted; attempt++) {
    try {
      if ((await fetch(DEV_SERVER)).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await delay(200);
  }
  if (!session.signal.aborted) {
    throw new Error(`Angular dev server did not start on ${DEV_SERVER}`);
  }
}

async function shutdown(code: number): Promise<void> {
  if (session.signal.aborted) {
    return;
  }
  session.abort();
  electron?.kill();
  ng.kill();
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  process.exit(code);
}

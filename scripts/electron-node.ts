/**
 * Runs a Node script with Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`), so native addons
 * built for Electron (better-sqlite3) load in tests exactly as they do in the app.
 *
 *   node scripts/electron-node.ts <script> [...args]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron') as string;

const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});

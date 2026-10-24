/**
 * Entry point of the indexer utility process: owns the SQLite index, the file watchers and the
 * thumbnail renderers, so that none of that work ever competes with the UI or the main process.
 */
import { createLogger } from '@shared/log';
import type { Channel } from '@shared/rpc';
import { isRpcMessage, RpcServer } from '@shared/rpc';
import type { WorkerHostApi } from '@shared/worker-api';
import { RENDERER_PORT_MESSAGE } from '@shared/worker-api';
import { parseArgs } from 'node:util';
import { Library } from './library';

const log = createLogger('worker');

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'data-dir': { type: 'string' },
    'resources-dir': { type: 'string' },
    'app-version': { type: 'string' },
  },
  strict: false,
});
const dataDir = values['data-dir'];
const resourcesDir = values['resources-dir'];
const appVersion = values['app-version'];
if (typeof dataDir !== 'string') {
  throw new Error('The indexer worker requires --data-dir');
}

const library = new Library({
  dataDir,
  resourcesDir: typeof resourcesDir === 'string' ? resourcesDir : null,
  appVersion: typeof appVersion === 'string' ? appVersion : '?',
});

const { parentPort } = process;

/** Main process ↔ worker: thumbnails for the `thumb:` protocol, file paths, shutdown. */
const hostChannel: Channel = {
  send: (message) => {
    parentPort.postMessage(message);
  },
  listen: (handler) => {
    const listener = (event: Electron.MessageEvent): void => {
      if (isRpcMessage(event.data)) {
        handler(event.data);
      }
    };
    parentPort.on('message', listener);
    return () => parentPort.off('message', listener);
  },
};
new RpcServer<WorkerHostApi>(hostChannel, library.hostHandlers);

/** Renderer ↔ worker: each window gets its own MessagePort, handed over by the main process. */
parentPort.on('message', (event) => {
  const [port] = event.ports;
  if (event.data === RENDERER_PORT_MESSAGE && port) {
    attachRenderer(port);
  }
});

function attachRenderer(port: Electron.MessagePortMain): void {
  const detach = library.attachRenderer({
    send: (message) => {
      port.postMessage(message);
    },
    listen: (handler) => {
      const listener = (event: Electron.MessageEvent): void => {
        if (isRpcMessage(event.data)) {
          handler(event.data);
        }
      };
      port.on('message', listener);
      return () => port.off('message', listener);
    },
  });
  port.on('close', detach);
  port.start();
}

await library.start();
log.info(`Indexer ready (data: ${dataDir})`);

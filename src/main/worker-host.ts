import { IpcChannel } from '@shared/desktop-api';
import { createLogger } from '@shared/log';
import type { Channel, RpcArgs, RpcResult } from '@shared/rpc';
import { isRpcMessage, RpcClient } from '@shared/rpc';
import type { WorkerHostApi } from '@shared/worker-api';
import { RENDERER_PORT_MESSAGE } from '@shared/worker-api';
import type { UtilityProcess, WebContents } from 'electron';
import { MessageChannelMain, utilityProcess } from 'electron';

const log = createLogger('worker-host');

const RESTART_DELAY_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface WorkerHostOptions {
  readonly entry: string;
  readonly dataDir: string;
  readonly resourcesDir: string;
  readonly appVersion: string;
}

/**
 * Runs the indexer in an Electron utility process, restarts it if it crashes, and gives every
 * window a direct MessagePort to it (so searches never transit through the main process).
 */
export class WorkerHost {
  private readonly options: WorkerHostOptions;
  private readonly windows = new Set<WebContents>();
  private child: UtilityProcess | null = null;
  private client: RpcClient<WorkerHostApi> | null = null;
  private stopping = false;

  constructor(options: WorkerHostOptions) {
    this.options = options;
  }

  start(): void {
    const child = utilityProcess.fork(
      this.options.entry,
      [
        `--data-dir=${this.options.dataDir}`,
        `--resources-dir=${this.options.resourcesDir}`,
        `--app-version=${this.options.appVersion}`,
      ],
      { serviceName: 'SG Tag Indexer', stdio: 'inherit' },
    );
    this.child = child;
    this.client = new RpcClient<WorkerHostApi>(channelFor(child));
    child.once('exit', (code) => {
      this.client?.dispose('The indexer process exited');
      this.child = null;
      this.client = null;
      if (!this.stopping) {
        log.error(`Indexer exited with code ${code}; restarting.`);
        setTimeout(() => {
          this.start();
        }, RESTART_DELAY_MS);
      }
    });
    // After a restart, windows need a port to the new process.
    for (const webContents of this.windows) {
      this.connect(webContents);
    }
  }

  /** Hands `webContents` a fresh MessagePort to the indexer. */
  connect(webContents: WebContents): void {
    if (!this.windows.has(webContents)) {
      this.windows.add(webContents);
      webContents.once('destroyed', () => this.windows.delete(webContents));
    }
    if (!this.child) {
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage(RENDERER_PORT_MESSAGE, [port1]);
    webContents.postMessage(IpcChannel.workerPort, null, [port2]);
  }

  call<K extends keyof WorkerHostApi>(
    method: K,
    ...args: RpcArgs<WorkerHostApi, K>
  ): Promise<RpcResult<WorkerHostApi, K>> {
    if (!this.client) {
      return Promise.reject(new Error('The indexer is not running'));
    }
    return this.client.call(method, ...args);
  }

  /** Asks the indexer to flush and close its database, then terminates it. */
  async stop(): Promise<void> {
    this.stopping = true;
    const { child, client } = this;
    if (!child || !client) {
      return;
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
    await Promise.race([client.call('shutdown').catch(() => undefined), timeout]);
    child.kill();
  }
}

function channelFor(child: UtilityProcess): Channel {
  return {
    send: (message) => {
      child.postMessage(message);
    },
    listen: (handler) => {
      const listener = (message: unknown): void => {
        if (isRpcMessage(message)) {
          handler(message);
        }
      };
      child.on('message', listener);
      return () => child.off('message', listener);
    },
  };
}

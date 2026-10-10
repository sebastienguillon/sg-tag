import { DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { WORKER_PORT_MESSAGE } from '@shared/desktop-api';
import type { Channel, RpcArgs, RpcResult } from '@shared/rpc';
import { isRpcMessage, RpcClient } from '@shared/rpc';
import type { LibraryApi, LibraryEvents } from '@shared/worker-api';
import { DESKTOP } from './desktop';

type Listener<K extends keyof LibraryEvents> = (payload: LibraryEvents[K]) => void;

/** Every event name, checked for completeness against the contract. */
const EVENT_NAMES = Object.keys({
  status: true,
  filesChanged: true,
  mediaChanged: true,
  tagsChanged: true,
  rootsChanged: true,
} satisfies Record<keyof LibraryEvents, true>) as (keyof LibraryEvents)[];

/**
 * Talks to the indexer worker over a MessagePort that the main process hands to this window.
 * If the indexer restarts, a new port arrives: calls resume on it and `generation` increments so
 * that state derived from the worker can be reloaded.
 */
@Injectable({ providedIn: 'root' })
export class WorkerClient {
  private readonly desktop = inject(DESKTOP);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly listeners = new Map<keyof LibraryEvents, Set<(payload: never) => void>>();
  private readonly firstConnection = Promise.withResolvers<RpcClient<LibraryApi, LibraryEvents>>();
  private client: RpcClient<LibraryApi, LibraryEvents> | null = null;
  private port: MessagePort | null = null;
  private readonly connections = signal(0);

  /** Increments on every (re)connection to the indexer. */
  readonly generation = this.connections.asReadonly();

  constructor() {
    this.view?.addEventListener('message', (event) => {
      const [port] = event.ports;
      if (event.source === this.view && event.data === WORKER_PORT_MESSAGE && port) {
        this.attach(port);
      }
    });
    this.desktop.requestWorkerPort();
  }

  async call<K extends keyof LibraryApi>(
    method: K,
    ...args: RpcArgs<LibraryApi, K>
  ): Promise<RpcResult<LibraryApi, K>> {
    const client = this.client ?? (await this.firstConnection.promise);
    return client.call(method, ...args);
  }

  /** Subscribes to an indexer event, across reconnections. Returns the unsubscribe function. */
  on<K extends keyof LibraryEvents>(name: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private attach(port: MessagePort): void {
    this.client?.dispose('The indexer connection was replaced');
    this.port?.close();
    const client = new RpcClient<LibraryApi, LibraryEvents>(portChannel(port));
    for (const name of EVENT_NAMES) {
      client.on(name, (payload) => {
        this.dispatch(name, payload);
      });
    }
    port.start();
    this.port = port;
    this.client = client;
    this.firstConnection.resolve(client);
    this.connections.update((count) => count + 1);
  }

  private dispatch<K extends keyof LibraryEvents>(name: K, payload: LibraryEvents[K]): void {
    const set = this.listeners.get(name) as Set<Listener<K>> | undefined;
    set?.forEach((listener) => {
      listener(payload);
    });
  }
}

function portChannel(port: MessagePort): Channel {
  return {
    send: (message) => {
      port.postMessage(message);
    },
    listen: (handler) => {
      const listener = (event: MessageEvent): void => {
        if (isRpcMessage(event.data)) {
          handler(event.data);
        }
      };
      port.addEventListener('message', listener);
      return () => {
        port.removeEventListener('message', listener);
      };
    },
  };
}

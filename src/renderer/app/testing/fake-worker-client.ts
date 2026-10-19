import { signal } from '@angular/core';
import type { DesktopBridge } from '@shared/desktop-api';
import type { RpcArgs, RpcResult } from '@shared/rpc';
import type { LibraryApi, LibraryEvents } from '@shared/worker-api';

type Responder = (...args: never[]) => unknown;

/** Stands in for `WorkerClient`: scripted responses, recorded calls, emitted events. */
export class FakeWorkerClient {
  private readonly connections = signal(1);
  readonly generation = this.connections.asReadonly();
  readonly calls: { readonly method: keyof LibraryApi; readonly args: readonly unknown[] }[] = [];
  private readonly responders = new Map<keyof LibraryApi, Responder>();
  private readonly listeners = new Map<keyof LibraryEvents, Set<(payload: never) => void>>();

  /** Unscripted methods return a promise that never settles. */
  respond<K extends keyof LibraryApi>(
    method: K,
    responder: (
      ...args: RpcArgs<LibraryApi, K>
    ) => RpcResult<LibraryApi, K> | Promise<RpcResult<LibraryApi, K>>,
  ): void {
    this.responders.set(method, responder);
  }

  call<K extends keyof LibraryApi>(
    method: K,
    ...args: RpcArgs<LibraryApi, K>
  ): Promise<RpcResult<LibraryApi, K>> {
    this.calls.push({ method, args });
    const responder = this.responders.get(method) as
      | ((
          ...a: RpcArgs<LibraryApi, K>
        ) => RpcResult<LibraryApi, K> | Promise<RpcResult<LibraryApi, K>>)
      | undefined;
    return responder
      ? Promise.resolve(responder(...args))
      : new Promise<RpcResult<LibraryApi, K>>(() => undefined);
  }

  callsTo(method: keyof LibraryApi): readonly (readonly unknown[])[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  on<K extends keyof LibraryEvents>(
    name: K,
    listener: (payload: LibraryEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** As when the indexer restarts and a new port arrives. */
  reconnect(): void {
    this.connections.update((count) => count + 1);
  }

  emit<K extends keyof LibraryEvents>(name: K, payload: LibraryEvents[K]): void {
    const set = this.listeners.get(name) as Set<(payload: LibraryEvents[K]) => void> | undefined;
    set?.forEach((listener) => {
      listener(payload);
    });
  }
}

export const fakeDesktop: DesktopBridge = {
  platform: 'darwin',
  requestWorkerPort: () => undefined,
  pickFolder: () => Promise.resolve(null),
  openFile: () => Promise.resolve(),
  revealFile: () => Promise.resolve(),
  trashFile: () => Promise.resolve(),
  exportTags: () => Promise.resolve(null),
  openTagImport: () => Promise.resolve(null),
};

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

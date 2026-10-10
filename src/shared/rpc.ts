/**
 * Minimal typed request/response + event protocol over any message port
 * (DOM `MessagePort`, Electron `MessagePortMain`, `parentPort`, `UtilityProcess`).
 */

export type RpcMessage =
  | { readonly t: 'req'; readonly id: number; readonly method: string; readonly args: unknown[] }
  | { readonly t: 'res'; readonly id: number; readonly value: unknown }
  | { readonly t: 'err'; readonly id: number; readonly message: string }
  | { readonly t: 'evt'; readonly name: string; readonly payload: unknown };

/** Transport adapter: each side wraps its native port in one of these. */
export interface Channel {
  readonly send: (message: RpcMessage) => void;
  /** Registers the message handler and returns a function that detaches it. */
  readonly listen: (handler: (message: RpcMessage) => void) => () => void;
}

/** An API contract: an object type whose members are all functions. */
export type ApiShape<T> = { readonly [K in keyof T]: (...args: never[]) => unknown };

type Fn<T, K extends keyof T> = T[K] extends (...args: infer A) => infer R
  ? { readonly args: A; readonly result: Awaited<R> }
  : never;

export type RpcArgs<T, K extends keyof T> = Fn<T, K>['args'];
export type RpcResult<T, K extends keyof T> = Fn<T, K>['result'];

/** Server-side implementation of a contract: same signatures, sync or async. */
export type RpcHandlers<T extends ApiShape<T>> = {
  readonly [K in keyof T]: (...args: RpcArgs<T, K>) => RpcResult<T, K> | Promise<RpcResult<T, K>>;
};

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== 'object' || value === null || !('t' in value)) {
    return false;
  }
  const { t } = value;
  return t === 'req' || t === 'res' || t === 'err' || t === 'evt';
}

/** Serves `handlers` over `channel` and lets the server push typed events. */
export class RpcServer<T extends ApiShape<T>, E extends object = Record<string, never>> {
  private readonly channel: Channel;
  private readonly detach: () => void;

  constructor(channel: Channel, handlers: RpcHandlers<T>) {
    this.channel = channel;
    const table = handlers as unknown as Record<
      string,
      ((...args: unknown[]) => unknown) | undefined
    >;
    this.detach = channel.listen((message) => {
      if (message.t !== 'req') {
        return;
      }
      const handler = Object.hasOwn(table, message.method) ? table[message.method] : undefined;
      if (!handler) {
        channel.send({ t: 'err', id: message.id, message: `Unknown method "${message.method}"` });
        return;
      }
      void this.dispatch(message.id, () => handler(...message.args));
    });
  }

  emit<K extends keyof E & string>(name: K, payload: E[K]): void {
    this.channel.send({ t: 'evt', name, payload });
  }

  dispose(): void {
    this.detach();
  }

  private async dispatch(id: number, invoke: () => unknown): Promise<void> {
    try {
      this.channel.send({ t: 'res', id, value: await invoke() });
    } catch (error) {
      this.channel.send({ t: 'err', id, message: errorMessage(error) });
    }
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

/** Calls a remote contract `T` and receives its events `E`. */
export class RpcClient<T extends ApiShape<T>, E extends object = Record<string, never>> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly channel: Channel;
  private readonly detach: () => void;
  private closed = false;

  constructor(channel: Channel) {
    this.channel = channel;
    this.detach = channel.listen((message) => {
      switch (message.t) {
        case 'res':
          this.settle(message.id)?.resolve(message.value);
          break;
        case 'err':
          this.settle(message.id)?.reject(new Error(message.message));
          break;
        case 'evt':
          this.listeners.get(message.name)?.forEach((listener) => {
            listener(message.payload);
          });
          break;
        case 'req':
          break;
      }
    });
  }

  call<K extends keyof T & string>(method: K, ...args: RpcArgs<T, K>): Promise<RpcResult<T, K>> {
    if (this.closed) {
      return Promise.reject(new Error(`RPC channel closed (call to "${method}")`));
    }
    const id = this.nextId++;
    return new Promise<RpcResult<T, K>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.send({ t: 'req', id, method, args });
    });
  }

  on<K extends keyof E & string>(name: K, listener: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    const untyped = listener as (payload: unknown) => void;
    set.add(untyped);
    return () => set.delete(untyped);
  }

  /** Rejects every in-flight call; used when the underlying process goes away. */
  dispose(reason = 'RPC channel closed'): void {
    this.closed = true;
    this.detach();
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    this.pending.delete(id);
    return entry;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { describe, expect, it } from 'vitest';
import type { Channel, RpcMessage } from './rpc';
import { RpcClient, RpcServer } from './rpc';

interface Api {
  readonly add: (a: number, b: number) => number;
  readonly slow: (value: string) => Promise<string>;
  readonly fail: () => void;
}

interface Events {
  readonly ping: { readonly count: number };
}

/** Two connected in-memory channels with asynchronous delivery, like real ports. */
function channelPair(): [Channel, Channel] {
  const handlers: [((m: RpcMessage) => void)[], ((m: RpcMessage) => void)[]] = [[], []];
  const side = (self: 0 | 1): Channel => ({
    send: (message) => {
      const peer = handlers[self === 0 ? 1 : 0];
      queueMicrotask(() => {
        for (const handler of peer) {
          handler(structuredClone(message));
        }
      });
    },
    listen: (handler) => {
      handlers[self].push(handler);
      return () => handlers[self].splice(handlers[self].indexOf(handler), 1);
    },
  });
  return [side(0), side(1)];
}

function connect(): { client: RpcClient<Api, Events>; server: RpcServer<Api, Events> } {
  const [a, b] = channelPair();
  const server = new RpcServer<Api, Events>(b, {
    add: (x, y) => x + y,
    slow: async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value.toUpperCase();
    },
    fail: () => {
      throw new Error('boom');
    },
  });
  return { client: new RpcClient<Api, Events>(a), server };
}

describe('rpc', () => {
  it('resolves sync and async handlers, matching responses to requests', async () => {
    const { client } = connect();
    const [slow, sum] = await Promise.all([client.call('slow', 'abc'), client.call('add', 2, 3)]);
    expect(sum).toBe(5);
    expect(slow).toBe('ABC');
  });

  it('rejects with the handler error message', async () => {
    const { client } = connect();
    await expect(client.call('fail')).rejects.toThrow('boom');
  });

  it('delivers typed events', async () => {
    const { client, server } = connect();
    const received = new Promise<number>((resolve) => {
      client.on('ping', ({ count }) => {
        resolve(count);
      });
    });
    server.emit('ping', { count: 7 });
    expect(await received).toBe(7);
  });

  it('rejects pending and later calls once disposed', async () => {
    const { client } = connect();
    const pending = client.call('slow', 'x');
    client.dispose('gone');
    await expect(pending).rejects.toThrow('gone');
    await expect(client.call('add', 1, 1)).rejects.toThrow('closed');
  });
});

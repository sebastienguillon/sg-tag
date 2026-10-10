import { describe, expect, it } from 'vitest';
import { WorkPool } from './work-pool';

interface Deferred {
  readonly promise: Promise<undefined>;
  readonly resolve: (value: undefined) => void;
}

function controllablePool(concurrency: number, reserved: number, refill?: () => string[]) {
  const started: string[] = [];
  const running = new Map<string, Deferred>();
  const pool = new WorkPool<string>({
    concurrency,
    reserved,
    run: (item) => {
      started.push(item);
      const deferred = Promise.withResolvers<undefined>();
      running.set(item, deferred);
      return deferred.promise;
    },
    ...(refill ? { refill } : {}),
  });
  const finish = async (item: string): Promise<void> => {
    running.get(item)?.resolve(undefined);
    running.delete(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { pool, started, finish };
}

describe('WorkPool', () => {
  it('runs urgent work last-in-first-out', async () => {
    const { pool, started, finish } = controllablePool(1, 0);
    pool.pushUrgent('a');
    pool.pushUrgent('b');
    pool.pushUrgent('c');
    await finish('a');
    expect(started).toEqual(['a', 'c']);
  });

  it('keeps reserved slots free of background work', () => {
    const { pool, started } = controllablePool(3, 1);
    for (const item of ['b1', 'b2', 'b3', 'b4']) {
      pool.pushBackground(item);
    }
    expect(started).toEqual(['b1', 'b2']);
    pool.pushUrgent('u1');
    expect(started).toEqual(['b1', 'b2', 'u1']);
  });

  it('promotes queued background work when it becomes urgent', async () => {
    const { pool, started, finish } = controllablePool(2, 1);
    pool.pushBackground('b1');
    pool.pushBackground('b2');
    pool.pushBackground('b3');
    expect(pool.promote((item) => item === 'b3')).toBe(true);
    pool.kick();
    expect(started).toEqual(['b1', 'b3']);
    await finish('b1');
    expect(started).toEqual(['b1', 'b3', 'b2']);
  });

  it('refills background work until the source is drained, then waits for a kick', async () => {
    const batches = [['r1', 'r2'], [], ['r3']];
    let calls = 0;
    const { pool, started, finish } = controllablePool(2, 1, () => {
      calls++;
      return batches.shift() ?? [];
    });
    pool.kick();
    expect(started).toEqual(['r1']);
    await finish('r1');
    expect(started).toEqual(['r1', 'r2']);
    await finish('r2');
    expect(calls).toBe(2);
    pool.pushUrgent('u');
    await finish('u');
    expect(calls).toBe(2);
    pool.kick();
    expect(started).toEqual(['r1', 'r2', 'u', 'r3']);
  });
});

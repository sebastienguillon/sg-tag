import { describe, expect, it } from 'vitest';
import { createLimiter, mapLimit } from './async';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('createLimiter', () => {
  it('never runs more than `concurrency` tasks, even when new tasks arrive as slots free up', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    const first = Array.from({ length: 5 }, () => limit(task));
    // Late arrivals compete with queued waiters for released slots.
    await tick();
    const late = Array.from({ length: 5 }, () => limit(task));
    await Promise.all([...first, ...late]);
    expect(peak).toBe(2);
  });
});

describe('mapLimit', () => {
  it('preserves order', async () => {
    const result = await mapLimit([30, 10, 20], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });
    expect(result).toEqual([60, 20, 40]);
  });
});

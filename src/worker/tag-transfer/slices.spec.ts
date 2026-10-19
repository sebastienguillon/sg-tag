import { afterEach, describe, expect, it, vi } from 'vitest';
import { eachInSlices, Slicer } from './slices';

/** Each step takes `ms` of the fake clock. */
const takingMs = (ms: number): (() => void) => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  return () => {
    clock += ms;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Slicer', () => {
  it('is due once a slice of work spread over calls has taken the budget', async () => {
    const work = takingMs(3);
    const slicer = new Slicer();
    work();
    work();
    expect(slicer.due).toBe(false);
    work();
    expect(slicer.due).toBe(true);

    let served = false;
    setImmediate(() => {
      served = true;
    });
    await slicer.yield();
    expect(served).toBe(true);
    // A new slice.
    expect(slicer.due).toBe(false);
  });

  it('throws the reason it is aborted with when it yields', async () => {
    const controller = new AbortController();
    const slicer = new Slicer(controller.signal);
    await slicer.yield();

    controller.abort(new Error('Canceled.'));
    await expect(slicer.yield()).rejects.toThrow('Canceled.');
  });
});

describe('eachInSlices', () => {
  it('lets the event loop run once a slice has taken the budget', async () => {
    // The third step of 3 ms reaches the budget of 8 ms.
    const work = takingMs(3);
    let done = 0;
    let servedAfter = -1;
    setImmediate(() => {
      servedAfter = done;
    });
    const slices: number[] = [];

    await eachInSlices(
      [1, 2, 3, 4, 5],
      () => {
        work();
        done++;
      },
      { onSlice: (count) => slices.push(count) },
    );

    expect(servedAfter).toBe(3);
    expect(slices).toEqual([3, 5]);
  });

  it('goes on with the slice of the list before, given its slicer', async () => {
    // The three steps of 3 ms of the first list reach the budget of 8 ms on its last step.
    const work = takingMs(3);
    const slicer = new Slicer();
    let done = 0;
    let servedAfter = -1;
    setImmediate(() => {
      servedAfter = done;
    });
    const step = (): void => {
      work();
      done++;
    };

    await eachInSlices([1, 2, 3], step, { slicer });
    await eachInSlices([4, 5], step, { slicer });
    // Before the first step of the second list, not a slice of its own later.
    expect(servedAfter).toBe(3);
  });

  it('throws the reason it is aborted with at the next yield', async () => {
    const work = takingMs(5);
    const controller = new AbortController();
    const seen: number[] = [];

    const running = eachInSlices(
      [0, 1, 2, 3],
      (item) => {
        work();
        seen.push(item);
        if (item === 0) {
          controller.abort(new Error('Canceled.'));
        }
      },
      { signal: controller.signal },
    );

    await expect(running).rejects.toThrow('Canceled.');
    expect(seen).toEqual([0, 1]);
    await expect(eachInSlices([0], work, { signal: controller.signal })).rejects.toThrow(
      'Canceled.',
    );
  });
});

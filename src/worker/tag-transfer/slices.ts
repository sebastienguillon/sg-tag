import { setImmediate as yieldNow } from 'node:timers/promises';

export { yieldNow };

/**
 * Longest run of synchronous work between two yields: a search waits at most about this long.
 */
export const SLICE_BUDGET_MS = 8;

/**
 * Times synchronous work spread over several calls, for code that cannot hand it to
 * `eachInSlices` as one list: check `due` between two steps, and `yield` when it is. Handed to
 * `eachInSlices` too, a slice goes on from one list to the next.
 */
export class Slicer {
  private readonly signal: AbortSignal | undefined;
  private started = performance.now();

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  /** `SLICE_BUDGET_MS` of work ran since the slice started. */
  get due(): boolean {
    return performance.now() - this.started >= SLICE_BUDGET_MS;
  }

  /**
   * Lets the event loop run, so that renderer requests are served, then starts a new slice. Throws
   * the signal's reason once it is aborted.
   */
  async yield(): Promise<void> {
    await yieldNow();
    this.signal?.throwIfAborted();
    this.started = performance.now();
  }
}

/**
 * Runs `step` on each item, yielding to the event loop after every `SLICE_BUDGET_MS` of work, so
 * that renderer requests (searches, thumbnails) are served in between. Throws `signal`'s reason
 * once it is aborted. `onSlice` is told how many items are done after each slice, the last one
 * included. Work going through several lists one after another passes each the same `slicer`, so
 * that a slice goes on from one list to the next: each starts one of its own otherwise, and lists
 * of a few items each would add up to many slices without a yield.
 */
export async function eachInSlices<T>(
  items: readonly T[],
  step: (item: T, index: number) => void,
  options: {
    readonly signal?: AbortSignal;
    readonly slicer?: Slicer;
    readonly onSlice?: (done: number) => void;
  } = {},
): Promise<void> {
  const { signal, onSlice } = options;
  signal?.throwIfAborted();
  const slicer = options.slicer ?? new Slicer(signal);
  // The work before may have spent the slice.
  if (items.length > 0 && slicer.due) {
    await slicer.yield();
  }
  for (let index = 0; index < items.length; index++) {
    step(items[index] as T, index);
    if (index + 1 < items.length && slicer.due) {
      onSlice?.(index + 1);
      await slicer.yield();
    }
  }
  onSlice?.(items.length);
}

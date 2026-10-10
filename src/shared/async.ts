/** Returns a function that runs at most `concurrency` tasks at once, queueing the rest in FIFO order. */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  // A finishing task hands its slot straight to the next waiter, so newcomers cannot overtake it.
  const release = (): void => {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** Maps `items` through `fn` with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

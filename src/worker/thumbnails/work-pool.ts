export interface WorkPoolOptions<T> {
  readonly concurrency: number;
  /** Slots that background work may not use, so urgent work always starts right away. */
  readonly reserved: number;
  readonly run: (item: T) => Promise<void>;
  /** Supplies more background work when the queue runs dry; an empty answer parks it until `kick()`. */
  readonly refill?: () => readonly T[];
}

/**
 * Bounded-concurrency scheduler with two queues:
 * - urgent work is LIFO: while scrolling fast, the tiles on screen now beat those scrolled past;
 * - background work is FIFO and only uses the non-reserved slots.
 */
export class WorkPool<T> {
  private readonly options: WorkPoolOptions<T>;
  private readonly urgent: T[] = [];
  private readonly background: T[] = [];
  private active = 0;
  private activeBackground = 0;
  private drained = false;

  constructor(options: WorkPoolOptions<T>) {
    this.options = options;
  }

  get backgroundSize(): number {
    return this.background.length;
  }

  pushUrgent(item: T): void {
    this.urgent.push(item);
    this.pump();
  }

  pushBackground(item: T): void {
    this.background.push(item);
    this.pump();
  }

  /** Moves a queued item to the front of the urgent queue. Returns false if it was not queued. */
  promote(matches: (item: T) => boolean): boolean {
    for (const queue of [this.urgent, this.background]) {
      const index = queue.findIndex(matches);
      if (index !== -1) {
        const [item] = queue.splice(index, 1);
        this.urgent.push(item as T);
        return true;
      }
    }
    return false;
  }

  /** Asks `refill` again, e.g. after new files were indexed. */
  kick(): void {
    this.drained = false;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.options.concurrency) {
      const urgent = this.urgent.pop();
      if (urgent !== undefined) {
        this.start(urgent, false);
        continue;
      }
      if (this.activeBackground >= this.options.concurrency - this.options.reserved) {
        return;
      }
      const background = this.background.shift() ?? this.refill();
      if (background === undefined) {
        return;
      }
      this.start(background, true);
    }
  }

  private refill(): T | undefined {
    if (this.drained || !this.options.refill) {
      return undefined;
    }
    const items = this.options.refill();
    this.drained = items.length === 0;
    this.background.push(...items);
    return this.background.shift();
  }

  private start(item: T, isBackground: boolean): void {
    this.active++;
    if (isBackground) {
      this.activeBackground++;
    }
    void this.options
      .run(item)
      .catch(() => undefined)
      .finally(() => {
        this.active--;
        if (isBackground) {
          this.activeBackground--;
        }
        this.pump();
      });
  }
}

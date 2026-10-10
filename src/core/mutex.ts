// Minimal async mutex (FIFO). Used for read-modify-write critical sections on
// IndexedDB records. Not re-entrant: never call a locked function from inside
// another locked section, and never hold it while waiting for page loads.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  get locked(): boolean {
    return this.depth > 0;
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    this.depth++;
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        this.depth--;
        release();
      }
    });
  }
}

/** Global lock for every read-modify-write of records / ops performed by the background. */
export const dbLock = new Mutex();

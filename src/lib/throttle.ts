/** Injectable clock + a leading/trailing throttle. Everything time-based in the card takes a
 * `Scheduler` so tests drive it with a fake clock instead of real timers. */

export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Send the pending call now (used when a drag ends, so the final value is never held back). */
  flush(): void;
  /** Drop the pending call. */
  cancel(): void;
  readonly pending: boolean;
}

/** Calls `fn` at most once per `intervalMs`: the first call goes out immediately, calls arriving
 * inside the window collapse to the LAST one, sent when the window closes. Successive sends are
 * always at least `intervalMs` apart, so 250 ms means never more than 4 per second. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, intervalMs: number, scheduler: Scheduler = realScheduler): Throttled<A> {
  let lastSent = -Infinity;
  let timer: unknown = null;
  let waiting: A | null = null;

  const send = (args: A): void => {
    lastSent = scheduler.now();
    fn(...args);
  };

  const throttled = ((...args: A): void => {
    const elapsed = scheduler.now() - lastSent;
    if (elapsed >= intervalMs && timer === null) {
      send(args);
      return;
    }
    waiting = args;
    if (timer !== null) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      const args = waiting;
      waiting = null;
      if (args) send(args);
    }, Math.max(0, intervalMs - elapsed));
  }) as Throttled<A>;

  throttled.flush = () => {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    const args = waiting;
    waiting = null;
    if (args) send(args);
  };
  throttled.cancel = () => {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    waiting = null;
  };
  Object.defineProperty(throttled, "pending", { get: () => waiting !== null });
  return throttled;
}

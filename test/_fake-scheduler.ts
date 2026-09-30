/** Deterministic clock for the time-based tests: timers fire only when `advance` moves time. */

import type { Scheduler } from "../src/lib/throttle.ts";

interface Timer {
  at: number;
  callback: () => void;
}

export class FakeScheduler implements Scheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Move time forward, firing every timer that falls due (in order, including timers they add). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let dueId = -1;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === -1) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.time = Math.max(this.time, timer.at);
      timer.callback();
    }
    this.time = target;
  }
}

/** Let already-resolved promise chains run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

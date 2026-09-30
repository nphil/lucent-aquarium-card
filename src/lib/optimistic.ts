/** Optimistic values: what a control shows between the user's gesture and Home Assistant's echo.
 *
 * While the user drags, the control shows their value, not the (older) entity state. When the
 * entity catches up the override is dropped; if it never does (the command failed or the light
 * ignored it) the override expires after `holdMs` and the control snaps back to the truth. The
 * card never claims a value the light has not confirmed for longer than that.
 */

import type { Scheduler } from "./throttle.ts";

interface Entry<V> {
  value: V;
  until: number;
}

export class OptimisticStore<K extends string, V> {
  private readonly entries = new Map<K, Entry<V>>();

  constructor(
    private readonly holdMs: number,
    private readonly scheduler: Scheduler,
    private readonly equals: (a: V, b: V) => boolean = (a, b) => a === b,
  ) {}

  /** Show `value` for `key` until the entity agrees or `holdMs` passes. */
  set(key: K, value: V): void {
    this.entries.set(key, { value, until: this.scheduler.now() + this.holdMs });
  }

  /** Keep showing the current override a little longer (the user is still interacting). */
  extend(key: K): void {
    const entry = this.entries.get(key);
    if (entry) entry.until = this.scheduler.now() + this.holdMs;
  }

  /** Value to display: the override while it is live and the entity disagrees, else `server`. */
  get(key: K, server: V): V {
    const entry = this.entries.get(key);
    if (!entry) return server;
    if (this.equals(entry.value, server) || this.scheduler.now() >= entry.until) {
      this.entries.delete(key);
      return server;
    }
    return entry.value;
  }

  /** The live override, if there is one, with nothing to compare it against (the light has said
   * nothing about this value). An expired override is dropped and reads as none. */
  peek(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.scheduler.now() >= entry.until) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && this.scheduler.now() < entry.until;
  }

  /** Drop expired overrides; returns the time until the earliest live one expires, or null. */
  prune(): number | null {
    let soonest: number | null = null;
    const now = this.scheduler.now();
    for (const [key, entry] of this.entries) {
      const remaining = entry.until - now;
      if (remaining <= 0) {
        this.entries.delete(key);
      } else if (soonest === null || remaining < soonest) {
        soonest = remaining;
      }
    }
    return soonest;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** What the card remembers about a light between visits: its last brightness and colour. Home
 * Assistant reports neither while a light is off, so without this the sliders would fall to zero.
 *
 * Saved values are only meaningful once the light's channel count is known: some lights (a Fluval)
 * learn their channels a moment after the card loads. Until then nothing is restored AND nothing is
 * written, because writing first would overwrite what an earlier visit saved with a value that has
 * no colour in it. Pure apart from the injected storage, so it can be tested without a browser.
 */

import { clampPercent, type Levels } from "./channels.ts";

export interface LastKnown {
  brightness: number;
  levels: Levels | null;
}

/** The part of `Storage` this needs. */
export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where saved values are put back (the device controller). */
export interface Remembers {
  remember(saved: LastKnown): void;
}

/** A saved value, validated: it came from storage, so nothing about it can be trusted. Levels that
 * do not fit `channelCount` are dropped; the brightness alone is still worth keeping. */
export function parseLastKnown(raw: string | null, channelCount: number): LastKnown | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("brightness" in parsed)) return null;
  const brightness = Number(parsed.brightness);
  if (!Number.isFinite(brightness)) return null;
  let levels: Levels | null = null;
  if ("levels" in parsed && Array.isArray(parsed.levels) && parsed.levels.length === channelCount) {
    const values = parsed.levels.map(Number);
    if (values.every((n) => Number.isFinite(n))) levels = values.map(clampPercent);
  }
  return { brightness: Math.min(100, Math.max(1, Math.round(brightness))), levels };
}

/** `window.localStorage`, or null where reading it throws (sandboxed frames, blocked storage). */
export function browserStorage(): MemoryStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export class LastKnownMemory {
  private restored = false;
  private saved = "";

  constructor(
    private readonly key: string,
    private readonly storage: MemoryStorage | null,
  ) {}

  /** Whether the saved values have been put back (persisting is not allowed before that). */
  get isRestored(): boolean {
    return this.restored;
  }

  /** Put the saved values back into `target` once the channel count is known (`channelCount` > 0);
   * before that it does nothing and can simply be called again on the next update. */
  restore(target: Remembers, channelCount: number): void {
    if (this.restored || channelCount <= 0 || !this.storage) return;
    this.restored = true;
    try {
      const saved = parseLastKnown(this.storage.getItem(this.key), channelCount);
      if (saved) target.remember(saved);
    } catch {
      // Blocked storage: start from defaults.
    }
  }

  /** Save the values while the light is on (Home Assistant reports nothing while it is off). */
  persist(current: LastKnown, on: boolean): void {
    if (!this.restored || !on || !this.storage) return;
    const value = JSON.stringify(current);
    if (value === this.saved) return;
    try {
      this.storage.setItem(this.key, value);
      this.saved = value;
    } catch {
      // Private mode or quota: the memory is a convenience only.
    }
  }
}

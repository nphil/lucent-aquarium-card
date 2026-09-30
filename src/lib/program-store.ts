/** Per-program cache of what a light (or its preset table) reports for each schedule program.
 *
 * Loads are de-duplicated (asking twice while a read is in flight shares it), a failed read keeps
 * the last good points so the chart can still show them marked as stale, and `reset()` (another
 * light) makes any read still in flight land nowhere. Program ids are opaque strings owned by the
 * light's adapter.
 *
 * `refresh` means the user asked to read the light again ("Reload from the light"): it is passed
 * to the adapter, and it is never swallowed by a plain read that happens to be in flight; it
 * waits for that read and then asks again.
 */

import type { ProgramData, ProgramReadOptions } from "../adapters/types.ts";

export type ProgramLoadStatus = "idle" | "loading" | "ready" | "error";

export interface ProgramEntry {
  status: ProgramLoadStatus;
  /** Last good data. Kept through a reload and after a failure (then shown as stale). */
  data: ProgramData | null;
  error: string | null;
}

export interface ProgramLoadOptions extends ProgramReadOptions {
  /** Read again even when the program is already loaded. */
  force?: boolean;
}

const EMPTY: ProgramEntry = { status: "idle", data: null, error: null };

export class ProgramStore {
  private readonly entries = new Map<string, ProgramEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** Ids whose running read asks the light itself. */
  private readonly refreshing = new Set<string>();
  private generation = 0;

  constructor(
    private readonly fetcher: (id: string, options: ProgramReadOptions) => Promise<ProgramData>,
    private readonly onChange: () => void,
    private readonly describe: (error: unknown) => string,
  ) {}

  entry(id: string): ProgramEntry {
    return this.entries.get(id) ?? EMPTY;
  }

  /** Read `id` unless it is already loaded (or loading). `force` re-reads regardless. */
  load(id: string, options: ProgramLoadOptions = {}): Promise<void> {
    const refresh = options.refresh === true;
    const running = this.inflight.get(id);
    if (running) {
      if (!refresh || this.refreshing.has(id)) return running;
      // A plain read is under way but the light must be asked again: read again behind it.
      return running.then(() => this.load(id, { ...options, force: true }));
    }
    const current = this.entry(id);
    if (!options.force && !refresh && current.status === "ready") return Promise.resolve();

    const generation = this.generation;
    this.entries.set(id, { ...current, status: "loading", error: null });
    if (refresh) this.refreshing.add(id);
    this.onChange();
    const task = this.fetcher(id, { refresh }).then(
      (data) => {
        if (generation !== this.generation) return;
        this.entries.set(id, { status: "ready", data, error: null });
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.entries.set(id, { status: "error", data: current.data, error: this.describe(error) });
      },
    );
    const tracked = task.finally(() => {
      if (this.inflight.get(id) === tracked) {
        this.inflight.delete(id);
        this.refreshing.delete(id);
      }
      if (generation === this.generation) this.onChange();
    });
    this.inflight.set(id, tracked);
    return tracked;
  }

  /** Record data the light just confirmed (the read-back after a save). */
  put(id: string, data: ProgramData): void {
    this.entries.set(id, { status: "ready", data, error: null });
    this.onChange();
  }

  /** Forget everything (the card now points at another light). */
  reset(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
    this.refreshing.clear();
    this.onChange();
  }
}

/** Live preview on the light while a schedule point is being edited.
 *
 * - Sends are throttled to at most 4 per second, latest colour wins (BLE is slow and the light
 *   only needs the newest value).
 * - The light ends a preview by itself after about 30 s without a frame, so a session that is
 *   still open re-sends the last colour every 20 s: the card must not say "Previewing" while the
 *   light has quietly gone back to normal.
 * - A session that nobody has touched for 3 minutes ends itself and says so: an editor left open
 *   must not hold the tank lights hostage forever.
 * - `end()` sends the end frame if anything was ever sent, and only after a colour still in flight
 *   has been answered, so the end cannot overtake the colour it is meant to cancel.
 * - Frames are strictly ordered across a quick stop and restart. A restarted session's first
 *   colour waits behind the previous session's end frame: if it went first, the late end frame
 *   would cancel the colour the user is looking at.
 * - Every `end()` starts a new session. A late answer belonging to an earlier session (a slow
 *   colour that failed, an end frame that failed) is ignored, so it cannot mark the current
 *   session as errored or stopped.
 */

import type { Levels } from "./channels.ts";
import { realScheduler, throttle, type Scheduler, type Throttled } from "./throttle.ts";

export const PREVIEW_INTERVAL_MS = 250;
export const PREVIEW_KEEPALIVE_MS = 20_000;
export const PREVIEW_IDLE_MS = 180_000;

export interface PreviewIO {
  show(levels: Levels): Promise<void>;
  end(): Promise<void>;
}

export type PreviewPhase = "idle" | "active" | "error";

export interface PreviewStatus {
  phase: PreviewPhase;
  /** Why the last preview stopped, when the session ended itself. */
  endedBy?: "user" | "idle";
  message?: string;
}

export interface PreviewOptions {
  scheduler?: Scheduler;
  intervalMs?: number;
  keepAliveMs?: number;
  idleMs?: number;
  onStatus?: (status: PreviewStatus) => void;
  describeError?: (error: unknown) => string;
}

export class PreviewSession {
  private readonly scheduler: Scheduler;
  private readonly keepAliveMs: number;
  private readonly idleMs: number;
  private readonly sendLatest: Throttled<[Levels]>;
  /** Identity of the current session; bumped by every `end()`. */
  private generation = 0;
  /** A colour of the current session has been handed to the light. */
  private started = false;
  private latest: Levels | null = null;
  private inflight: Promise<void> = Promise.resolve();
  /** The previous session's end frame is still on its way. */
  private ending: Promise<void> | null = null;
  /** A colour of the current session is waiting for `ending` to finish. */
  private queued = false;
  private keepAliveTimer: unknown = null;
  private idleTimer: unknown = null;
  private current: PreviewStatus = { phase: "idle" };

  constructor(
    private readonly io: PreviewIO,
    private readonly options: PreviewOptions = {},
  ) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.keepAliveMs = options.keepAliveMs ?? PREVIEW_KEEPALIVE_MS;
    this.idleMs = options.idleMs ?? PREVIEW_IDLE_MS;
    this.sendLatest = throttle((levels: Levels) => this.transmit(levels), options.intervalMs ?? PREVIEW_INTERVAL_MS, this.scheduler);
  }

  get status(): PreviewStatus {
    return this.current;
  }

  /** Show `levels` on the light (call on every gesture that changes what should be shown). */
  show(levels: Levels): void {
    this.latest = levels;
    this.restartIdleTimer();
    if (this.current.phase === "idle") this.setStatus({ phase: "active" });
    this.sendLatest(levels);
  }

  /** Stop previewing; the light returns to what it was doing. Safe to call any number of times.
   * Resolves once the end frame (if one was needed) has been answered. */
  end(reason: "user" | "idle" = "user"): Promise<void> {
    this.sendLatest.cancel();
    this.clearTimers();
    this.latest = null;
    this.queued = false;
    this.generation += 1;
    const shouldEnd = this.started;
    this.started = false;
    if (this.current.phase !== "idle" || shouldEnd) this.setStatus({ phase: "idle", endedBy: reason });
    // Nothing of this session ever reached the light: there is nothing to end. A previous
    // session's end frame may still be on its way; callers can wait for that.
    if (!shouldEnd) return this.ending ?? Promise.resolve();

    const generation = this.generation;
    const ending = this.sendEnd(reason, generation, this.inflight);
    this.ending = ending;
    void ending.then(() => {
      if (this.ending !== ending) return;
      this.ending = null;
      this.resumeQueued();
    });
    return ending;
  }

  dispose(): void {
    void this.end("user");
  }

  private async sendEnd(reason: "user" | "idle", generation: number, inflight: Promise<void>): Promise<void> {
    await inflight;
    try {
      await this.io.end();
    } catch (error) {
      // If the user has restarted the preview meanwhile, the new colour replaces whatever the
      // light is still showing, and the new session's status is not this frame's to change.
      if (generation === this.generation && this.current.phase === "idle") this.setStatus({ phase: "idle", endedBy: reason, message: this.describe(error) });
    }
  }

  /** The end frame is done: send the colour that was waiting behind it, if the user still wants one. */
  private resumeQueued(): void {
    if (!this.queued) return;
    this.queued = false;
    if (this.current.phase === "idle" || !this.latest) return;
    // A trailing colour from the throttle is the newest; otherwise send the newest one directly.
    if (this.sendLatest.pending) this.sendLatest.flush();
    else this.transmit(this.latest);
  }

  private transmit(levels: Levels): void {
    if (this.ending) {
      this.queued = true;
      return;
    }
    this.started = true;
    this.restartKeepAlive();
    const generation = this.generation;
    this.inflight = this.io.show(levels).then(
      () => {
        if (generation === this.generation && this.current.phase === "error") this.setStatus({ phase: "active" });
      },
      (error: unknown) => {
        if (generation === this.generation && this.current.phase !== "idle") this.setStatus({ phase: "error", message: this.describe(error) });
      },
    );
  }

  private restartKeepAlive(): void {
    if (this.keepAliveTimer !== null) this.scheduler.clearTimeout(this.keepAliveTimer);
    const generation = this.generation;
    this.keepAliveTimer = this.scheduler.setTimeout(() => {
      this.keepAliveTimer = null;
      if (generation === this.generation && this.latest && this.current.phase !== "idle") this.transmit(this.latest);
    }, this.keepAliveMs);
  }

  private restartIdleTimer(): void {
    if (this.idleTimer !== null) this.scheduler.clearTimeout(this.idleTimer);
    const generation = this.generation;
    this.idleTimer = this.scheduler.setTimeout(() => {
      this.idleTimer = null;
      if (generation === this.generation) void this.end("idle");
    }, this.idleMs);
  }

  private clearTimers(): void {
    if (this.keepAliveTimer !== null) this.scheduler.clearTimeout(this.keepAliveTimer);
    if (this.idleTimer !== null) this.scheduler.clearTimeout(this.idleTimer);
    this.keepAliveTimer = null;
    this.idleTimer = null;
  }

  private describe(error: unknown): string {
    return this.options.describeError?.(error) ?? (error instanceof Error ? error.message : "Preview failed.");
  }

  private setStatus(status: PreviewStatus): void {
    this.current = status;
    this.options.onStatus?.(status);
  }
}

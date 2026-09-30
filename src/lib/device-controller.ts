/** Everything the card does to a light, with the honesty rules in one place. Integration
 * specifics live behind `AdapterCommands`; this class owns the behaviour every light shares.
 *
 * - Drags (brightness, one colour channel) are throttled, latest value wins, and the final value
 *   is flushed when the gesture ends.
 * - Colour goes out as ONLY the channels the user moved, never a rewrite of all of them from the
 *   card's local copy, which could clobber a channel that changed elsewhere meanwhile.
 * - What the controls show is an optimistic overlay on the light's state, dropped the moment the
 *   light agrees and after a few seconds if it never does; a failed call removes the overlay at
 *   once and reports the reason. The card never leaves a value on screen the light refused.
 * - Home Assistant drops a light's colour and brightness while it is off, and some lights never
 *   report channel levels, so the last known values are remembered for the sliders to keep
 *   showing. "Known" means confirmed: what the light reported, or what it accepted. A colour that
 *   is still on its way (or was refused) lives only in the optimistic overlay, so it can neither
 *   linger on screen after a failure nor be saved as the light's colour.
 */

import type { AdapterCommands, DeviceModel, RunKind } from "../adapters/types.ts";
import { clamp, clampPercent, levelsEqual, zeroLevels, type Levels } from "./channels.ts";
import { describeError } from "./errors.ts";
import { OptimisticStore } from "./optimistic.ts";
import { realScheduler, throttle, type Scheduler, type Throttled } from "./throttle.ts";

/** Gap between sends while a slider is dragged (5 a second; the lights drop faster frames). */
export const SEND_INTERVAL_MS = 200;
/** How long a dragged value may outlive the gesture waiting for the light to agree. */
export const HOLD_MS = 2500;
/** Scene/program changes take a BLE round trip plus a status refresh. */
export const SELECTION_HOLD_MS = 5000;

export type CommandKind = "colour" | "effect" | "schedule" | "power";

export interface ControllerHooks {
  /** Optimistic values changed or expired: re-render. */
  onChange(): void;
  /** A call failed; `message` is human-readable. */
  onError(message: string): void;
  /** The user issued a command of this kind (a running Demo ends on colour/effect/schedule). */
  onCommand?(kind: CommandKind): void;
}

interface Running {
  kind: RunKind;
  effectId: string | null;
  scheduleId: string | null;
}

function runningOf(model: DeviceModel): Running {
  return { kind: model.running.kind, effectId: model.running.effectId ?? null, scheduleId: model.running.scheduleId ?? null };
}

function runningEquals(a: Running, b: Running): boolean {
  return a.kind === b.kind && a.effectId === b.effectId && a.scheduleId === b.scheduleId;
}

export class DeviceController {
  private readonly power: OptimisticStore<"v", boolean>;
  private readonly brightness: OptimisticStore<"v", number>;
  private readonly levels: OptimisticStore<"v", Levels>;
  private readonly running: OptimisticStore<"v", Running>;
  private readonly sendBrightness: Throttled<[number]>;
  private readonly sendChannels: Throttled<[]>;
  private readonly scheduler: Scheduler;
  private pendingChannels: Record<number, number> = {};
  private expiryTimer: unknown = null;
  private disposed = false;
  private phase: DeviceModel["phase"] = "loading";
  private last: { brightness: number; levels: Levels | null } = { brightness: 100, levels: null };
  /** Which parts of `last` this session has learned from the light (a saved copy never overrides them). */
  private learned = { brightness: false, levels: false };
  private shownLevels: Levels | null = null;
  private channelCount = 0;

  constructor(
    private readonly commands: () => AdapterCommands,
    private readonly hooks: ControllerHooks,
    scheduler: Scheduler = realScheduler,
  ) {
    this.scheduler = scheduler;
    this.power = new OptimisticStore(HOLD_MS, scheduler);
    this.brightness = new OptimisticStore(HOLD_MS, scheduler);
    this.levels = new OptimisticStore(HOLD_MS, scheduler, levelsEqual);
    this.running = new OptimisticStore(SELECTION_HOLD_MS, scheduler, runningEquals);
    this.sendBrightness = throttle((percent: number) => {
      void this.run(() => this.commands().setBrightness(percent), () => this.brightness.delete("v"));
    }, SEND_INTERVAL_MS, scheduler);
    this.sendChannels = throttle(() => this.dispatchChannels(), SEND_INTERVAL_MS, scheduler);
  }

  /** The light's model with the user's not-yet-confirmed changes laid over it. */
  display(server: DeviceModel): DeviceModel {
    this.channelCount = server.channels.length;
    if (server.phase === "loading") {
      this.phase = server.phase;
      return server;
    }
    if (server.phase === "on" && server.brightness !== null) {
      this.last = { ...this.last, brightness: server.brightness };
      this.learned.brightness = true;
    }
    if (server.phase === "on" && server.levels) {
      this.last = { ...this.last, levels: server.levels };
      this.learned.levels = true;
    }

    if (server.phase === "unavailable") {
      // Nothing can be changed, so no overlay; the sliders keep the last known values (dimmed by
      // the panel) rather than claiming zeros the light never reported.
      this.phase = server.phase;
      return { ...server, brightness: server.hasBrightness ? this.last.brightness : null, levels: server.levels ?? this.last.levels };
    }

    const on = this.power.get("v", server.phase === "on");
    this.phase = on ? "on" : "off";
    const running = this.running.get("v", runningOf(server));
    // A colour on its way is shown even when the light has said nothing about its levels.
    const baseLevels = server.levels ?? this.last.levels;
    this.shownLevels = baseLevels === null ? (this.levels.peek("v") ?? null) : this.levels.get("v", baseLevels);
    const overlaid = !runningEquals(running, runningOf(server));
    return {
      ...server,
      phase: this.phase,
      brightness: server.hasBrightness ? this.brightness.get("v", server.brightness ?? this.last.brightness) : null,
      levels: this.shownLevels,
      running: { kind: running.kind, effectId: running.effectId, scheduleId: running.scheduleId },
      effects: server.effects && overlaid ? { ...server.effects, runningId: running.kind === "effect" ? running.effectId : null } : server.effects,
      schedule: server.schedule && overlaid ? { ...server.schedule, runningId: running.kind === "schedule" ? running.scheduleId : null } : server.schedule,
    };
  }

  /** A scene or schedule change is waiting for the light to confirm. */
  get selectionPending(): boolean {
    return this.running.has("v");
  }

  get powerPending(): boolean {
    return this.power.has("v");
  }

  /** Seed the values shown while the light is off from an earlier visit. It only fills what this
   * session has not learned from the light itself: a saved copy can arrive late (some lights
   * cannot say how many channels they have at first) and must never overwrite fresher values. */
  remember(saved: { brightness: number; levels: Levels | null }): void {
    this.last = {
      brightness: this.learned.brightness ? this.last.brightness : saved.brightness,
      levels: this.learned.levels || saved.levels === null ? this.last.levels : saved.levels,
    };
  }

  /** The last values the light reported or accepted (for persisting across reloads). */
  get lastKnown(): { brightness: number; levels: Levels | null } {
    return this.last;
  }

  setPower(on: boolean): void {
    if (this.disposed) return;
    this.hooks.onCommand?.("power");
    this.power.set("v", on);
    this.changed();
    void this.run(() => this.commands().setPower(on), () => this.power.delete("v"));
  }

  /** Master brightness, percent 1-100. `commit` marks the end of a drag (flush the final value).
   * Brightness alone never changes the light's mode. */
  setBrightness(percent: number, commit: boolean): void {
    if (this.disposed) return;
    const value = Math.round(clamp(percent, 1, 100));
    this.brightness.set("v", value);
    if (this.phase === "off") this.power.set("v", true);
    this.changed();
    this.sendBrightness(value);
    if (commit) this.sendBrightness.flush();
  }

  /** Move ONE colour channel (a slider drag). Sending a colour puts a scene/schedule light into
   * manual mode. */
  setChannel(index: number, percent: number, commit: boolean): void {
    this.queueChannels({ [index]: clampPercent(percent) }, commit);
  }

  /** Set the whole mix at once (a swatch). */
  setLevels(levels: Levels, commit: boolean): void {
    const all: Record<number, number> = {};
    levels.forEach((level, index) => (all[index] = clampPercent(level)));
    this.queueChannels(all, commit);
  }

  selectEffect(id: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.hooks.onCommand?.("effect");
    this.running.set("v", { kind: "effect", effectId: id, scheduleId: null });
    this.changed();
    return this.run(() => this.commands().selectEffect(id), () => this.running.delete("v"));
  }

  /** Start the Demo (the adapter refuses when it cannot run). */
  playDemo(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return this.run(() => this.commands().playDemo(), () => undefined);
  }

  activateSchedule(id: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.hooks.onCommand?.("schedule");
    this.running.set("v", { kind: "schedule", effectId: null, scheduleId: id });
    this.changed();
    return this.run(() => this.commands().activateSchedule(id), () => this.running.delete("v"));
  }

  /** Send anything still waiting on the throttle (the card is going away mid-drag). */
  flush(): void {
    this.sendBrightness.flush();
    this.sendChannels.flush();
  }

  /** Send what is waiting, then stop for good: a disposed controller drops every later command
   * (a stray event from a view that is being replaced), so nothing is sent after it. */
  dispose(): void {
    this.flush();
    this.disposed = true;
    if (this.expiryTimer !== null) this.scheduler.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private queueChannels(changes: Record<number, number>, commit: boolean): void {
    if (this.disposed) return;
    this.hooks.onCommand?.("colour");
    this.pendingChannels = { ...this.pendingChannels, ...changes };
    // Build on what is shown, including earlier changes not yet rendered, so two sliders moved in
    // the same frame both survive.
    const base = this.shownLevels ?? this.last.levels ?? zeroLevels(this.channelCount);
    const next = base.map((level, index) => changes[index] ?? level);
    this.shownLevels = next;
    this.levels.set("v", next);
    this.running.set("v", { kind: "manual", effectId: null, scheduleId: null });
    if (this.phase === "off") {
      // A channel write does not wake a light that is off; the power-on goes first.
      this.power.set("v", true);
      void this.run(() => this.commands().setPower(true), () => this.power.delete("v"));
    }
    this.changed();
    this.sendChannels();
    if (commit) this.sendChannels.flush();
  }

  private dispatchChannels(): void {
    const changes = this.pendingChannels;
    this.pendingChannels = {};
    if (Object.keys(changes).length === 0) return;
    void this.run(
      () => this.commands().setChannels(changes),
      () => {
        this.levels.delete("v");
        this.running.delete("v");
        this.shownLevels = null;
      },
    ).then((accepted) => {
      if (accepted) this.commitLevels(changes);
    });
  }

  /** The light accepted these channels: only now do they become its last known colour. */
  private commitLevels(changes: Record<number, number>): void {
    const base = this.last.levels ?? zeroLevels(this.channelCount);
    if (base.length === 0) return;
    this.last = { ...this.last, levels: base.map((level, index) => changes[index] ?? level) };
    this.learned.levels = true;
    this.hooks.onChange();
  }

  private async run(action: () => Promise<void>, revert: () => void): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      revert();
      this.hooks.onError(describeError(error));
      this.hooks.onChange();
      return false;
    }
  }

  /** Re-render now, and again when the earliest override expires so it can snap back. */
  private changed(): void {
    this.hooks.onChange();
    this.armExpiry();
  }

  private armExpiry(): void {
    if (this.expiryTimer !== null) this.scheduler.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.disposed) return;
    const soonest = [this.power, this.brightness, this.levels, this.running]
      .map((store) => store.prune())
      .reduce<number | null>((a, b) => (a === null ? b : b === null ? a : Math.min(a, b)), null);
    if (soonest === null) return;
    this.expiryTimer = this.scheduler.setTimeout(() => {
      this.expiryTimer = null;
      this.hooks.onChange();
      this.armExpiry();
    }, soonest + 20);
  }
}

/** Everything the card keeps for ONE light: the controller that talks to it, the cache of its
 * schedule programs, and the memory of its last colour. A session belongs to a single light for
 * its whole life. When the card is pointed at another light the old session is disposed and a new
 * one is created, so nothing can leak between lights: not a drag still waiting to be sent, not a
 * remembered colour, not a half-read program.
 *
 * Commands always go through the session's own binding. A session that has been disposed can
 * still be finishing a write (an answer arrives late), but it can never be handed to another light,
 * and it no longer talks to the card.
 */

import type { AdapterBinding } from "../adapters/types.ts";
import { DeviceController, type CommandKind } from "./device-controller.ts";
import { describeError } from "./errors.ts";
import { LastKnownMemory, type MemoryStorage } from "./last-known.ts";
import { ProgramStore } from "./program-store.ts";
import type { Scheduler } from "./throttle.ts";

/** What a session needs from whoever shows it. */
export interface SessionHost {
  /** Something the card shows has changed. */
  changed(): void;
  /** A command to the light failed; `message` is human-readable. */
  error(message: string): void;
  /** The user issued a command (a running Demo ends on colour, effect and schedule commands). */
  command(kind: CommandKind): void;
}

export interface SessionOptions {
  /** Storage key of the light's remembered colour. */
  memoryKey: string;
  storage: MemoryStorage | null;
  scheduler?: Scheduler;
}

export class DeviceSession {
  readonly controller: DeviceController;
  readonly store: ProgramStore;
  readonly memory: LastKnownMemory;
  private binding: AdapterBinding;
  private live = true;

  constructor(
    /** Which light this is: the same light keeps its session, another light gets a new one. */
    readonly identity: string,
    binding: AdapterBinding,
    host: SessionHost,
    options: SessionOptions,
  ) {
    this.binding = binding;
    this.controller = new DeviceController(
      () => this.binding.commands,
      {
        onChange: () => host.changed(),
        onError: (message) => {
          if (this.live) host.error(message);
        },
        onCommand: (kind) => {
          if (this.live) host.command(kind);
        },
      },
      options.scheduler,
    );
    this.store = new ProgramStore(
      (id, read) => {
        const schedule = this.live ? this.binding.read()?.schedule : null;
        return schedule ? schedule.load(id, read) : Promise.reject(new Error("This light has no schedules."));
      },
      () => host.changed(),
      describeError,
    );
    this.memory = new LastKnownMemory(options.memoryKey, options.storage);
  }

  get isLive(): boolean {
    return this.live;
  }

  /** The same light, bound again against a newer registry: later commands use the fresh binding. */
  rebind(binding: AdapterBinding): void {
    if (this.live) this.binding = binding;
  }

  /** Finish with this light: send a drag still waiting for its turn (to THIS light, through its own
   * binding) and stop. Safe to call more than once. */
  dispose(): void {
    if (!this.live) return;
    this.controller.dispose();
    this.live = false;
    this.store.reset();
  }
}

/** The calls behind Fluval lighting programs: read the automation that owns them, change ONE
 * program in it, switch the running program, and ask for it to be written to the light again.
 * The rules for the data itself live in `fluval-programs.ts`; this class only talks to Home
 * Assistant, and only through the `HassRef` it is given.
 *
 * Reading the programs needs an administrator (`automation/config` is an admin command), and so
 * does saving. Switching and re-applying are ordinary service calls. */

import { describeError, errorCode } from "../lib/errors.ts";
import type { ProgramConfig } from "../types.ts";
import { isJsonObject, sameJson, type JsonObject } from "../lib/json.ts";
import { patchProgram, readAutomationPrograms, type AutomationPrograms, type ProgramDraft } from "./fluval-programs.ts";
import type { HassRef } from "./types.ts";

export type PlanStatus = "idle" | "loading" | "ready" | "error" | "denied";

export interface SaveResult {
  /** Home Assistant reloaded the automation and it now holds exactly what was sent. */
  confirmed: boolean;
}

/** What the plan needs from its surroundings besides Home Assistant: a clock and a pause. */
export interface PlanEnvironment {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_ENVIRONMENT: PlanEnvironment = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Saving reloads the automation a moment later; the new values are looked for at these gaps. */
const RELOAD_WAITS_MS = [300, 500, 800, 1200, 2000, 3000] as const;

/** How long read programs are trusted before a card that keeps showing them reads them again. */
export const PROGRAMS_REFRESH_MS = 10 * 60_000;
/** How long a failed read waits before it is tried again. */
export const PROGRAMS_RETRY_MS = 60_000;

/** Whether a card that only displays the programs (the equipment card) should read them now: at the
 * start, when they have gone stale, and again after a failure - but never after Home Assistant
 * has said the person may not read them. */
export function reloadDue(plan: { status: PlanStatus; settledAt: number | null }, now: number): boolean {
  switch (plan.status) {
    case "idle":
      return true;
    case "ready":
      return plan.settledAt !== null && now - plan.settledAt > PROGRAMS_REFRESH_MS;
    case "error":
      return plan.settledAt === null || now - plan.settledAt > PROGRAMS_RETRY_MS;
    case "loading":
    case "denied":
      return false;
  }
}

interface Fetched {
  raw: JsonObject;
  data: AutomationPrograms;
}

/** Every program in a configuration, for comparing two versions of it. */
function programsOf(config: JsonObject): JsonObject | null {
  const variables = config.variables;
  const programs = isJsonObject(variables) ? variables.programs : undefined;
  return isJsonObject(programs) ? programs : null;
}

export class ProgramPlan {
  status: PlanStatus = "idle";
  error: string | null = null;
  /** The programs as last read. Kept through a failed reload (then `status` is "error"). */
  data: AutomationPrograms | null = null;
  /** When the programs were last read successfully. */
  loadedAt: number | null = null;
  /** When the last attempt ended, whether it worked or not. */
  settledAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly ref: HassRef,
    readonly config: ProgramConfig,
    private readonly onChange: () => void,
    private readonly env: PlanEnvironment = REAL_ENVIRONMENT,
  ) {}

  private async fetchConfig(): Promise<Fetched> {
    const answer = await this.ref.current.callWS<unknown>({ type: "automation/config", entity_id: this.config.automation });
    const raw = isJsonObject(answer) ? answer.config : undefined;
    const data = readAutomationPrograms(raw);
    return { raw: raw as JsonObject, data };
  }

  /** Read the automation's programs. Shared while a read is running; `force` reads again even
   * when they are already loaded. */
  load(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.status === "ready" && !force) return Promise.resolve();
    const generation = this.generation;
    this.status = "loading";
    this.error = null;
    this.onChange();
    const task = this.fetchConfig().then(
      ({ data }) => {
        if (generation !== this.generation) return;
        this.data = data;
        this.status = "ready";
        this.loadedAt = this.settledAt = this.env.now();
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.status = errorCode(error) === "unauthorized" ? "denied" : "error";
        this.error = describeError(error, "Home Assistant did not return the automation.");
        this.settledAt = this.env.now();
      },
    );
    const tracked = task.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
      if (generation === this.generation) this.onChange();
    });
    this.inflight = tracked;
    return tracked;
  }

  /** The card is done with this plan (another light, or the card went away): an answer still on
   * its way lands nowhere. */
  dispose(): void {
    this.generation += 1;
    this.inflight = null;
  }

  /** Make `name` the running program. The automation reacts: it stamps the start time, writes the
   * schedule to the light and moves the CO2 window. */
  async select(name: string): Promise<void> {
    await this.ref.current.callService("input_select", "select_option", { option: name }, { entity_id: this.config.select }, false);
  }

  /** Have the automation write the running program to the light again. */
  async reapply(): Promise<void> {
    const button = this.config.reapply;
    if (!button) throw new Error("This card has no re-apply button set up.");
    await this.ref.current.callService("input_button", "press", {}, { entity_id: button }, false);
  }

  /** Change one program in the automation to the draft and confirm Home Assistant holds it.
   *
   * `baseline` is the program as the editor opened it. The configuration is read again right
   * before the write, so anything else edited meanwhile is kept, and a change to THIS program in
   * the meantime stops the save instead of being overwritten. After the write, Home Assistant
   * reloads the automation asynchronously; the new values are waited for, so a re-apply pressed
   * afterwards is seen by the reloaded automation. */
  async save(name: string, baseline: JsonObject, draft: ProgramDraft): Promise<SaveResult> {
    const hass = this.ref.current;
    if (!hass.callApi) throw new Error("This Home Assistant can't save automations from a card.");
    const fresh = await this.fetchConfig();
    const entry = fresh.data.entries.get(name);
    if (!entry || !entry.ok) throw new Error(`The automation no longer has a readable program called ${name}.`);
    if (!sameJson(entry.raw, baseline)) throw new Error(`${name} was changed somewhere else since you opened it. Close this and open it again to see the new values.`);

    const next = patchProgram(fresh.raw, name, draft);
    await hass.callApi("POST", `config/automation/config/${encodeURIComponent(fresh.data.id)}`, next);

    const expected = programsOf(next);
    for (const wait of RELOAD_WAITS_MS) {
      await this.env.sleep(wait);
      try {
        const read = await this.fetchConfig();
        if (sameJson(programsOf(read.raw), expected)) {
          this.data = read.data;
          this.status = "ready";
          this.error = null;
          this.loadedAt = this.settledAt = this.env.now();
          this.onChange();
          return { confirmed: true };
        }
      } catch {
        // The automation is being reloaded and briefly has no configuration to read: look again.
      }
    }
    // Written, but not seen back yet: read it again the next time the programs are needed.
    this.status = "idle";
    this.onChange();
    return { confirmed: false };
  }
}

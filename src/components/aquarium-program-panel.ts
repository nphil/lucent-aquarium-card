import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { ProgramPlan } from "../adapters/fluval-program-plan.ts";
import { co2Label, describeEnds, describeRunning, programPoints, readProgramState, type LightingEntry, type ProgramDraft, type ProgramState } from "../adapters/fluval-programs.ts";
import type { HassRef } from "../adapters/types.ts";
import type { ChannelDef } from "../lib/channels.ts";
import { minutesOfDay } from "../lib/clock.ts";
import { describeError } from "../lib/errors.ts";
import type { JsonObject } from "../lib/json.ts";
import { icon } from "../lib/icons.ts";
import { nextRovingIndex } from "../lib/roving.ts";
import { SEGMENT_CSS } from "../styles/schedule.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { HomeAssistant, ProgramConfig } from "../types.ts";
import type { ProgramEditorClosedDetail } from "./aquarium-program-editor.ts";
import type { ToastRequest } from "./aq-toast.ts";
import "./aq-chip.ts";
import "./aq-icon-button.ts";
import "./aq-notice.ts";
import "./aq-pill-button.ts";
import "./aq-skeleton.ts";
import "./aquarium-confirm-action.ts";
import "./aquarium-program-editor.ts";
import "./aquarium-schedule-chart.ts";

/** "Running 5 days" and "Ends in 62 h" only move by the hour, so a minute is finer than needed. */
const CLOCK_MS = 60_000;

const DAYS_WORD = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;

/** Programs that are stale after this long are read again when the tab is opened. */
const STALE_MS = 60_000;

type Busy = "switch" | "reapply" | null;

const READ_ONLY_NOTE = "Only a Home Assistant administrator can change a program.";

/** The Program tab of a Fluval light: pick a lighting program to look at, switch to it (with a
 * hold), see what it does (light curve, CO2 window, how long it has run), write it to the light
 * again, and - for administrators - edit it. Everything about a program comes from the aquarium
 * automation's configuration (see `adapters/fluval-programs.ts`); the running program comes from
 * the helper named in `config`.
 *
 * `active` says the tab is visible: only then are the programs read and the clock kept. Events
 * (bubble, composed): `aquarium-toast` (`ToastRequest`). */
export class AquariumProgramPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    hassRef: { attribute: false },
    config: { attribute: false },
    channels: { attribute: false },
    timeZone: { attribute: false },
    active: { type: Boolean },
    _viewed: { state: true },
    _now: { state: true },
    _busy: { state: true },
    _editing: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  /** Where the calls go: always the newest `hass`. */
  declare hassRef: HassRef | undefined;
  declare config: ProgramConfig | undefined;
  /** The light's channels, named as it reports them ([] until it has). */
  declare channels: readonly ChannelDef[];
  declare timeZone: string | undefined;
  declare active: boolean;
  /** The program the person picked to look at; until then the running one. */
  declare _viewed: string | null;
  /** Changes once a minute so the panel redraws "running 5 days"; the time itself is read fresh. */
  declare _now: number;
  declare _busy: Busy;
  /** The program being edited, or null. */
  declare _editing: string | null;

  private _plan: ProgramPlan | null = null;
  private _planKey = "";
  private _clock: number | undefined;

  constructor() {
    super();
    this.hass = undefined;
    this.hassRef = undefined;
    this.config = undefined;
    this.channels = [];
    this.timeZone = undefined;
    this.active = false;
    this._viewed = null;
    this._now = Date.now();
    this._busy = null;
    this._editing = null;
  }

  /** Only an administrator may change a program. Reading them is tried for everyone: if Home
   * Assistant refuses (`automation/config` may be an admin command) the panel says so. An unknown
   * user is given the benefit of the doubt; Home Assistant refuses the save if not. */
  private get _isAdmin(): boolean {
    return this.hass?.user?.is_admin !== false;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopClock();
    this._plan?.dispose();
    this._plan = null;
    this._planKey = "";
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    const config = this.config;
    const key = config && this.hassRef ? `${config.select}|${config.automation}|${config.reapply ?? ""}` : "";
    if (key !== this._planKey || (key !== "" && !this._plan)) {
      this._plan?.dispose();
      this._plan = config && this.hassRef ? new ProgramPlan(this.hassRef, config, () => this.requestUpdate()) : null;
      this._planKey = key;
      this._viewed = null;
      this._editing = null;
    }
    if (changed.has("active") && this.active) {
      this._now = Date.now();
      const plan = this._plan;
      if (plan?.status === "ready" && plan.loadedAt !== null && Date.now() - plan.loadedAt > STALE_MS) void plan.load(true);
    }
  }

  protected updated(): void {
    this._syncClock();
    const plan = this._plan;
    if (this.active && plan && plan.status === "idle") void plan.load();
  }

  private _tick = (): void => {
    if (document.visibilityState === "visible") this._now = Date.now();
  };

  private _syncClock(): void {
    if (this.active && this._clock === undefined) {
      this._clock = window.setInterval(this._tick, CLOCK_MS);
      document.addEventListener("visibilitychange", this._tick);
    } else if (!this.active) {
      this._stopClock();
    }
  }

  private _stopClock(): void {
    if (this._clock === undefined) return;
    window.clearInterval(this._clock);
    document.removeEventListener("visibilitychange", this._tick);
    this._clock = undefined;
  }

  // ---- intents ----

  private _toast(request: ToastRequest): void {
    this.dispatchEvent(new CustomEvent<ToastRequest>("aquarium-toast", { detail: request, bubbles: true, composed: true }));
  }

  private _viewedName(state: ProgramState): string | null {
    const names = state.options;
    if (this._viewed !== null && names.includes(this._viewed)) return this._viewed;
    if (state.active !== null && names.includes(state.active)) return state.active;
    return names[0] ?? null;
  }

  private _pick(name: string): void {
    this._viewed = name;
  }

  private _onPickerKey(event: KeyboardEvent, names: readonly string[], current: number): void {
    const next = nextRovingIndex(event.key, current, names.length);
    const name = next === null ? undefined : names[next];
    if (name === undefined) return;
    event.preventDefault();
    this._pick(name);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`.opt[data-name="${CSS.escape(name)}"]`)?.focus());
  }

  private async _switchTo(name: string): Promise<void> {
    const plan = this._plan;
    if (!plan || this._busy) return;
    this._busy = "switch";
    try {
      await plan.select(name);
      this._viewed = null;
      this._toast({ message: `Switching to ${name}. Home Assistant is updating the light and CO2.` });
    } catch (error) {
      this._toast({ message: describeError(error, `Couldn't switch to ${name}.`), kind: "error" });
    } finally {
      this._busy = null;
    }
  }

  private async _reapply(name: string): Promise<void> {
    const plan = this._plan;
    if (!plan || this._busy) return;
    this._busy = "reapply";
    try {
      await plan.reapply();
      this._toast({ message: `Re-apply sent. Home Assistant is writing ${name} to the light again.` });
    } catch (error) {
      this._toast({ message: describeError(error, "Re-apply did not work."), kind: "error" });
    } finally {
      this._busy = null;
    }
  }

  /** Save from the editor: write the program, and when it is the running one and a re-apply button
   * exists, press it so the light gets the new schedule. */
  private _save = async (draft: ProgramDraft, baseline: JsonObject): Promise<ToastRequest> => {
    const plan = this._plan;
    const name = this._editing;
    if (!plan || !name) throw new Error("The program is no longer open.");
    const result = await plan.save(name, baseline, draft);
    if (!result.confirmed) return { message: `${name} was saved, but Home Assistant has not shown the new values yet. Open it again in a moment to check.`, kind: "error", timeoutMs: 10_000 };
    const state = this.config && this.hass ? readProgramState(this.hass.states, this.config, this.timeZone) : null;
    if (state?.active !== name) return { message: `${name} saved.` };
    if (state.reapply !== "ready") return { message: `${name} saved. It is running: press Re-apply to send it to the light.` };
    try {
      await plan.reapply();
      return { message: `${name} saved and sent to the light.` };
    } catch (error) {
      return { message: `${name} saved, but sending it to the light failed: ${describeError(error, "Re-apply did not work.")} Press Re-apply to try again.`, kind: "error", timeoutMs: 10_000 };
    }
  };

  private _onEditorClosed = (event: CustomEvent<ProgramEditorClosedDetail>): void => {
    event.stopPropagation();
    this._editing = null;
  };

  // ---- render ----

  private _renderPicker(state: ProgramState, viewed: string | null): TemplateResult {
    const names = state.options;
    const current = names.findIndex((name) => name === viewed);
    return html`<div class="picker" role="radiogroup" aria-label="Program to look at" @keydown=${(event: KeyboardEvent) => this._onPickerKey(event, names, current)}>
      <div class="tray">
        ${names.map((name) => {
          const selected = name === viewed;
          const running = name === state.active;
          return html`<button type="button" role="radio" class="seg opt" aria-checked=${selected ? "true" : "false"} tabindex=${selected ? 0 : -1} data-name=${name} @click=${() => this._pick(name)}>
            <span class="opt-name">${name}</span>
            ${running ? html`<span class="opt-run"><i class="run-dot"></i>Active</span>` : nothing}
          </button>`;
        })}
      </div>
    </div>`;
  }

  private _renderChips(state: ProgramState, entry: LightingEntry | undefined, isActive: boolean): TemplateResult | typeof nothing {
    const chips: TemplateResult[] = [];
    const now = Date.now();
    const running = isActive ? describeRunning(state.startedMs, now) : null;
    if (running) chips.push(html`<aq-chip icon="calendarClock" label=${running}></aq-chip>`);
    if (entry?.ok) {
      const program = entry.program;
      if (isActive) {
        const ends = describeEnds(state.startedMs, program.maxDays, now);
        if (ends) chips.push(html`<aq-chip kind=${ends === "Ends within the hour" || ends === "Ends in under an hour" ? "warning" : "neutral"} icon="clock" label=${ends}></aq-chip>`);
        else if (program.maxDays > 0) chips.push(html`<aq-chip icon="clock" label=${`Ends after ${DAYS_WORD(program.maxDays)}`}></aq-chip>`);
      } else if (program.maxDays > 0) {
        chips.push(html`<aq-chip icon="clock" label=${`Ends after ${DAYS_WORD(program.maxDays)}`}></aq-chip>`);
      }
      chips.push(html`<aq-chip icon="moleculeCo2" label=${co2Label(program)}></aq-chip>`);
      if (program.reviewEveryDays > 0) chips.push(html`<aq-chip icon="info" label=${`Reminder every ${DAYS_WORD(program.reviewEveryDays)}`}></aq-chip>`);
    }
    return chips.length > 0 ? html`<div class="chips">${chips}</div>` : nothing;
  }

  private _renderDetails(plan: ProgramPlan, name: string, entry: LightingEntry | undefined, isActive: boolean): TemplateResult {
    if (plan.status === "denied") {
      return html`<aq-notice kind="info" heading="What a program does is for administrators" message="Home Assistant only shows the light and CO2 plan of each program to an administrator. You can still switch programs here."></aq-notice>`;
    }
    if (!plan.data) {
      if (plan.status === "error") {
        return html`<aq-notice kind="error" heading="Couldn't read the programs" .message=${plan.error ?? ""} action-label="Retry" action-icon="refresh" @notice-action=${() => void plan.load(true)}></aq-notice>`;
      }
      return html`<div class="slot"><aq-skeleton label="Loading the programs" height="var(--lu-space-8)"></aq-skeleton><aq-skeleton label="Loading the day" height="calc(var(--chart-h) + var(--chart-extras))"></aq-skeleton></div>`;
    }
    const stale = plan.status === "error" ? html`<aq-notice kind="error" compact heading="Couldn't refresh the programs" .message=${`${plan.error ?? ""} Showing what was read before.`} action-label="Retry" action-icon="refresh" @notice-action=${() => void plan.load(true)}></aq-notice>` : nothing;
    if (!entry) {
      return html`${stale}<aq-notice kind="info" heading=${`${name} has no settings`} message="The automation has nothing for this program, so there is nothing to show or change. It can still be switched to."></aq-notice>`;
    }
    if (!entry.ok) {
      return html`${stale}<aq-notice kind="warning" heading=${`${name} can't be shown`} message=${`Its settings can't be read: ${entry.reason}.`}></aq-notice>`;
    }
    const program = entry.program;
    let curve: TemplateResult;
    if (this.channels.length === 0) {
      curve = html`<aq-skeleton label="Waiting for the light's channels" height="calc(var(--chart-h) + var(--chart-extras))"></aq-skeleton>`;
    } else {
      try {
        const points = programPoints(program, this.channels.length);
        curve = html`<aquarium-schedule-chart .points=${points} .channels=${this.channels} .nowMinutes=${isActive ? minutesOfDay(new Date(), this.timeZone) : null} .label=${name}></aquarium-schedule-chart>`;
      } catch (error) {
        curve = html`<aq-notice kind="warning" heading="The day can't be drawn" .message=${describeError(error)}></aq-notice>`;
      }
    }
    return html`${stale}
      ${program.summary ? html`<p class="summary">${program.summary}</p>` : nothing}
      <div class="slot">${curve}</div>
      <p class="note">${icon("info")}<span>${isActive ? "This is the Automatic schedule the light is running." : "This is the Automatic schedule the light gets if you switch to this program."}</span></p>`;
  }

  private _renderActions(plan: ProgramPlan, state: ProgramState, name: string, entry: LightingEntry | undefined, isActive: boolean): TemplateResult {
    const busy = this._busy;
    const canEdit = this._isAdmin && plan.status !== "denied" && entry?.ok === true;
    const readOnly = !this._isAdmin && entry?.ok === true;
    const waitingForChannels = canEdit && this.channels.length === 0;
    const reapplyReason = state.reapply === "none" ? null : state.reapply === "missing" ? `Home Assistant has no ${this.config?.reapply}.` : state.reapply === "unavailable" ? "The re-apply button is unavailable right now." : null;
    const edit = canEdit
      ? html`<aq-pill-button variant="secondary" icon="pencil" label="Edit program" ?disabled=${waitingForChannels || busy !== null} @lu-press=${() => (this._editing = name)}></aq-pill-button>`
      : nothing;
    if (isActive) {
      return html`<div class="actions">
          ${state.reapply !== "none" ? html`<aq-pill-button variant="secondary" icon="refresh" label="Re-apply" ?loading=${busy === "reapply"} ?disabled=${state.reapply !== "ready" || busy === "switch"} @lu-press=${() => void this._reapply(name)}></aq-pill-button>` : nothing}
          ${edit}
        </div>
        ${reapplyReason ? html`<p class="reason">${reapplyReason}</p>` : state.reapply === "ready" ? html`<p class="reason">Re-apply writes ${name} to the light again, for when the light did not take it.</p>` : nothing}
        ${waitingForChannels ? html`<p class="reason">Editing starts once the light has reported its channels.</p>` : nothing}
        ${readOnly ? html`<p class="reason">${READ_ONLY_NOTE}</p>` : nothing}`;
    }
    return html`<aquarium-confirm-action label=${`Hold to switch to ${name}`} complete-label="Switching" confirm-label="Switch now" icon="playCircle" .consequence=${`Light and CO2 switch to ${name}.`} ?busy=${busy === "switch"} ?disabled=${state.unavailable || busy === "reapply"} @confirmed=${() => void this._switchTo(name)}></aquarium-confirm-action>
      ${state.unavailable ? html`<p class="reason">The program helper is unavailable right now.</p>` : nothing}
      ${canEdit ? html`<div class="actions">${edit}</div>` : nothing}
      ${waitingForChannels ? html`<p class="reason">Editing starts once the light has reported its channels.</p>` : nothing}
      ${readOnly ? html`<p class="reason">${READ_ONLY_NOTE}</p>` : nothing}`;
  }

  render() {
    const config = this.config;
    const hass = this.hass;
    const plan = this._plan;
    if (!config || !hass || !plan) return nothing;
    const state = readProgramState(hass.states, config, this.timeZone);
    if (state.missing) {
      return html`<aq-notice kind="error" heading="Program helper not found" .message=${`Home Assistant has no ${config.select}. Check the program settings of this card.`}></aq-notice>`;
    }
    if (state.options.length === 0) {
      return html`<aq-notice kind="warning" heading="No programs to choose from" .message=${`${config.select} has no options${state.unavailable ? " while it is unavailable" : ""}.`}></aq-notice>`;
    }
    const viewed = this._viewedName(state);
    const entry = viewed !== null ? plan.data?.entries.get(viewed) : undefined;
    const isActive = viewed !== null && viewed === state.active;
    const editing = this._editing;
    const editingEntry = editing !== null ? plan.data?.entries.get(editing) : undefined;

    return html`<div class="panel">
      ${this._renderPicker(state, viewed)}
      ${viewed !== null
        ? html`<section class="view" aria-labelledby="view-title">
            <header class="view-head">
              <h3 class="view-title" id="view-title">${viewed}</h3>
              ${isActive ? html`<aq-chip kind="positive" dot label="Active"></aq-chip>` : nothing}
              ${plan.status !== "denied" ? html`<aq-icon-button class="refresh" icon="refresh" label="Read the programs again" ?disabled=${plan.status === "loading"} @lu-press=${() => void plan.load(true)}></aq-icon-button>` : nothing}
            </header>
            ${this._renderChips(state, entry, isActive)}
            ${this._renderDetails(plan, viewed, entry, isActive)}
            ${this._renderActions(plan, state, viewed, entry, isActive)}
          </section>`
        : nothing}
      ${this._isAdmin
        ? html`<aquarium-program-editor .open=${editing !== null && editingEntry?.ok === true} .name=${editing ?? ""} .program=${editingEntry?.ok ? editingEntry.program : null} .raw=${editingEntry?.ok ? editingEntry.raw : null} .channels=${this.channels} .co2FixedStop=${plan.data?.co2FixedStop ?? null} .running=${editing !== null && editing === state.active} ?will-reapply=${state.reapply === "ready"} .save=${this._save}
            @program-editor-closed=${this._onEditorClosed}></aquarium-program-editor>`
        : nothing}
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    SEGMENT_CSS,
    css`
      :host { display: block; min-width: 0; }
      .panel { container-type: inline-size; display: grid; gap: var(--lu-space-5); min-width: 0; }

      .picker .tray { grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); }
      .opt { gap: 1px; }
      .opt-name { min-width: 0; }
      .opt-run { display: inline-flex; align-items: center; gap: 5px; color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1.2 var(--lu-font); }
      .run-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--lu-positive); }

      .view { display: grid; gap: var(--lu-space-3); min-width: 0; }
      .view-head { display: flex; align-items: center; gap: var(--lu-space-3); min-height: var(--lu-target); }
      .view-title { flex: 0 1 auto; min-width: 0; margin: 0; font: 600 var(--lu-type-body)/1.3 var(--lu-font); color: var(--lu-ink); overflow-wrap: anywhere; }
      .refresh { margin-left: auto; }
      .chips { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
      .summary { margin: 0; color: var(--lu-ink); font: 400 var(--lu-type-body)/1.5 var(--lu-font); overflow-wrap: anywhere; }

      /* The chart is about half as tall as wide (180-300 px) plus its ribbon and legend: the skeleton
         keeps that footprint so nothing jumps when the data arrives. */
      .slot { --chart-h: clamp(180px, 50cqw, 300px); --chart-extras: 66px; container-type: inline-size; display: grid; gap: var(--lu-space-3); min-width: 0; }
      .note { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.45 var(--lu-font); }
      .note .icon { flex: none; margin-top: 1px; font-size: 18px; }
      .reason { margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .actions { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
      .actions aq-pill-button { flex: 1 1 160px; }
    `,
  ];
}

customElements.define("aquarium-program-panel", AquariumProgramPanel);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-program-panel": AquariumProgramPanel;
  }
}

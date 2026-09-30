import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { ActionDef, DeviceModel, ProgramData, ScheduleModel, ScheduleProgram } from "../adapters/types.ts";
import { minutesOfDay } from "../lib/clock.ts";
import { pointCountLabel } from "../lib/chart-model.ts";
import { describeError } from "../lib/errors.ts";
import { icon } from "../lib/icons.ts";
import type { SchedulePoint } from "../lib/points.ts";
import type { ProgramStore } from "../lib/program-store.ts";
import { nextRovingIndex } from "../lib/roving.ts";
import { describeView, groupPrograms, initialProgram, planActions, suggestSlot, type ActionPlan, type ProgramGroup, type ProgramView, type SecondaryKind, type ViewNotice } from "../lib/schedule-view.ts";
import { SEGMENT_CSS } from "../styles/schedule.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { EditorClosedDetail } from "./aquarium-diy-editor.ts";
import type { ToastRequest } from "./lu-toast.ts";
import "./lu-chip.ts";
import "./lu-icon-button.ts";
import "./lu-notice.ts";
import "./lu-pill-button.ts";
import "./lu-skeleton.ts";
import "./aquarium-diy-editor.ts";
import "./aquarium-schedule-chart.ts";

/** The chart's "now" marker moves with the clock; half a minute is finer than anyone can read. */
const CLOCK_MS = 30_000;
interface EditorRequest {
  open: boolean;
  program: string;
  points: SchedulePoint[];
  template: boolean;
  sourceName: string;
}

/** The pieces of a `DeviceModel` the Schedule tab reads. */
export type ScheduleDevice = Pick<DeviceModel, "phase" | "schedule" | "running" | "actions">;

/** The Schedule tab body: a program picker, the viewed program's 24 h chart with its values, and
 * what can be done with it. It is written once for every light: programs, channels, limits and
 * IO come from `device.schedule` (see `adapters/types.ts`); what a light cannot do (edit,
 * preview) is simply absent from that model and the panel says so.
 *
 * `active` says the tab is visible: only then does the panel read programs and run the clock
 * behind the "now" marker. Events (bubble, composed): `activate-program` (`{program}`, the card
 * performs it) and `aquarium-toast` (`ToastRequest`). The panel never changes the light itself. */
export class AquariumSchedulePanel extends LitElement {
  static properties = {
    device: { attribute: false },
    store: { attribute: false },
    timeZone: { attribute: false },
    active: { type: Boolean },
    activating: { type: Boolean },
    _viewed: { state: true },
    _now: { state: true },
    _showValues: { state: true },
    _editor: { state: true },
    _busy: { state: true },
  };

  declare device: ScheduleDevice | null;
  declare store: ProgramStore | null;
  declare timeZone: string | undefined;
  /** The tab is visible. */
  declare active: boolean;
  /** An activation request is in flight. */
  declare activating: boolean;
  /** The program the user picked; until they pick one the panel follows the running program. */
  declare _viewed: string | null;
  declare _now: number | null;
  declare _showValues: boolean;
  declare _editor: EditorRequest;
  /** Ids of device actions in flight. */
  declare _busy: string[];

  private _lastPhase: DeviceModel["phase"] | null = null;
  private _recheck = false;
  private _clock: number | undefined;
  private _watching: Promise<void> | null = null;

  constructor() {
    super();
    this.device = null;
    this.store = null;
    this.timeZone = undefined;
    this.active = false;
    this.activating = false;
    this._viewed = null;
    this._now = null;
    this._showValues = false;
    this._editor = { open: false, program: "", points: [], template: false, sourceName: "" };
    this._busy = [];
  }

  /** Show `id` (as if picked). For hosts that want to open on a particular program. */
  viewProgram(id: string): void {
    this._viewed = id;
  }

  private get _schedule(): ScheduleModel | null {
    return this.device?.schedule ?? null;
  }

  private get _runningId(): string | null {
    const running = this.device?.running;
    return running?.kind === "schedule" ? (running.scheduleId ?? this._schedule?.runningId ?? null) : null;
  }

  private get _viewedId(): string | null {
    const programs = this._schedule?.programs ?? [];
    if (this._viewed !== null && programs.some((program) => program.id === this._viewed)) return this._viewed;
    return initialProgram(programs, this._runningId);
  }

  // ---- lifecycle ----

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopClock();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("device")) {
      const phase = this.device?.phase ?? null;
      if (this._lastPhase === "unavailable" && phase !== null && phase !== "unavailable") this._recheck = true;
      this._lastPhase = phase;
    }
    if (changed.has("active") && this.active) this._tick();
  }

  protected updated(): void {
    this._syncClock();
    if (this.active) this._ensureLoaded();
  }

  private _tick = (): void => {
    if (document.visibilityState === "visible") this._now = minutesOfDay(new Date(), this.timeZone);
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

  /** Read the viewed program when it has not been read; after the link comes back, read again
   * whatever failed while it was down. A read that is already under way is only watched, because
   * the store reports to its owner, not to this panel. */
  private _ensureLoaded(): void {
    const schedule = this._schedule;
    const store = this.store;
    const id = this._viewedId;
    if (!schedule || !store || id === null) return;
    if (this._recheck) {
      this._recheck = false;
      for (const program of schedule.programs) if (store.entry(program.id).status === "error") this._watch(store.load(program.id, { force: true }));
    }
    const program = schedule.programs.find((candidate) => candidate.id === id);
    if (!program || (program.editable && this.device?.phase === "unavailable")) return;
    const status = store.entry(id).status;
    if (status === "idle" || status === "loading") this._watch(store.load(id));
  }

  private _watch(request: Promise<void>): void {
    if (this._watching === request) return;
    this._watching = request;
    void request.finally(() => {
      if (this._watching === request) this._watching = null;
      this.requestUpdate();
    });
  }

  /** The user asked to read the light again ("Reload from the light", or Retry): ask the light
   * itself, not just whatever was cached. */
  private _reload(id: string): void {
    if (!this.store) return;
    this._watch(this.store.load(id, { force: true, refresh: true }));
    this.requestUpdate();
  }

  // ---- intents ----

  private _pick(id: string): void {
    this._viewed = id;
  }

  private _onPickerKey(event: KeyboardEvent, programs: readonly ScheduleProgram[], current: number): void {
    const next = nextRovingIndex(event.key, current, programs.length);
    const program = next === null ? undefined : programs[next];
    if (!program) return;
    event.preventDefault();
    this._pick(program.id);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`.opt[data-id="${CSS.escape(program.id)}"]`)?.focus());
  }

  private _activate(id: string): void {
    this.dispatchEvent(new CustomEvent("activate-program", { detail: { program: id }, bubbles: true, composed: true }));
  }

  private _toast(request: ToastRequest): void {
    this.dispatchEvent(new CustomEvent<ToastRequest>("aquarium-toast", { detail: request, bubbles: true, composed: true }));
  }

  private _openEditor(kind: SecondaryKind, program: ScheduleProgram, data: ProgramData | null): void {
    const schedule = this._schedule;
    const store = this.store;
    if (!schedule || !store) return;
    if (kind === "customise" && data) {
      const target = suggestSlot(schedule.programs.filter((candidate) => candidate.editable), (id) => store.entry(id));
      this._editor = { open: true, program: target ?? "", points: data.points, template: true, sourceName: program.name };
    } else if (kind === "create") {
      this._editor = { open: true, program: program.id, points: schedule.newProgramPoints(), template: false, sourceName: "" };
    } else if (data) {
      this._editor = { open: true, program: program.id, points: data.points, template: false, sourceName: "" };
    }
  }

  private _onEditorClosed = (event: CustomEvent<EditorClosedDetail>): void => {
    this._editor = { ...this._editor, open: false };
    if (event.detail.saved) this._viewed = event.detail.program;
  };

  private async _runAction(action: ActionDef): Promise<void> {
    if (this._busy.includes(action.id)) return;
    this._busy = [...this._busy, action.id];
    try {
      await action.run();
      this._toast({ message: `${action.label}: done` });
    } catch (error) {
      this._toast({ message: describeError(error, `${action.label} did not work.`), kind: "error" });
    } finally {
      this._busy = this._busy.filter((id) => id !== action.id);
    }
  }

  // ---- render ----

  private _renderPicker(groups: readonly ProgramGroup[], viewed: string | null, runningId: string | null, phase: DeviceModel["phase"]): TemplateResult {
    const flat = groups.flatMap((group) => group.programs);
    const current = flat.findIndex((program) => program.id === viewed);
    return html`<div class="picker" role="radiogroup" aria-label="Program to view" @keydown=${(event: KeyboardEvent) => this._onPickerKey(event, flat, current)}>
      ${groups.map(
        (group, groupIndex) => html`<div class="group" role="presentation" style=${`--n:${group.programs.length}`}>
          <span class="group-label" id=${`group-${groupIndex}`}>${group.label}</span>
          <div class="tray" style="grid-template-columns:repeat(auto-fit, minmax(84px, 1fr))">
            ${group.programs.map((program) => {
              const selected = program.id === viewed;
              const running = phase === "on" && runningId === program.id;
              return html`<button type="button" role="radio" class="seg opt" aria-checked=${selected ? "true" : "false"} aria-describedby=${`group-${groupIndex}`} tabindex=${selected || (current < 0 && program === flat[0]) ? 0 : -1} data-id=${program.id} @click=${() => this._pick(program.id)}>
                <span class="opt-name">${program.name}</span>
                ${running ? html`<span class="opt-run"><i class="run-dot"></i>Running</span>` : nothing}
              </button>`;
            })}
          </div>
        </div>`,
      )}
    </div>`;
  }

  private _renderSlot(schedule: ScheduleModel, program: ScheduleProgram, view: ProgramView, plan: ActionPlan, groups: readonly ProgramGroup[]): TemplateResult {
    const store = this.store!;
    const entry = store.entry(program.id);
    switch (view.kind) {
      case "loading":
        return html`<lu-skeleton label=${`Loading ${program.name}`} height="var(--chart-h)"></lu-skeleton>
          <lu-skeleton height="calc(var(--chart-extras) - 4px)" style="margin-top:4px"></lu-skeleton>`;
      case "error":
        return html`<lu-notice kind="error" heading=${`Couldn't read ${program.name}`} .message=${view.message} action-label="Retry" action-icon="refresh" ?busy=${entry.status === "loading"} @notice-action=${() => this._reload(program.id)}></lu-notice>`;
      case "link-down": {
        const builtIn = groups.find((group) => group.programs.every((candidate) => !candidate.editable))?.label;
        const rest = builtIn ? ` ${builtIn} still work.` : "";
        return html`<lu-notice kind="warning" heading="The light isn't connected" .message=${`${program.name} is stored on the light, so it can't be read or changed until Bluetooth is back.${rest}`}></lu-notice>`;
      }
      case "empty":
        return html`<div class="empty">
          <span class="empty-icon">${icon("clock")}</span>
          <h4 class="empty-title">${program.name} is empty</h4>
          <p class="empty-text">Nothing is stored in this slot yet, so there is nothing to activate. Create a program to schedule your own light through the day.</p>
          ${plan.secondary
            ? html`<lu-pill-button variant="primary" icon="plus" label="Create program" ?disabled=${plan.secondary.disabledReason !== null} @lu-press=${() => this._openEditor("create", program, null)}></lu-pill-button>
                ${plan.secondary.disabledReason ? html`<p class="reason">${plan.secondary.disabledReason}</p>` : nothing}`
            : nothing}
        </div>`;
      case "chart":
        return html`<aquarium-schedule-chart .points=${view.data.points} .channels=${schedule.channels} .nowMinutes=${this._now} .label=${program.name} ?stale=${view.stale}></aquarium-schedule-chart>
          ${view.notice ? this._renderNotice(program, view.notice, entry.status === "loading") : nothing}
          ${view.data.note ? html`<p class="note">${icon("info")}<span>${view.data.note}</span></p>` : nothing}`;
    }
  }

  private _renderNotice(program: ScheduleProgram, notice: ViewNotice, busy: boolean): TemplateResult {
    if (notice.kind === "link-down") {
      return html`<lu-notice kind="warning" compact heading="The light isn't connected" message="Showing the values last read from the light. They are read again when it is back."></lu-notice>`;
    }
    return html`<lu-notice kind="error" compact heading=${`Couldn't refresh ${program.name}`} .message=${`${notice.message} Showing the values last read.`} action-label="Retry" action-icon="refresh" ?busy=${busy} @notice-action=${() => this._reload(program.id)}></lu-notice>`;
  }

  private _renderValues(schedule: ScheduleModel, program: ScheduleProgram, points: readonly SchedulePoint[]): TemplateResult | typeof nothing {
    if (points.length === 0) return nothing;
    const open = this._showValues;
    return html`<div class="values">
      <button type="button" class="values-toggle" aria-expanded=${open ? "true" : "false"} aria-controls="values-body" @click=${() => (this._showValues = !this._showValues)}>
        ${icon("chevronRight")}<span>${open ? "Hide values" : "Show values"}</span>
      </button>
      <div class="values-body" id="values-body" ?hidden=${!open}>
        <table>
          <caption class="sr-only">Values for ${program.name}: ${pointCountLabel(points.length)}</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              ${schedule.channels.map((channel) => html`<th scope="col"><span class="col-dot" style=${`background:${channel.colour}`}></span><span class="sr-only">${channel.name}</span><span aria-hidden="true">${channel.short}</span></th>`)}
            </tr>
          </thead>
          <tbody>
            ${points.map(
              (point) => html`<tr>
                <th scope="row">${String(Math.floor(point.minutes / 60)).padStart(2, "0")}:${String(point.minutes % 60).padStart(2, "0")}</th>
                ${schedule.channels.map((_, index) => html`<td>${point.levels[index] ?? 0}%</td>`)}
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  private _renderActions(schedule: ScheduleModel, program: ScheduleProgram, view: ProgramView, plan: ActionPlan, groups: readonly ProgramGroup[]): TemplateResult | typeof nothing {
    if (view.kind === "empty") return nothing;
    const data = view.kind === "chart" ? view.data : null;
    const secondary = plan.secondary;
    const reasons = [...new Set([plan.activate?.disabledReason, secondary?.disabledReason].filter((reason): reason is string => Boolean(reason)))];
    const group = groups.find((candidate) => candidate.programs.includes(program));
    const note = !schedule.save ? schedule.readOnlyNote : program.editable ? undefined : `${group?.label ?? "Built-in programs"} are read-only.${secondary ? " Customise saves your own copy." : ""}`;
    if (!plan.activate && !secondary && !note) return nothing;
    return html`<div class="actions">
        ${plan.activate
          ? html`<lu-pill-button variant="primary" icon="playCircle" label="Activate" grow ?loading=${this.activating} ?disabled=${plan.activate.disabledReason !== null} @lu-press=${() => this._activate(program.id)}></lu-pill-button>`
          : nothing}
        ${secondary
          ? html`<lu-pill-button variant="secondary" grow .icon=${secondary.kind === "edit" ? "pencil" : "tune"} .label=${secondary.kind === "edit" ? "Edit" : "Customise"} ?disabled=${secondary.disabledReason !== null} @lu-press=${() => this._openEditor(secondary.kind, program, data)}></lu-pill-button>`
          : nothing}
      </div>
      ${reasons.map((reason) => html`<p class="reason">${reason}</p>`)}
      ${note ? html`<p class="note">${icon("info")}<span>${note}</span></p>` : nothing}`;
  }

  private _renderDeviceActions(actions: readonly ActionDef[]): TemplateResult | typeof nothing {
    if (actions.length === 0) return nothing;
    return html`<div class="device-actions" role="group" aria-label="Light actions">
      <div class="device-buttons">
        ${actions.map(
          (action) => html`<lu-pill-button variant="quiet" .icon=${action.icon} .label=${action.label} ?disabled=${action.unavailable !== undefined} ?loading=${this._busy.includes(action.id)} @lu-press=${() => void this._runAction(action)}></lu-pill-button>`,
        )}
      </div>
      ${actions.filter((action) => action.unavailable).map((action) => html`<p class="reason">${action.label}: ${action.unavailable}</p>`)}
    </div>`;
  }

  render() {
    const device = this.device;
    const schedule = this._schedule;
    if (!device || !schedule || !this.store) {
      return html`<lu-notice kind="info" heading="No schedule" message="This light does not report a schedule."></lu-notice>`;
    }
    const groups = groupPrograms(schedule.programs);
    const viewed = this._viewedId;
    const program = schedule.programs.find((candidate) => candidate.id === viewed);
    const runningId = this._runningId;
    const phase = device.phase;

    let view: TemplateResult | typeof nothing = nothing;
    if (program) {
      const entry = this.store.entry(program.id);
      const state = describeView(program, entry, phase);
      const running = phase === "on" && runningId === program.id;
      const plan = planActions({ program, view: state, phase, running, canSave: schedule.save !== undefined, hasEditableTarget: schedule.programs.some((candidate) => candidate.editable) });
      view = html`<section class="view" aria-labelledby="view-title">
        <header class="view-head">
          <h3 class="view-title" id="view-title">${program.name}</h3>
          ${running ? html`<lu-chip kind="positive" dot label="Running now"></lu-chip>` : nothing}
          <lu-icon-button class="refresh" icon="refresh" label="Reload from the light" ?disabled=${entry.status === "loading"} @lu-press=${() => this._reload(program.id)}></lu-icon-button>
        </header>
        <div class="slot">${this._renderSlot(schedule, program, state, plan, groups)}</div>
        ${state.kind === "chart" ? this._renderValues(schedule, program, state.data.points) : nothing}
        ${this._renderActions(schedule, program, state, plan, groups)}
      </section>`;
    }

    return html`<div class="panel">
      ${this._renderPicker(groups, viewed, runningId, phase)}
      ${view}
      ${this._renderDeviceActions(device.actions)}
      ${schedule.save
        ? html`<aquarium-diy-editor .open=${this._editor.open} .schedule=${schedule} .phase=${phase} .store=${this.store} .program=${this._editor.program} .initialPoints=${this._editor.points} .template=${this._editor.template} .sourceName=${this._editor.sourceName} .nowMinutes=${this._now}
            @editor-closed=${this._onEditorClosed} @store-changed=${() => this.requestUpdate()}></aquarium-diy-editor>`
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

      .picker { display: flex; flex-wrap: wrap; gap: var(--lu-space-3) var(--lu-space-4); }
      .group { display: grid; gap: var(--lu-space-2); flex: var(--n) 1 calc(var(--n) * 108px); min-width: 0; }
      .group-label { color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1.2 var(--lu-font); padding-left: var(--lu-space-1); }
      .opt { gap: 1px; }
      .opt-name { min-width: 0; }
      .opt-run { display: inline-flex; align-items: center; gap: 5px; color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1.2 var(--lu-font); }
      .run-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--lu-positive); }

      .view { display: grid; gap: var(--lu-space-3); min-width: 0; }
      .view-head { display: flex; align-items: center; gap: var(--lu-space-3); min-height: var(--lu-target); }
      .view-title { flex: 0 1 auto; min-width: 0; margin: 0; font: 600 var(--lu-type-body)/1.3 var(--lu-font); color: var(--lu-ink); overflow-wrap: anywhere; }
      .refresh { margin-left: auto; }

      /* The chart is about half as tall as wide (180-300 px) plus its ribbon and legend: the skeleton
         and the empty state keep that footprint so nothing jumps when the data arrives. */
      .slot { --chart-h: clamp(180px, 50cqw, 300px); --chart-extras: 66px; container-type: inline-size; display: grid; gap: var(--lu-space-3); min-width: 0; }
      .empty { display: grid; justify-items: center; align-content: center; gap: var(--lu-space-2); min-height: calc(var(--chart-h) + var(--chart-extras)); padding: var(--lu-space-6) var(--lu-space-4); border: 1px dashed var(--lu-edge-raised); border-radius: var(--lu-radius-tile); text-align: center; }
      .empty-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--lu-tile); color: var(--lu-ink-2); font-size: 24px; }
      .empty-title { margin: var(--lu-space-1) 0 0; color: var(--lu-ink); font: 600 var(--lu-type-body)/1.3 var(--lu-font); }
      .empty-text { max-width: 36ch; margin: 0 0 var(--lu-space-2); color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.45 var(--lu-font); }

      .note { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.45 var(--lu-font); }
      .note .icon { flex: none; margin-top: 1px; font-size: 18px; }
      .reason { margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .empty .reason { margin-top: calc(var(--lu-space-1) * -1); }

      .values { display: grid; min-width: 0; }
      .values-toggle { display: inline-flex; align-items: center; gap: var(--lu-space-1); justify-self: start; min-height: var(--lu-target); margin-left: calc(var(--lu-space-2) * -1); padding: 0 var(--lu-space-3) 0 var(--lu-space-2); border: 0; border-radius: var(--lu-radius-pill); background: transparent; color: var(--lu-ink-2); font: 600 var(--lu-type-label)/1.2 var(--lu-font); cursor: pointer; }
      .values-toggle:hover { color: var(--lu-ink); background-color: var(--lu-hover-wash); }
      .values-toggle .icon { font-size: 20px; }
      @media (prefers-reduced-motion: no-preference) { .values-toggle .icon { transition: transform var(--lu-motion-focus) var(--lu-ease); } }
      .values-toggle[aria-expanded="true"] .icon { transform: rotate(90deg); }
      .values-body[hidden] { display: none; }
      table { width: 100%; border-collapse: collapse; font: 400 var(--lu-type-label)/1.2 var(--lu-font); font-variant-numeric: tabular-nums; color: var(--lu-ink); }
      th, td { padding: var(--lu-space-2) var(--lu-space-1); text-align: right; white-space: nowrap; }
      th:first-child, td:first-child { text-align: left; }
      thead th { color: var(--lu-ink-2); font-size: var(--lu-type-caption); font-weight: 500; }
      tbody th { font-weight: 600; }
      tbody tr { border-top: 1px solid var(--lu-edge); }
      .col-dot { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 50%; box-shadow: 0 0 0 1px color-mix(in srgb, var(--lu-ink) 30%, transparent); }

      .actions { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
      .actions lu-pill-button { flex: 1 1 140px; }
      .device-actions { display: grid; gap: var(--lu-space-2); padding-top: var(--lu-space-4); border-top: 1px solid var(--lu-edge); }
      .device-buttons { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
    `,
  ];
}

customElements.define("aquarium-schedule-panel", AquariumSchedulePanel);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-schedule-panel": AquariumSchedulePanel;
  }
}

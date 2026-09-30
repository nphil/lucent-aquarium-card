import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { draftCautions, draftFromProgram, draftPoints, draftsEqual, validateDraft, type DraftField, type DraftIssue, type LightingProgram, type ProgramDraft } from "../adapters/fluval-programs.ts";
import type { JsonObject } from "../lib/json.ts";
import { RAMP_MAX } from "../adapters/fluval-data.ts";
import type { ChannelDef } from "../lib/channels.ts";
import { describeError } from "../lib/errors.ts";
import { icon } from "../lib/icons.ts";
import { SEGMENT_CSS, STRIP_CSS } from "../styles/schedule.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { FieldChangeDetail } from "./aquarium-stepper-field.ts";
import type { AquariumSheet } from "./aquarium-sheet.ts";
import type { SliderDetail } from "./aquarium-slider.ts";
import type { ToastRequest } from "./aq-toast.ts";
import "./aq-chip.ts";
import "./aq-notice.ts";
import "./aq-pill-button.ts";
import "./aq-switch.ts";
import "./aquarium-confirm-action.ts";
import "./aquarium-schedule-chart.ts";
import "./aquarium-sheet.ts";
import "./aquarium-slider.ts";
import "./aquarium-stepper-field.ts";

/** Saves the draft and reports what to tell the person. Rejects (with a readable message) when
 * the program could not be saved, which keeps the sheet open. `baseline` is the program as this
 * sheet opened it. */
export type ProgramSaver = (draft: ProgramDraft, baseline: JsonObject) => Promise<ToastRequest>;

export interface ProgramEditorClosedDetail {
  saved: boolean;
}

const DAYS_WORD = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;

/** The editor for one lighting program, in a bottom sheet / dialog: light times, ramps and day and
 * night levels per channel (with a live 24 h preview that stays in view), the CO2 window, and the
 * plan around it (reminders, time limit, summary). It edits a DRAFT and changes nothing until the
 * person confirms with a hold; saving goes through the `save` function it is given.
 *
 * Events: `program-editor-closed` (`{saved}`), `aquarium-toast` (`ToastRequest`). */
export class AquariumProgramEditor extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    name: { type: String },
    program: { attribute: false },
    raw: { attribute: false },
    channels: { attribute: false },
    co2FixedStop: { attribute: false },
    running: { type: Boolean },
    willReapply: { type: Boolean, attribute: "will-reapply" },
    save: { attribute: false },
    _draft: { state: true },
    _saving: { state: true },
    _saveError: { state: true },
    _discarding: { state: true },
  };

  declare open: boolean;
  declare name: string;
  declare program: LightingProgram | null;
  /** The program exactly as the automation stores it: the baseline a save is checked against. */
  declare raw: JsonObject | null;
  declare channels: readonly ChannelDef[];
  /** A clock time (minutes) the automation stops CO2 at whatever a program says, or null. */
  declare co2FixedStop: number | null;
  /** This is the running program. */
  declare running: boolean;
  /** Saving the running program also presses Re-apply for the person. */
  declare willReapply: boolean;
  declare save: ProgramSaver | null;
  declare _draft: ProgramDraft | null;
  declare _saving: boolean;
  declare _saveError: string | null;
  declare _discarding: boolean;

  private _base: ProgramDraft | null = null;
  private _opened: JsonObject | null = null;
  private _wasSaved = false;

  constructor() {
    super();
    this.open = false;
    this.name = "";
    this.program = null;
    this.raw = null;
    this.channels = [];
    this.co2FixedStop = null;
    this.running = false;
    this.willReapply = false;
    this.save = null;
    this._draft = null;
    this._saving = false;
    this._saveError = null;
    this._discarding = false;
  }

  private get _sheet(): AquariumSheet | null {
    return this.renderRoot.querySelector("aquarium-sheet");
  }

  private get _dirty(): boolean {
    return this._draft !== null && this._base !== null && !draftsEqual(this._draft, this._base);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) this._reset();
  }

  /** Start from the program as it is stored every time the sheet opens. */
  private _reset(): void {
    this._saving = false;
    this._saveError = null;
    this._discarding = false;
    this._wasSaved = false;
    if (!this.program) {
      this._base = this._draft = this._opened = null;
      return;
    }
    this._base = draftFromProgram(this.program, this.channels.length);
    this._draft = draftFromProgram(this.program, this.channels.length);
    this._opened = this.raw;
  }

  private _change(changes: Partial<ProgramDraft>): void {
    if (!this._draft) return;
    this._draft = { ...this._draft, ...changes };
    this._saveError = null;
  }

  private _level(part: "day" | "night", index: number, value: number): void {
    const draft = this._draft;
    if (!draft) return;
    this._change({ [part]: draft[part].map((level, i) => (i === index ? Math.round(value) : level)) });
  }

  // ---- saving and closing ----

  private async _save(): Promise<void> {
    const draft = this._draft;
    const opened = this._opened;
    const save = this.save;
    if (!draft || !opened || !save || this._saving || !this._dirty || validateDraft(draft).length > 0) return;
    this._saving = true;
    this._saveError = null;
    try {
      const report = await save(draft, opened);
      this._toast(report);
      this._saving = false;
      this._wasSaved = true;
      this._base = draft;
      this._sheet?.close();
    } catch (error) {
      this._saving = false;
      this._saveError = describeError(error, "The program could not be saved.");
    }
  }

  private _toast(request: ToastRequest): void {
    this.dispatchEvent(new CustomEvent<ToastRequest>("aquarium-toast", { detail: request, bubbles: true, composed: true }));
  }

  private _onCloseRequest = (event: Event): void => {
    if (this._saving) {
      event.preventDefault();
      return;
    }
    if (this._discarding) {
      event.preventDefault();
      this._discarding = false;
      return;
    }
    if (this._dirty) {
      event.preventDefault();
      this._discarding = true;
      void this.updateComplete.then(() => this.renderRoot.querySelector(".keep-editing")?.shadowRoot?.querySelector<HTMLElement>("button")?.focus());
    }
  };

  /** The dialog would focus the summary box (the only field it can reach), which pops the keyboard
   * up on a phone; start on the title instead, like a screen reader wants. */
  private _onSheetOpened = (): void => {
    this.renderRoot.querySelector<HTMLElement>(".title")?.focus({ preventScroll: true });
  };

  private _onSheetClosed = (): void => {
    this.open = false;
    this.dispatchEvent(new CustomEvent<ProgramEditorClosedDetail>("program-editor-closed", { detail: { saved: this._wasSaved }, bubbles: true, composed: true }));
  };

  private _discard(): void {
    this._discarding = false;
    this._base = this._draft; // nothing left to lose: close without asking again
    this._sheet?.close();
  }

  // ---- render ----

  private _issue(issues: readonly DraftIssue[], ...fields: DraftField[]): DraftIssue | undefined {
    return issues.find((issue) => fields.includes(issue.field));
  }

  private _field(issues: readonly DraftIssue[], field: DraftField, label: string, value: number, kind: "time" | "number", extra: { step?: number; max?: number; unit?: string; zeroText?: string; disabled?: boolean } = {}, onChange: (value: number) => void): TemplateResult {
    const issue = this._issue(issues, field);
    return html`<div class="cell">
      <aquarium-stepper-field .label=${label} .kind=${kind} .value=${value} .step=${extra.step ?? (kind === "time" ? 15 : 1)} .max=${extra.max ?? 999} .unit=${extra.unit ?? ""} .zeroText=${extra.zeroText ?? ""} ?disabled=${extra.disabled === true} ?invalid=${issue !== undefined} @field-change=${(event: CustomEvent<FieldChangeDetail>) => onChange(event.detail.value)}></aquarium-stepper-field>
      ${issue ? html`<p class="field-error" role="alert">${icon("alert")}${issue.message}</p>` : nothing}
    </div>`;
  }

  private _levels(issues: readonly DraftIssue[], part: "day" | "night", title: string, draft: ProgramDraft): TemplateResult {
    const longest = Math.max(0, ...this.channels.map((channel) => channel.name.length));
    const labelWidth = Math.min(112, Math.max(60, longest * 7.5 + 22));
    const issue = this._issue(issues, part);
    return html`<div class="levels" role="group" aria-label=${title} style=${`--aquarium-slider-label:${labelWidth}px`}>
      <h4 class="sub-title">${title}</h4>
      ${this.channels.map((channel, index) => html`<aquarium-slider .label=${channel.name} .dot=${channel.colour} .fill=${channel.colour} .value=${draft[part][index] ?? 0} @slider-input=${(event: CustomEvent<SliderDetail>) => this._level(part, index, event.detail.value)}></aquarium-slider>`)}
      ${issue ? html`<p class="field-error" role="alert">${icon("alert")}${issue.message}</p>` : nothing}
    </div>`;
  }

  private _consequence(): string {
    const name = this.name;
    if (!this.running) return `Saves ${name} in Home Assistant. It is not running, so the light does not change until you switch to it.`;
    return this.willReapply ? `Saves ${name} in Home Assistant. It is running now, so it is also sent to the light straight away.` : `Saves ${name} in Home Assistant. It is running now: press Re-apply afterwards to send it to the light.`;
  }

  private _renderFooter(issues: readonly DraftIssue[]): TemplateResult {
    if (this._discarding) {
      return html`<div class="strip" role="group" aria-label="Unsaved changes">
        <span class="strip-text">Discard your changes to ${this.name}?</span>
        <div class="strip-actions">
          <aq-pill-button class="keep-editing" variant="primary" label="Keep editing" @lu-press=${() => (this._discarding = false)}></aq-pill-button>
          <aq-pill-button variant="secondary" label="Discard" @lu-press=${this._discard}></aq-pill-button>
        </div>
      </div>`;
    }
    const blocked = issues.length > 0;
    const dirty = this._dirty;
    const note = blocked ? (issues.length === 1 ? issues[0]!.message : "Some values need fixing before this can be saved.") : dirty ? "" : "Change something to save.";
    return html`
      ${note ? html`<p class="note">${icon(blocked ? "alert" : "info")}<span>${note}</span></p>` : nothing}
      ${this._saveError ? html`<aq-notice kind="error" compact heading="Couldn't save" .message=${this._saveError}></aq-notice>` : nothing}
      <div class="actions">
        <aquarium-confirm-action label=${`Hold to save ${this.name}`} complete-label="Saved" confirm-label="Save now" icon="save" .consequence=${this._consequence()} ?disabled=${blocked || !dirty} ?busy=${this._saving} @confirmed=${this._save}></aquarium-confirm-action>
        <aq-pill-button variant="quiet" label="Cancel" ?disabled=${this._saving} @lu-press=${() => this._sheet?.requestClose()}></aq-pill-button>
      </div>`;
  }

  render() {
    const draft = this._draft;
    const title = `Edit ${this.name}`;
    if (!draft) return html`<aquarium-sheet .open=${this.open} .label=${title} @closed=${this._onSheetClosed}><div slot="header"><h2 class="title">${title}</h2></div></aquarium-sheet>`;
    const issues = validateDraft(draft);
    const cautions = this.program ? draftCautions(draft, { co2FixedStop: this.co2FixedStop }) : [];
    const points = draftPoints(draft, this.channels.length);
    const co2Off = !draft.co2Enabled;
    return html`<aquarium-sheet .open=${this.open} .label=${title} @close-request=${this._onCloseRequest} @closed=${this._onSheetClosed} @opened=${this._onSheetOpened}>
      <div slot="header" class="head">
        <h2 class="title" tabindex="-1">${title}</h2>
        <p class="sub">${this.running ? "Running now" : "Not running"}</p>
      </div>
      <div class="editor" ?inert=${this._saving}>
        <div class="preview">
          ${points
            ? html`<aquarium-schedule-chart compact .points=${points} .channels=${this.channels} .label=${`${this.name} preview`}></aquarium-schedule-chart>`
            : html`<aq-notice kind="warning" compact heading="No preview yet" message="Fix the times below to see the day."></aq-notice>`}
        </div>

        <section class="group" aria-labelledby="g-light">
          <h3 class="group-title" id="g-light">Light</h3>
          <div class="fields">
            ${this._field(issues, "sunrise", "Sunrise", draft.sunrise, "time", {}, (value) => this._change({ sunrise: value }))}
            ${this._field(issues, "sunriseRamp", "Sunrise ramp", draft.sunriseRamp, "number", { step: 5, max: RAMP_MAX, unit: "min" }, (value) => this._change({ sunriseRamp: value }))}
            ${this._field(issues, "sunset", "Sunset", draft.sunset, "time", {}, (value) => this._change({ sunset: value }))}
            ${this._field(issues, "sunsetRamp", "Sunset ramp", draft.sunsetRamp, "number", { step: 5, max: RAMP_MAX, unit: "min" }, (value) => this._change({ sunsetRamp: value }))}
          </div>
          <p class="help">The light fades up from sunrise over the sunrise ramp, and fades down to the night levels so it finishes at sunset.</p>
          <aq-switch label="Switch off overnight" hint=${draft.sleepOn ? "Off from the sleep time until sunrise." : "The night levels hold until sunrise."} ?checked=${draft.sleepOn} @lu-change=${(event: CustomEvent<{ checked: boolean }>) => this._change({ sleepOn: event.detail.checked })}></aq-switch>
          ${draft.sleepOn ? this._field(issues, "sleep", "Sleep at", draft.sleep, "time", {}, (value) => this._change({ sleep: value })) : nothing}
          ${this._levels(issues, "day", "Day levels", draft)}
          ${this._levels(issues, "night", "Night levels", draft)}
        </section>

        <section class="group" aria-labelledby="g-co2">
          <h3 class="group-title" id="g-co2">CO2</h3>
          <aq-switch label="Run CO2 in this program" hint=${draft.co2Enabled ? "Home Assistant runs CO2 only inside this window." : "CO2 stays off while this program runs."} ?checked=${draft.co2Enabled} @lu-change=${(event: CustomEvent<{ checked: boolean }>) => this._change({ co2Enabled: event.detail.checked })}></aq-switch>
          <div class="fields">
            ${this._field(issues, "co2Start", "CO2 starts", draft.co2Start, "time", { disabled: co2Off }, (value) => this._change({ co2Start: value }))}
            ${this._field(issues, "co2End", "CO2 stops", draft.co2End, "time", { disabled: co2Off }, (value) => this._change({ co2End: value }))}
          </div>
          ${cautions.map((caution) => html`<aq-notice kind="warning" compact message=${caution}></aq-notice>`)}
        </section>

        <section class="group" aria-labelledby="g-plan">
          <h3 class="group-title" id="g-plan">Plan</h3>
          ${this._field(issues, "reviewEveryDays", "Remind me every", draft.reviewEveryDays, "number", { max: 365, unit: "days", zeroText: "Never" }, (value) => this._change({ reviewEveryDays: value }))}
          <p class="help">${draft.reviewEveryDays > 0 ? `You get a reminder to check the tank every ${DAYS_WORD(draft.reviewEveryDays)} while this program runs.` : "No reminders while this program runs."}</p>
          ${this._field(issues, "maxDays", "Ends after", draft.maxDays, "number", { max: 365, unit: "days", zeroText: "Never" }, (value) => this._change({ maxDays: value }))}
          <p class="help">${draft.maxDays > 0 ? `Home Assistant switches to another program by itself after ${DAYS_WORD(draft.maxDays)}.` : "It runs until you switch to another program."}</p>
          <label class="summary">
            <span class="summary-label">Summary</span>
            <textarea rows="3" maxlength="600" .value=${draft.summary} @input=${(event: Event) => this._change({ summary: (event.target as HTMLTextAreaElement).value })}></textarea>
          </label>
        </section>
      </div>
      <div slot="footer" class="foot">${this._renderFooter(issues)}</div>
    </aquarium-sheet>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    SEGMENT_CSS,
    STRIP_CSS,
    css`
      :host { display: contents; }
      .head { min-width: 0; }
      .title { margin: 0; color: var(--lu-ink); font: 600 var(--lu-type-title)/1.25 var(--lu-font); overflow-wrap: anywhere; }
      .title:focus { outline: none; }
      .sub { margin: 2px 0 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.3 var(--lu-font); }

      .editor { container-type: inline-size; display: grid; gap: var(--lu-space-5); padding-bottom: var(--lu-space-2); }
      .preview { position: sticky; top: 0; z-index: 3; margin: 0 calc(var(--lu-space-5) * -1); padding: var(--lu-space-2) var(--lu-space-5) var(--lu-space-1); background: linear-gradient(var(--lu-card), var(--lu-card)), var(--lu-canvas); border-bottom: 1px solid var(--lu-edge); }
      .group { display: grid; gap: var(--lu-space-2); min-width: 0; }
      .group-title { margin: 0; color: var(--lu-ink); font: 600 var(--lu-type-body)/1.3 var(--lu-font); }
      .sub-title { margin: var(--lu-space-2) 0 0; color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.3 var(--lu-font); }
      .fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--lu-space-2) var(--lu-space-6); min-width: 0; }
      @container (min-width: 560px) { .fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      .cell { display: grid; gap: var(--lu-space-1); min-width: 0; }
      .levels { display: grid; min-width: 0; }
      .help { margin: calc(var(--lu-space-1) * -1) 0 0; color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.4 var(--lu-font); }
      .field-error { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink); font: 500 var(--lu-type-label)/1.35 var(--lu-font); }
      .field-error .icon { flex: none; margin-top: 1px; font-size: 18px; color: var(--lu-danger); }

      .summary { display: grid; gap: var(--lu-space-1); }
      .summary-label { color: var(--lu-ink); font: 500 var(--lu-type-label)/1.25 var(--lu-font); }
      textarea { box-sizing: border-box; width: 100%; min-height: 84px; padding: var(--lu-space-3); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); background: var(--lu-well); color: var(--lu-ink); color-scheme: inherit; font: 400 var(--lu-type-body)/1.4 var(--lu-font); resize: vertical; }
      textarea:focus-visible { outline: 2px solid transparent; background-image: linear-gradient(var(--lu-focus-wash), var(--lu-focus-wash)); box-shadow: var(--lu-focus-landing); }

      .foot { display: grid; gap: var(--lu-space-2); }
      .note { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .note .icon { flex: none; margin-top: 1px; font-size: 18px; color: var(--lu-ink-2); }
      .actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--lu-space-2); }
      .actions aquarium-confirm-action { flex: 1 1 260px; min-width: 0; }
      .actions aq-pill-button { flex: 0 1 auto; }
    `,
  ];
}

customElements.define("aquarium-program-editor", AquariumProgramEditor);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-program-editor": AquariumProgramEditor;
  }
}


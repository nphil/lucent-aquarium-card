import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { DeviceModel, ProgramData, ScheduleModel } from "../adapters/types.ts";
import { swatchColour } from "../lib/channels.ts";
import { pointCountLabel } from "../lib/chart-model.ts";
import { describeError } from "../lib/errors.ts";
import { icon } from "../lib/icons.ts";
import { brightestPoint, parseTypedTime, restorePoint, setPointTime } from "../lib/point-edit.ts";
import { formatTime, insertPoint, movePointTo, pointsEqual, removePoint, setPointLevel, sortPoints, validatePoints, type SchedulePoint } from "../lib/points.ts";
import { PreviewSession, type PreviewStatus } from "../lib/preview-session.ts";
import type { ProgramStore } from "../lib/program-store.ts";
import { nextRovingIndex } from "../lib/roving.ts";
import { NOT_CONNECTED, overwriteNote, programName } from "../lib/schedule-view.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import { SEGMENT_CSS, STRIP_CSS } from "../styles/schedule.ts";
import type { PointAddDetail, PointLevelDetail, PointMoveDetail, PointSelectDetail, DragStateDetail, AquariumScheduleChart } from "./aquarium-schedule-chart.ts";
import type { AquariumSheet } from "./aquarium-sheet.ts";
import type { SliderDetail } from "./aquarium-slider.ts";
import type { ToastRequest } from "./aq-toast.ts";
import "./aq-chip.ts";
import "./aq-icon-button.ts";
import "./aq-notice.ts";
import "./aq-pill-button.ts";
import "./aquarium-hold-button.ts";
import "./aquarium-schedule-chart.ts";
import "./aquarium-sheet.ts";
import "./aquarium-slider.ts";

/** How long the Undo strip stays after a point is deleted. */
const UNDO_MS = 6000;
/** The step of the time control's +/- buttons and of chart drags. */
const STEP_MINUTES = 15;

export interface EditorClosedDetail {
  /** The draft was written to the light before it closed. */
  saved: boolean;
  /** The program that now holds it (the one to show), or the one that was being edited. */
  program: string;
}

interface UndoState {
  point: SchedulePoint;
  /** Restoring failed (the program filled up meanwhile); the strip says why and no longer offers Undo. */
  failed: boolean;
}

/** Focus the real button inside a `aq-pill-button` (its host is not focusable itself). */
function focusPill(host: Element | null): void {
  host?.shadowRoot?.querySelector<HTMLElement>("button")?.focus();
}

/** The schedule editor, in its own bottom sheet / dialog. It edits a DRAFT of a program's points
 * with the rules in `lib/points.ts` and never touches the light until the user confirms a save,
 * except through the optional live preview (`schedule.preview`), which shows the selected point's
 * levels immediately and is always ended when the editor stops.
 *
 * `program` is the slot being edited; for a built-in used as a template (`template`) it is only
 * the suggested slot, and a "Save to" choice picks the real one. Events: `editor-closed`
 * (`EditorClosedDetail`, after it really closed), `aquarium-toast` (`ToastRequest`) and
 * `store-changed` (the program store was written; the panel re-renders). */
export class AquariumDiyEditor extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    schedule: { attribute: false },
    phase: { attribute: false },
    store: { attribute: false },
    program: { type: String },
    initialPoints: { attribute: false },
    template: { type: Boolean },
    sourceName: { type: String, attribute: "source-name" },
    nowMinutes: { attribute: false },
    _draft: { state: true },
    _selected: { state: true },
    _target: { state: true },
    _previewOn: { state: true },
    _previewStatus: { state: true },
    _saving: { state: true },
    _saveError: { state: true },
    _confirming: { state: true },
    _discarding: { state: true },
    _timeError: { state: true },
    _undo: { state: true },
    _dragging: { state: true },
  };

  declare open: boolean;
  declare schedule: ScheduleModel | null;
  declare phase: DeviceModel["phase"] | null;
  declare store: ProgramStore | null;
  declare program: string;
  declare initialPoints: SchedulePoint[];
  declare template: boolean;
  /** Name of the built-in being customised (template mode). */
  declare sourceName: string;
  declare nowMinutes: number | null;
  declare _draft: SchedulePoint[];
  declare _selected: number;
  declare _target: string;
  declare _previewOn: boolean;
  declare _previewStatus: PreviewStatus;
  declare _saving: boolean;
  declare _saveError: string | null;
  declare _confirming: boolean;
  declare _discarding: boolean;
  declare _timeError: string | null;
  declare _undo: UndoState | null;
  declare _dragging: boolean;

  private _baseline: SchedulePoint[] = [];
  private _savedTo: string | null = null;
  private _undoTimer: number | undefined;
  private readonly _preview: PreviewSession;

  constructor() {
    super();
    this.open = false;
    this.schedule = null;
    this.phase = null;
    this.store = null;
    this.program = "";
    this.initialPoints = [];
    this.template = false;
    this.sourceName = "";
    this.nowMinutes = null;
    this._draft = [];
    this._selected = -1;
    this._target = "";
    this._previewOn = true;
    this._previewStatus = { phase: "idle" };
    this._saving = false;
    this._saveError = null;
    this._confirming = false;
    this._discarding = false;
    this._timeError = null;
    this._undo = null;
    this._dragging = false;
    this._preview = new PreviewSession(
      {
        show: (levels) => this.schedule?.preview?.show(levels) ?? Promise.resolve(),
        end: () => this.schedule?.preview?.end() ?? Promise.resolve(),
      },
      { onStatus: (status) => (this._previewStatus = status), describeError: (error) => describeError(error, "The preview could not be sent.") },
    );
  }

  private get _channels() {
    return this.schedule?.channels ?? [];
  }

  private get _max(): number {
    return this.schedule?.maxPoints ?? 12;
  }

  private get _sheet(): AquariumSheet | null {
    return this.renderRoot.querySelector("aquarium-sheet");
  }

  private get _chart(): AquariumScheduleChart | null {
    return this.renderRoot.querySelector("aquarium-schedule-chart");
  }

  private get _dirty(): boolean {
    return !pointsEqual(this._draft, this._baseline);
  }

  // ---- lifecycle ----

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("pagehide", this._onPageHide);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("pagehide", this._onPageHide);
    window.clearTimeout(this._undoTimer);
    this._preview.dispose();
  }

  private _onPageHide = (): void => {
    void this._preview.end("user");
  };

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) this._reset();
    if (changed.has("phase") && this.phase === "unavailable") void this._preview.end("user");
  }

  protected updated(changed: PropertyValues<this>): void {
    if (!changed.has("open")) return;
    if (this.open) void this._loadTarget();
    else if (changed.get("open") === true) this._onClosed();
  }

  /** Start from the caller's points every time the editor opens. */
  private _reset(): void {
    this._draft = sortPoints(this.initialPoints);
    this._baseline = this._draft;
    this._selected = brightestPoint(this._draft);
    this._target = this.program;
    this._previewOn = true;
    this._saving = false;
    this._saveError = null;
    this._confirming = false;
    this._discarding = false;
    this._timeError = null;
    this._undo = null;
    this._dragging = false;
    this._savedTo = null;
  }

  private _onClosed(): void {
    void this._preview.end("user");
    window.clearTimeout(this._undoTimer);
    this._undo = null;
    this._confirming = false;
    this._discarding = false;
    const saved = this._savedTo;
    this._savedTo = null;
    this.dispatchEvent(new CustomEvent<EditorClosedDetail>("editor-closed", { detail: { saved: saved !== null, program: saved ?? this._target }, bubbles: true, composed: true }));
  }

  private _toast(message: string, kind: ToastRequest["kind"] = "info"): void {
    this.dispatchEvent(new CustomEvent<ToastRequest>("aquarium-toast", { detail: { message, kind }, bubbles: true, composed: true }));
  }

  private _storeChanged(): void {
    this.dispatchEvent(new CustomEvent("store-changed", { bubbles: true }));
  }

  /** In template mode, read the chosen slot so the footer can say what saving would overwrite. */
  private async _loadTarget(): Promise<void> {
    const store = this.store;
    if (!this.template || !store || !this._target || this.phase === "unavailable") return;
    const request = store.load(this._target);
    this.requestUpdate();
    await request;
    this.requestUpdate();
  }

  // ---- draft edits ----

  private _commit(points: SchedulePoint[], index: number = this._selected): void {
    if (points === this._draft && index === this._selected) return;
    this._draft = points;
    this._selected = Math.min(index, points.length - 1);
    this._timeError = null;
    this._saveError = null;
    this._confirming = false;
    this._touchPreview();
  }

  private _select(index: number): void {
    if (index === this._selected || !this._draft[index]) return;
    this._selected = index;
    this._timeError = null;
    if (this._preview.status.phase !== "idle") this._touchPreview();
  }

  /** An edit gesture: show the selected point's levels on the light (when previewing is on). */
  private _touchPreview(): void {
    if (!this.open || !this._previewOn || !this.schedule?.preview || this.phase === "unavailable" || this._saving) return;
    const levels = this._draft[this._selected]?.levels;
    if (levels) this._preview.show(levels);
  }

  private _toggleEye(): void {
    this._previewOn = !this._previewOn;
    if (this._previewOn) this._touchPreview();
    else void this._preview.end("user");
  }

  private _onPointSelect = (event: CustomEvent<PointSelectDetail>): void => this._select(event.detail.index);

  private _onPointMove = (event: CustomEvent<PointMoveDetail>): void => {
    const { index, minutes, step } = event.detail;
    this._commit(movePointTo(this._draft, index, minutes, step), index);
  };

  private _onPointLevel = (event: CustomEvent<PointLevelDetail>): void => {
    const { index, channel, value } = event.detail;
    this._commit(setPointLevel(this._draft, index, channel, value), index);
  };

  private _onPointAdd = (event: CustomEvent<PointAddDetail>): void => {
    this._insert(event.detail.minutes);
  };

  private _insert(at?: number): void {
    const inserted = insertPoint(this._draft, { at, max: this._max, channelCount: this._channels.length });
    if (inserted) this._commit(inserted.points, inserted.index);
  }

  private _step(delta: number): void {
    const point = this._draft[this._selected];
    if (point) this._commit(movePointTo(this._draft, this._selected, point.minutes + delta, STEP_MINUTES));
  }

  private _onTimeChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const point = this._draft[this._selected];
    if (!point) return;
    const typed = input.value.trim();
    const minutes = parseTypedTime(typed);
    const result = minutes === null ? null : setPointTime(this._draft, this._selected, minutes);
    if (result?.ok) {
      this._commit(result.points, result.index);
      return;
    }
    // Refused or unreadable: keep the old time on screen and say why (a cleared field just resets).
    input.value = formatTime(point.minutes);
    this._timeError = result ? result.error : typed === "" ? null : "Use a 24-hour time such as 07:15";
  }

  private _delete(): void {
    const point = this._draft[this._selected];
    if (!point || this._draft.length <= 1) return;
    const removed = removePoint(this._draft, this._selected);
    this._commit(removed.points, removed.index);
    this._showUndo({ point, failed: false }, UNDO_MS);
  }

  private _undoDelete(): void {
    const undo = this._undo;
    if (!undo) return;
    const restored = restorePoint(this._draft, undo.point, this._max);
    if (restored) {
      this._clearUndo();
      this._commit(restored.points, restored.index);
    } else {
      this._showUndo({ point: undo.point, failed: true }, 4000);
    }
  }

  private _showUndo(undo: UndoState, ms: number): void {
    this._undo = undo;
    this._armUndo(ms);
  }

  private _armUndo(ms: number): void {
    window.clearTimeout(this._undoTimer);
    this._undoTimer = window.setTimeout(() => (this._undo = null), ms);
  }

  private _clearUndo(): void {
    window.clearTimeout(this._undoTimer);
    this._undo = null;
  }

  // ---- saving and closing ----

  /** Why saving is not possible right now, or null. */
  private get _saveBlock(): string | null {
    if (!this.schedule?.save) return "This light's schedules can't be changed from the card.";
    if (this.phase === "unavailable") return `${NOT_CONNECTED} Saving needs it.`;
    return validatePoints(this._draft, this._max, this._channels.length)[0]?.message ?? null;
  }

  private _askConfirm(): void {
    if (this._saveBlock || this._saving) return;
    this._confirming = true;
    void this.updateComplete.then(() => focusPill(this.renderRoot.querySelector(".confirm-cancel")));
  }

  private async _save(): Promise<void> {
    const schedule = this.schedule;
    if (this._saving || this._saveBlock || !schedule?.save) return;
    this._confirming = false;
    this._saving = true;
    this._saveError = null;
    this._clearUndo();
    const target = this._target;
    const sent = sortPoints(this._draft);
    await this._preview.end("user");
    try {
      const outcome = await schedule.save(target, sent);
      const name = programName(schedule.programs, target);
      const data: ProgramData = { id: target, name, points: outcome.points, editable: true, source: "device" };
      this.store?.put(target, data);
      const matches = outcome.verified && pointsEqual(outcome.points, sent);
      this._toast(matches ? `${name} saved – verified on the light` : "Saved, but the light reports different values", matches ? "info" : "error");
      this._savedTo = target;
      this._saving = false;
      this.open = false;
      this._storeChanged();
      void this._reconcile(target, sent);
    } catch (error) {
      this._saving = false;
      this._saveError = describeError(error, "The light did not accept the program.");
    }
  }

  /** Read the program back from the light once more; say so when it is not what was sent. */
  private async _reconcile(target: string, sent: SchedulePoint[]): Promise<void> {
    const store = this.store;
    if (!store) return;
    await store.load(target, { force: true });
    this._storeChanged();
    const entry = store.entry(target);
    if (entry.status === "ready" && entry.data && !pointsEqual(entry.data.points, sent)) {
      this._toast(`The light now reports different values for ${programName(this.schedule?.programs ?? [], target)}.`, "error");
    }
  }

  private _onCloseRequest = (event: Event): void => {
    if (this._saving) {
      event.preventDefault();
      return;
    }
    if (this._dragging) {
      event.preventDefault();
      this._chart?.cancelDrag();
      return;
    }
    if (this._confirming) {
      event.preventDefault();
      this._confirming = false;
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
      void this.updateComplete.then(() => focusPill(this.renderRoot.querySelector(".keep-editing")));
    }
  };

  private _discard(): void {
    this._discarding = false;
    this.open = false;
  }

  private _onSheetClosed = (): void => {
    this.open = false;
  };

  /** The dialog would focus its first control, the preview toggle; start on the selected point
   * instead, which is what the person came to edit. */
  private _onSheetOpened = (): void => {
    this.renderRoot.querySelector<HTMLElement>('.chip[aria-checked="true"]')?.focus({ preventScroll: true });
  };

  // ---- render ----

  private _renderPreviewStatus(): TemplateResult | typeof nothing {
    if (!this.schedule?.preview) return nothing;
    const status = this._previewStatus;
    let line: TemplateResult;
    if (this.phase === "unavailable") {
      line = html`<span class="status-text warn">${icon("alert")}${NOT_CONNECTED} Preview and saving need it.</span>`;
    } else if (!this._previewOn) {
      line = html`<span class="status-text">${icon("eyeOff")}Preview is off. The light stays as it is.</span>`;
    } else if (status.phase === "error") {
      line = html`<span class="status-text warn">${icon("alert")}Preview failed: ${status.message ?? "the light did not answer."}</span>`;
    } else if (status.phase === "active") {
      line = html`<aq-chip kind="positive" dot label="Previewing on the light"></aq-chip>`;
    } else if (status.endedBy === "idle") {
      line = html`<span class="status-text">${icon("clock")}Preview stopped after 3 minutes of inactivity</span>`;
    } else {
      line = html`<span class="status-text">${icon("eye")}Adjust a point to preview it on the light</span>`;
    }
    const lightOff = this.phase === "off" && this._previewOn;
    return html`<div class="status" role="status">${line}${lightOff ? html`<span class="status-text">${icon("info")}The light is off – turn it on to see the preview</span>` : nothing}</div>`;
  }

  private _renderSaveTo(schedule: ScheduleModel): TemplateResult {
    const slots = schedule.programs.filter((program) => program.editable);
    const current = Math.max(0, slots.findIndex((slot) => slot.id === this._target));
    const note = (id: string): string => {
      const entry = this.store?.entry(id);
      if (!entry || !entry.data) return entry?.status === "loading" ? "Reading…" : "Not read yet";
      return entry.data.points.length === 0 ? "Empty" : pointCountLabel(entry.data.points.length);
    };
    return html`<div class="field" role="radiogroup" aria-labelledby="save-to-label" @keydown=${(event: KeyboardEvent) => this._onSlotKey(event, slots.map((slot) => slot.id), current)}>
      <span class="label" id="save-to-label">Save to</span>
      <div class="tray" style=${`grid-template-columns:repeat(${Math.max(1, slots.length)}, minmax(0, 1fr))`}>
        ${slots.map(
          (slot) => html`<button type="button" role="radio" class="seg slot" aria-checked=${slot.id === this._target ? "true" : "false"} tabindex=${slot.id === this._target ? 0 : -1} data-id=${slot.id} ?disabled=${this._saving} @click=${() => this._setTarget(slot.id)}>
            <span class="slot-name">${slot.name}</span><span class="slot-note">${note(slot.id)}</span>
          </button>`,
        )}
      </div>
    </div>`;
  }

  private _setTarget(id: string): void {
    if (id === this._target) return;
    this._target = id;
    this._confirming = false;
    this._saveError = null;
    void this._loadTarget();
  }

  private _onSlotKey(event: KeyboardEvent, ids: string[], current: number): void {
    const next = nextRovingIndex(event.key, current, ids.length);
    const id = next === null ? undefined : ids[next];
    if (id === undefined) return;
    event.preventDefault();
    this._setTarget(id);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`.slot[data-id="${id}"]`)?.focus());
  }

  private _onChipKey(event: KeyboardEvent): void {
    const next = nextRovingIndex(event.key, this._selected, this._draft.length);
    if (next === null) return;
    event.preventDefault();
    this._select(next);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`.chip[data-index="${next}"]`)?.focus());
  }

  private _renderPointPanel(schedule: ScheduleModel): TemplateResult {
    const channels = schedule.channels;
    const point = this._draft[this._selected];
    if (!point) return html`<p class="empty">This program has no points yet. Add one to start.</p>`;
    const canEarlier = movePointTo(this._draft, this._selected, point.minutes - STEP_MINUTES, STEP_MINUTES) !== this._draft;
    const canLater = movePointTo(this._draft, this._selected, point.minutes + STEP_MINUTES, STEP_MINUTES) !== this._draft;
    const onlyOne = this._draft.length <= 1;
    const labelWidth = Math.min(112, Math.max(60, Math.max(...channels.map((channel) => channel.name.length)) * 7.5 + 22));
    return html`<section class="point" aria-labelledby="point-title" style=${`--time-label:${labelWidth}px`}>
      <h3 class="label" id="point-title">Point ${this._selected + 1} of ${this._draft.length}</h3>
      <div class="time-row">
        <span class="row-label" id="time-label">Time</span>
        <div class="time-control">
          <aq-icon-button tone="raised" icon="minus" label="15 minutes earlier" ?disabled=${!canEarlier} @lu-press=${() => this._step(-STEP_MINUTES)}></aq-icon-button>
          <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="5" placeholder="HH:MM" aria-labelledby="time-label" .value=${live(formatTime(point.minutes))} @change=${this._onTimeChange} @focus=${(event: FocusEvent) => (event.target as HTMLInputElement).select()} />
          <aq-icon-button tone="raised" icon="plus" label="15 minutes later" ?disabled=${!canLater} @lu-press=${() => this._step(STEP_MINUTES)}></aq-icon-button>
        </div>
      </div>
      ${this._timeError ? html`<p class="field-error" role="alert">${icon("alert")}${this._timeError}</p>` : nothing}
      <div class="sliders" style=${`--aquarium-slider-label:${labelWidth}px`}>
        ${channels.map(
          (channel, index) =>
            html`<aquarium-slider label=${channel.name} dot=${channel.colour} fill=${channel.colour} .value=${point.levels[index] ?? 0} @slider-input=${(event: CustomEvent<SliderDetail>) => this._commit(setPointLevel(this._draft, this._selected, index, event.detail.value))}></aquarium-slider>`,
        )}
      </div>
      <button type="button" class="delete" ?disabled=${onlyOne} @click=${this._delete}>${icon("delete")}<span>Delete point</span></button>
      ${onlyOne ? html`<p class="reason">A program needs at least one point</p>` : nothing}
    </section>`;
  }

  private _renderFooter(schedule: ScheduleModel): TemplateResult {
    const count = this._draft.length;
    const targetName = programName(schedule.programs, this._target);
    if (this._discarding) {
      return html`<div class="strip" role="group" aria-label="Unsaved changes">
        <span class="strip-text">Discard unsaved changes?</span>
        <div class="strip-actions">
          <aq-pill-button class="keep-editing" variant="primary" label="Keep editing" @lu-press=${() => (this._discarding = false)}></aq-pill-button>
          <aq-pill-button variant="secondary" label="Discard" @lu-press=${this._discard}></aq-pill-button>
        </div>
      </div>`;
    }
    if (this._confirming) {
      return html`<div class="strip" role="group" aria-label="Confirm overwrite">
        <span class="strip-text">Overwrite ${targetName} on the light with ${pointCountLabel(count)}?</span>
        <div class="strip-actions">
          <aq-pill-button class="confirm-cancel" variant="secondary" label="Cancel" @lu-press=${() => (this._confirming = false)}></aq-pill-button>
          <aq-pill-button variant="primary" icon="save" label="Save now" @lu-press=${this._save}></aq-pill-button>
        </div>
      </div>`;
    }
    const block = this._saveBlock;
    const entry = this.store?.entry(this._target);
    const overwrite = this.template && entry ? overwriteNote(targetName, entry) : null;
    const note = overwrite ?? `Saving overwrites ${targetName} on the light.`;
    return html`
      ${this._saving
        ? html`<p class="note" role="status">Writing ${pointCountLabel(count)} to the light…</p>`
        : block
          ? html`<p class="note warn">${icon("alert")}${block}</p>`
          : html`<p class="note">${note}</p>`}
      ${this._saveError ? html`<aq-notice kind="error" compact heading="Couldn't save the program" .message=${this._saveError} action-label="Try again" action-icon="refresh" @notice-action=${this._save}></aq-notice>` : nothing}
      <div class="actions">
        <aquarium-hold-button label="Hold to save to the light" complete-label="Saved" icon="save" ?disabled=${block !== null} ?busy=${this._saving} @confirmed=${this._save} @tap-confirm=${this._askConfirm}></aquarium-hold-button>
        <aq-pill-button variant="quiet" label="Cancel" ?disabled=${this._saving} @lu-press=${() => this._sheet?.requestClose()}></aq-pill-button>
      </div>`;
  }

  render() {
    const schedule = this.schedule;
    if (!schedule) return nothing;
    const title = this.template ? `Customise ${this.sourceName || "program"}` : `Edit ${programName(schedule.programs, this.program)}`;
    const full = this._draft.length >= this._max;
    const previewable = schedule.preview !== undefined;
    return html`<aquarium-sheet .open=${this.open} .label=${title} @close-request=${this._onCloseRequest} @closed=${this._onSheetClosed} @opened=${this._onSheetOpened}>
      <div slot="header" class="head">
        <h2 class="title">${title}</h2>
        <p class="sub">${this._draft.length} of ${this._max} points</p>
      </div>
      ${previewable
        ? html`<aq-icon-button slot="actions" toggle .pressed=${this._previewOn} .icon=${this._previewOn ? "eye" : "eyeOff"} label="Preview on the light" ?disabled=${this._saving || this.phase === "unavailable"} @lu-press=${this._toggleEye}></aq-icon-button>`
        : nothing}
      <div class="editor" ?inert=${this._saving}>
        ${this.template ? this._renderSaveTo(schedule) : nothing}
        ${this._renderPreviewStatus()}
        <div class="layout">
          <div class="main">
            <aquarium-schedule-chart interactive .points=${this._draft} .channels=${schedule.channels} .selected=${this._selected} .snap=${STEP_MINUTES} .nowMinutes=${this.nowMinutes} .label=${`${title} draft`}
              @point-select=${this._onPointSelect} @point-move=${this._onPointMove} @point-level=${this._onPointLevel} @point-add=${this._onPointAdd}
              @interaction=${() => this._touchPreview()} @drag-state=${(event: CustomEvent<DragStateDetail>) => (this._dragging = event.detail.dragging)}></aquarium-schedule-chart>
            <p class="hint">Drag the handles to edit. Double-tap the chart to add a point.</p>
            <section class="points" aria-labelledby="points-label">
              <div class="points-head">
                <span class="label" id="points-label">Points</span>
                <aq-pill-button variant="secondary" icon="plus" label="Add point" ?disabled=${full} @lu-press=${() => this._insert()}></aq-pill-button>
              </div>
              <div class="tray chips" role="radiogroup" aria-labelledby="points-label" @keydown=${this._onChipKey}>
                ${this._draft.map(
                  (point, index) => html`<button type="button" role="radio" class="seg chip" aria-checked=${index === this._selected ? "true" : "false"} tabindex=${index === this._selected ? 0 : -1} data-index=${index} @click=${() => this._select(index)}>${formatTime(point.minutes)}</button>`,
                )}
              </div>
              ${full ? html`<p class="reason">A program holds at most ${this._max} points</p>` : nothing}
            </section>
          </div>
          ${this._renderPointPanel(schedule)}
        </div>
        <div class="undo-region" role="status" aria-live="polite">${this._undo ? this._renderUndo(this._undo) : nothing}</div>
      </div>
      <div slot="footer" class="foot">${this._renderFooter(schedule)}</div>
    </aquarium-sheet>`;
  }

  private _renderUndo(undo: UndoState): TemplateResult {
    return html`<div class="strip undo" @pointerenter=${() => window.clearTimeout(this._undoTimer)} @pointerleave=${() => this._armUndo(UNDO_MS)} @focusin=${() => window.clearTimeout(this._undoTimer)} @focusout=${() => this._armUndo(UNDO_MS)}>
      ${undo.failed
        ? html`<span class="strip-text">Can't put the point back: a program holds at most ${this._max} points</span>`
        : html`<span class="strip-text">Point at ${formatTime(undo.point.minutes)} deleted</span>
          <div class="strip-actions"><aq-pill-button variant="secondary" icon="undo" label="Undo" @lu-press=${this._undoDelete}></aq-pill-button></div>`}
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    SEGMENT_CSS,
    STRIP_CSS,
    css`
      :host { display: contents; }
      .head { min-width: 0; }
      .title { margin: 0; color: var(--lu-ink); font: 600 var(--lu-type-title)/1.25 var(--lu-font); }
      .sub { margin: 2px 0 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.3 var(--lu-font); }

      .editor { container-type: inline-size; display: grid; gap: var(--lu-space-4); padding-top: var(--lu-space-1); }
      .layout { display: grid; gap: var(--lu-space-5); }
      @container (min-width: 600px) { .layout { grid-template-columns: minmax(0, 1.5fr) minmax(260px, 1fr); align-items: start; } }
      .main { display: grid; gap: var(--lu-space-3); min-width: 0; }
      .label { color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1.2 var(--lu-font); margin: 0; }
      .hint { margin: calc(var(--lu-space-1) * -1) 0 0; color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.4 var(--lu-font); text-align: center; }
      .reason, .empty { margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }

      .status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-1) var(--lu-space-4); min-height: 28px; }
      .status-text { display: inline-flex; align-items: center; gap: var(--lu-space-2); color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.35 var(--lu-font); }
      .status-text .icon, .note .icon, .field-error .icon { flex: none; font-size: 18px; }
      .warn { color: var(--lu-ink); }
      .warn .icon { color: var(--lu-warning); }

      .field { display: grid; gap: var(--lu-space-2); }
      .slot { gap: 2px; padding-left: var(--lu-space-3); padding-right: var(--lu-space-3); }
      .slot-name { font-weight: 600; }
      .slot-note { color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.2 var(--lu-font); }

      .points { display: grid; gap: var(--lu-space-2); }
      .points-head { display: flex; align-items: center; justify-content: space-between; gap: var(--lu-space-3); }
      .chips { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); }
      .chip { font-variant-numeric: tabular-nums; }

      .point { display: grid; gap: var(--lu-space-2); min-width: 0; }
      .time-row { display: grid; grid-template-columns: var(--time-label, 60px) minmax(0, 1fr); align-items: center; column-gap: var(--lu-space-2); }
      .row-label { color: var(--lu-ink); font: 500 var(--lu-type-label)/1.2 var(--lu-font); }
      .time-control { display: grid; grid-template-columns: var(--lu-target) minmax(0, 1fr) var(--lu-target); align-items: center; gap: var(--lu-space-2); }
      input { box-sizing: border-box; width: 100%; min-width: 0; height: var(--lu-target); padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); background: var(--lu-well); color: var(--lu-ink); color-scheme: inherit; font: 600 var(--lu-type-body)/1 var(--lu-font); font-variant-numeric: tabular-nums; text-align: center; }
      input:focus-visible { outline: 2px solid transparent; background-image: linear-gradient(var(--lu-focus-wash), var(--lu-focus-wash)); box-shadow: var(--lu-focus-landing); }
      .field-error { display: flex; align-items: center; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink); font: 500 var(--lu-type-label)/1.35 var(--lu-font); }
      .field-error .icon { color: var(--lu-danger); }
      .sliders { display: grid; }
      .delete { display: inline-flex; align-items: center; justify-content: center; gap: var(--lu-space-2); justify-self: start; min-height: var(--lu-target); padding: 0 var(--lu-space-5); border: 1px solid color-mix(in srgb, var(--lu-danger) 35%, var(--lu-edge)); border-radius: var(--lu-radius-pill); background: transparent; color: var(--lu-danger); font: 600 var(--lu-type-label)/1.2 var(--lu-font); cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease), transform var(--lu-motion-press) var(--lu-ease-press); }
      .delete .icon { font-size: 20px; }
      .delete:hover:not(:disabled) { background-color: color-mix(in srgb, var(--lu-danger) 10%, transparent); }
      .delete:active:not(:disabled) { transform: scale(var(--lu-scale-pressed)); }
      .delete:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }

      .undo-region { position: sticky; bottom: 0; z-index: 5; }
      .undo-region:not(:has(.strip)) { display: none; }

      .foot { display: grid; gap: var(--lu-space-2); }
      .note { display: flex; align-items: center; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .note.warn { color: var(--lu-ink); }
      .actions { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
      .actions aquarium-hold-button { flex: 1 1 220px; min-width: 0; }
      .actions aq-pill-button { flex: 0 1 auto; }
    `,
  ];
}

customElements.define("aquarium-diy-editor", AquariumDiyEditor);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-diy-editor": AquariumDiyEditor;
  }
}

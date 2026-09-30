import { LitElement, css, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { icon } from "../lib/icons.ts";
import { parseTypedTime } from "../lib/point-edit.ts";
import { formatTime, LAST_MINUTE } from "../lib/points.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./aq-icon-button.ts";

export interface FieldChangeDetail {
  value: number;
}

/** One labelled value with minus and plus buttons and a text box, for a time of day (`time`, the
 * value is minutes of the day) or a whole number (`number`, with an optional unit and a word for
 * zero such as "Never"). Typing is forgiving ("7", "715", "7:15"); something unreadable puts the
 * old value back and says what was expected. The value is never changed by the component itself:
 * it reports `field-change` with `{value}` and the owner decides. */
export class AquariumStepperField extends LitElement {
  static properties = {
    label: { type: String },
    kind: { type: String },
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    unit: { type: String },
    zeroText: { type: String, attribute: "zero-text" },
    disabled: { type: Boolean, reflect: true },
    invalid: { type: Boolean, reflect: true },
    _error: { state: true },
  };

  declare label: string;
  declare kind: "time" | "number";
  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  /** Suffix shown after a number ("min", "days"). */
  declare unit: string;
  /** Shown instead of 0 ("Never"). */
  declare zeroText: string;
  declare disabled: boolean;
  /** The owner found this value wrong (a rule spanning fields): draw it as such. */
  declare invalid: boolean;
  declare _error: string | null;

  constructor() {
    super();
    this.label = "";
    this.kind = "number";
    this.value = 0;
    this.min = 0;
    this.max = 999;
    this.step = 1;
    this.unit = "";
    this.zeroText = "";
    this.disabled = false;
    this.invalid = false;
    this._error = null;
  }

  private get _low(): number {
    return this.kind === "time" ? 0 : this.min;
  }

  private get _high(): number {
    return this.kind === "time" ? LAST_MINUTE : this.max;
  }

  private get _stepSize(): number {
    return this.kind === "time" ? this.step || 15 : this.step || 1;
  }

  private _shown(): string {
    if (this.kind === "time") return formatTime(this.value);
    return this.value === 0 && this.zeroText ? this.zeroText : String(this.value);
  }

  private _emit(value: number): void {
    const clamped = Math.min(this._high, Math.max(this._low, Math.round(value)));
    this._error = null;
    if (clamped !== this.value) this.dispatchEvent(new CustomEvent<FieldChangeDetail>("field-change", { detail: { value: clamped }, bubbles: true, composed: true }));
  }

  private _nudge(direction: 1 | -1): void {
    if (this.disabled) return;
    this._emit(this.value + direction * this._stepSize);
  }

  private _parseNumber(text: string): number | null {
    const typed = text.trim().toLowerCase();
    if (typed === "" || typed === this.zeroText.toLowerCase() || typed === "never" || typed === "off") return 0;
    const match = /^(\d{1,4})(?:\s*[a-z]*)?$/.exec(typed);
    return match ? Number(match[1]) : null;
  }

  private _onChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const typed = input.value.trim();
    const parsed = this.kind === "time" ? parseTypedTime(typed) : this._parseNumber(typed);
    const tooBig = parsed !== null && this.kind === "number" && parsed > this._high;
    if (parsed === null || tooBig) {
      input.value = this._shown();
      this._error = this.kind === "time" ? "Use a 24-hour time such as 07:15." : tooBig ? `Use a number from ${this._low} to ${this._high}.` : "Use a whole number.";
      return;
    }
    this._emit(parsed);
    input.value = this._shown();
  }

  render() {
    const time = this.kind === "time";
    const atLow = this.value <= this._low;
    const atHigh = this.value >= this._high;
    const less = time ? `${this.label}: ${this._stepSize} minutes earlier` : `${this.label}: less`;
    const more = time ? `${this.label}: ${this._stepSize} minutes later` : `${this.label}: more`;
    const showUnit = !time && this.unit !== "" && !(this.value === 0 && this.zeroText !== "");
    return html`<div class="field">
      <span class="label" id="label">${this.label}</span>
      <div class="control">
        <aq-icon-button tone="raised" icon="minus" label=${less} ?disabled=${this.disabled || atLow} @lu-press=${() => this._nudge(-1)}></aq-icon-button>
        <span class="box">
          <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="8" placeholder=${time ? "HH:MM" : ""} aria-labelledby="label" aria-invalid=${this.invalid || this._error ? "true" : "false"} aria-describedby=${this._error ? "error" : nothing} ?disabled=${this.disabled}
            .value=${live(this._shown())} @change=${this._onChange} @focus=${(event: FocusEvent) => (event.target as HTMLInputElement).select()} />
          ${showUnit ? html`<span class="unit" aria-hidden="true">${this.unit}</span>` : nothing}
        </span>
        <aq-icon-button tone="raised" icon="plus" label=${more} ?disabled=${this.disabled || atHigh} @lu-press=${() => this._nudge(1)}></aq-icon-button>
      </div>
      ${this._error ? html`<p class="error" id="error" role="alert">${icon("alert")}${this._error}</p>` : nothing}
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; container-type: inline-size; }
      .field { display: grid; grid-template-columns: minmax(72px, var(--field-label, 112px)) minmax(0, 1fr); align-items: center; column-gap: var(--lu-space-2); row-gap: var(--lu-space-1); }
      .label { color: var(--lu-ink); font: 500 var(--lu-type-label)/1.25 var(--lu-font); overflow-wrap: anywhere; }
      :host([disabled]) .label { color: var(--lu-ink-3); }
      .control { display: grid; grid-template-columns: var(--lu-target) minmax(0, 1fr) var(--lu-target); align-items: center; gap: var(--lu-space-2); min-width: 0; }
      .box { position: relative; display: block; min-width: 0; }
      input { width: 100%; min-width: 0; height: var(--lu-target); padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); background: var(--lu-well); color: var(--lu-ink); color-scheme: inherit; font: 600 var(--lu-type-body)/1 var(--lu-font); font-variant-numeric: tabular-nums; text-align: center; }
      input:disabled { opacity: var(--lu-disabled-opacity); }
      input[aria-invalid="true"] { border-color: var(--lu-danger); }
      input:focus-visible { outline: 2px solid transparent; background-image: linear-gradient(var(--lu-focus-wash), var(--lu-focus-wash)); box-shadow: var(--lu-focus-landing); }
      .unit { position: absolute; right: var(--lu-space-3); top: 50%; transform: translateY(-50%); color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1 var(--lu-font); pointer-events: none; }
      .box:has(.unit) input { padding-left: var(--lu-space-2); padding-right: 40px; }
      .error { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink); font: 500 var(--lu-type-label)/1.35 var(--lu-font); }
      .error .icon { flex: none; font-size: 18px; color: var(--lu-danger); }
      @container (max-width: 300px) { .field { grid-template-columns: minmax(0, 1fr); } }
    `,
  ];
}

customElements.define("aquarium-stepper-field", AquariumStepperField);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-stepper-field": AquariumStepperField;
  }
}

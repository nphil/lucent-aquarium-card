import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { icon, type IconName } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

export interface SliderDetail {
  value: number;
}

/** A Lucent slider: label and value on one 48 px row, a shallow recessed track with a filled
 * portion, and an isolated thumb. It wraps a native range input (keyboard, screen readers and
 * touch behave as the platform does; vertical swipes still scroll the page).
 *
 * `fill` is the fill colour: a literal channel colour for the RGBW sliders (content) or left
 * empty for the theme accent. Events: `slider-input` while dragging, `slider-change` when the
 * gesture ends (and for every keyboard step), both `{value}`. While the pointer is down the
 * `value` property is not pushed back into the input, so a late state echo cannot make the thumb
 * jump under the finger. */
export class AquariumSlider extends LitElement {
  static properties = {
    label: { type: String },
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    unit: { type: String },
    fill: { type: String },
    disabled: { type: Boolean, reflect: true },
    dot: { type: String },
    icon: { type: String },
    hint: { type: String },
  };

  declare label: string;
  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare unit: string;
  declare fill: string;
  declare disabled: boolean;
  /** Colour swatch shown beside the label (a channel colour), or empty. */
  declare dot: string;
  /** Icon shown instead of the label text (which stays as the accessible name), or empty. */
  declare icon: IconName | "";
  /** Extra description announced with the value (`aria-description`), or empty. */
  declare hint: string;

  private _pointerActive = false;

  constructor() {
    super();
    this.label = "";
    this.value = 0;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.unit = "%";
    this.fill = "";
    this.disabled = false;
    this.dot = "";
    this.icon = "";
    this.hint = "";
  }

  private get _input(): HTMLInputElement | null {
    return this.renderRoot.querySelector("input");
  }

  protected updated(changed: PropertyValues<this>): void {
    const input = this._input;
    if (!input) return;
    if (!this._pointerActive && input.value !== String(this.value)) input.value = String(this.value);
    if (changed.size > 0) this._paint(this._pointerActive ? Number(input.value) : this.value);
  }

  private _paint(value: number): void {
    const span = this.max - this.min;
    const percent = span > 0 ? Math.min(100, Math.max(0, ((value - this.min) / span) * 100)) : 0;
    this.style.setProperty("--pct", `${percent}%`);
  }

  private _onInput = (event: Event): void => {
    const value = Number((event.target as HTMLInputElement).value);
    this._paint(value);
    this._emit("slider-input", value);
  };

  private _onChange = (event: Event): void => {
    this._emit("slider-change", Number((event.target as HTMLInputElement).value));
  };

  private _emit(name: string, value: number): void {
    this.dispatchEvent(new CustomEvent<SliderDetail>(name, { detail: { value }, bubbles: true, composed: true }));
  }

  private _release = (): void => {
    if (!this._pointerActive) return;
    this._pointerActive = false;
    window.removeEventListener("pointerup", this._release);
    window.removeEventListener("pointercancel", this._release);
    this.requestUpdate();
  };

  private _onPointerDown = (): void => {
    this._pointerActive = true;
    window.addEventListener("pointerup", this._release);
    window.addEventListener("pointercancel", this._release);
  };

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("pointerup", this._release);
    window.removeEventListener("pointercancel", this._release);
  }

  render() {
    const shown = `${Math.round(this.value)}${this.unit}`;
    return html`<label class="row">
      <span class="name">${this.icon ? icon(this.icon) : this.dot ? html`<span class="dot" style="background:${this.dot}" aria-hidden="true"></span>` : nothing}<span class=${this.icon ? "sr-only" : "text"}>${this.label}</span></span>
      <span class="track-box" style=${this.fill ? `--fill:${this.fill}` : nothing}>
        <input type="range" min=${this.min} max=${this.max} step=${this.step} ?disabled=${this.disabled} aria-valuetext=${shown} aria-description=${this.hint || nothing} @input=${this._onInput} @change=${this._onChange} @pointerdown=${this._onPointerDown} />
      </span>
      <output class="value">${shown}</output>
    </label>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; --fill: var(--lu-accent); --pct: 0%; }
      .row { display: grid; grid-template-columns: var(--aquarium-slider-label, 72px) minmax(0, 1fr) 44px; align-items: center; column-gap: var(--lu-space-2); min-height: var(--lu-target); color: var(--lu-ink); font: 500 var(--lu-type-label)/1.2 var(--lu-font); }
      .name { display: flex; align-items: center; gap: var(--lu-space-2); min-width: 0; }
      .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .name .icon { flex: none; font-size: 24px; color: var(--lu-ink-2); }
      .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 1px color-mix(in srgb, var(--lu-ink) 28%, transparent); }
      .value { color: var(--lu-ink-2); text-align: right; font-variant-numeric: tabular-nums; }
      .track-box { display: block; min-width: 0; }
      input { display: block; width: 100%; height: var(--lu-target); margin: 0; padding: 0; background: transparent; cursor: pointer; touch-action: pan-y; -webkit-appearance: none; appearance: none; }
      input:disabled { cursor: default; opacity: var(--lu-disabled-opacity); }
      input:focus-visible { outline: 2px solid transparent; background-image: none; box-shadow: none; }
      input::-webkit-slider-runnable-track { height: 8px; border-radius: var(--lu-radius-pill); background: linear-gradient(to right, var(--fill) 0 var(--pct), var(--lu-track-off) var(--pct) 100%); box-shadow: var(--lu-inset), 0 0 0 1px var(--lu-well-edge); }
      input::-moz-range-track { height: 8px; border-radius: var(--lu-radius-pill); background: var(--lu-track-off); box-shadow: var(--lu-inset), 0 0 0 1px var(--lu-well-edge); }
      input::-moz-range-progress { height: 8px; border-radius: var(--lu-radius-pill); background: var(--fill); }
      input::-webkit-slider-thumb { -webkit-appearance: none; width: 24px; height: 24px; margin-top: -8px; border: 2px solid var(--lu-ink); border-radius: 50%; background: var(--lu-card); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); transition: transform var(--lu-motion-press) var(--lu-ease-press); }
      input::-moz-range-thumb { width: 20px; height: 20px; border: 2px solid var(--lu-ink); border-radius: 50%; background: var(--lu-card); box-shadow: var(--lu-shadow-raised); }
      input:active::-webkit-slider-thumb { transform: scale(1.08); }
      input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 6px var(--lu-focus-wash), var(--lu-shadow-raised); }
      input:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 6px var(--lu-focus-wash), var(--lu-shadow-raised); }
      @media (prefers-reduced-motion: reduce) { input::-webkit-slider-thumb { transition: none; } }
    `,
  ];
}

customElements.define("aquarium-slider", AquariumSlider);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-slider": AquariumSlider;
  }
}

import { LitElement, css, html, nothing } from "lit";
import { icon } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

/** A switch row: the label (and an optional hint) on the left, the switch on the right, and the
 * whole 48 px row is the control. State is shown by the knob's position and a check mark as well
 * as by colour. Emits `lu-change` with `{checked}` (the new state); it does not flip itself, so
 * whoever owns the state stays in charge. */
export class LuSwitch extends LitElement {
  static properties = {
    label: { type: String },
    hint: { type: String },
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
  };

  declare label: string;
  declare hint: string;
  declare checked: boolean;
  declare disabled: boolean;

  constructor() {
    super();
    this.label = "";
    this.hint = "";
    this.checked = false;
    this.disabled = false;
  }

  render() {
    return html`<button type="button" class="row" role="switch" aria-checked=${this.checked ? "true" : "false"} aria-describedby=${this.hint ? "hint" : nothing} ?disabled=${this.disabled} @click=${this._toggle}>
      <span class="copy">
        <span class="label">${this.label}</span>
        ${this.hint ? html`<span class="hint" id="hint">${this.hint}</span>` : nothing}
      </span>
      <span class="track" aria-hidden="true"><span class="knob">${icon("check")}</span></span>
    </button>`;
  }

  private _toggle(): void {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent("lu-change", { detail: { checked: !this.checked }, bubbles: true, composed: true }));
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: var(--lu-space-3); width: 100%; min-height: var(--lu-target); padding: var(--lu-space-1) 0; border: 0; border-radius: var(--lu-radius-control); background-color: transparent; color: var(--lu-ink); text-align: left; cursor: pointer; }
      .row:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }
      .copy { display: grid; gap: 2px; min-width: 0; }
      .label { font: 500 var(--lu-type-label)/1.3 var(--lu-font); overflow-wrap: anywhere; }
      .hint { color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.35 var(--lu-font); overflow-wrap: anywhere; }
      .track { position: relative; flex: none; width: 48px; height: 28px; border-radius: var(--lu-radius-pill); background-color: var(--lu-track-off); box-shadow: var(--lu-inset), 0 0 0 1px var(--lu-well-edge); transition: background-color var(--lu-motion-focus) var(--lu-ease); }
      .knob { position: absolute; left: 2px; top: 2px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--lu-card); color: transparent; font-size: 16px; box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised), 0 0 0 1px var(--lu-edge-raised); transition: transform var(--lu-motion-focus) var(--lu-ease), color var(--lu-motion-focus) var(--lu-ease); }
      .row[aria-checked="true"] .track { background-color: var(--lu-accent); }
      .row[aria-checked="true"] .knob { transform: translateX(20px); color: var(--lu-accent); }
      @media (prefers-reduced-motion: reduce) { .track, .knob { transition: none; } }
      @media (forced-colors: active) { .track { border: 1px solid ButtonText; } .row[aria-checked="true"] .track { background-color: Highlight; } }
    `,
  ];
}

customElements.define("aq-switch", LuSwitch);

declare global {
  interface HTMLElementTagNameMap {
    "aq-switch": LuSwitch;
  }
}

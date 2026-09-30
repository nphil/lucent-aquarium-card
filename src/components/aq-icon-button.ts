import { LitElement, css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { icon, type IconName } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

/** A 48 px icon-only button. `label` is its accessible name (and tooltip); `pressed` makes it a
 * toggle. Emits `lu-press`. */
export class LuIconButton extends LitElement {
  static properties = {
    icon: { type: String },
    label: { type: String },
    pressed: { type: Boolean },
    toggle: { type: Boolean },
    disabled: { type: Boolean, reflect: true },
    tone: { type: String, reflect: true },
  };

  declare icon: IconName;
  declare label: string;
  declare pressed: boolean;
  declare toggle: boolean;
  declare disabled: boolean;
  /** `plain` (default) or `raised` (a small isolated control that earns a lifted surface). */
  declare tone: "plain" | "raised";

  constructor() {
    super();
    this.icon = "close";
    this.label = "";
    this.pressed = false;
    this.toggle = false;
    this.disabled = false;
    this.tone = "plain";
  }

  render() {
    return html`<button type="button" class="button" aria-label=${this.label} title=${this.label} aria-pressed=${ifDefined(this.toggle ? String(this.pressed) : undefined)} ?disabled=${this.disabled} @click=${this._press}>
      ${icon(this.icon)}
    </button>`;
  }

  private _press(): void {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent("lu-press", { bubbles: true, composed: true }));
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: inline-flex; flex: none; }
      .button { display: inline-grid; place-items: center; width: var(--lu-target); height: var(--lu-target); padding: 0; border: 1px solid transparent; border-radius: var(--lu-radius-pill); color: var(--lu-ink); background-color: transparent; font-size: 24px; cursor: pointer; transition: transform var(--lu-motion-press) var(--lu-ease-press), background-color var(--lu-motion-focus) var(--lu-ease); }
      :host([tone="raised"]) .button { background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
      .button:hover:not(:disabled) { background-color: var(--lu-hover-wash); }
      .button[aria-pressed="true"] { background-color: var(--lu-selected-wash); color: var(--lu-accent); }
      .button:active:not(:disabled) { transform: scale(var(--lu-scale-pressed)); }
      .button:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }
      .icon { display: block; }
    `,
  ];
}

customElements.define("aq-icon-button", LuIconButton);

declare global {
  interface HTMLElementTagNameMap {
    "aq-icon-button": LuIconButton;
  }
}

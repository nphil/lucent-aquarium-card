import { LitElement, css, html, nothing } from "lit";
import { icon, type IconName } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

export type LuPillVariant = "primary" | "secondary" | "quiet" | "danger";

/** A short standalone action. One `primary` per surface. `loading` swaps the icon for a spinner
 * and blocks presses while keeping the label, so the outcome is still readable. Emits `lu-press`. */
export class LuPillButton extends LitElement {
  static properties = {
    label: { type: String },
    icon: { type: String },
    variant: { type: String, reflect: true },
    loading: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    grow: { type: Boolean, reflect: true },
  };

  declare label: string;
  declare icon: IconName | "";
  declare variant: LuPillVariant;
  declare loading: boolean;
  declare disabled: boolean;
  /** Fill the available width. */
  declare grow: boolean;

  constructor() {
    super();
    this.label = "";
    this.icon = "";
    this.variant = "secondary";
    this.loading = false;
    this.disabled = false;
    this.grow = false;
  }

  render() {
    return html`<button type="button" class="button ${this.variant}" aria-busy=${this.loading ? "true" : "false"} ?disabled=${this.disabled} @click=${this._press}>
      ${this.loading ? html`<span class="spinner" aria-hidden="true"></span>` : this.icon ? icon(this.icon) : nothing}
      <span class="label">${this.label}</span>
    </button>`;
  }

  private _press(): void {
    if (this.disabled || this.loading) return;
    this.dispatchEvent(new CustomEvent("lu-press", { bubbles: true, composed: true }));
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: inline-flex; min-width: 0; }
      :host([grow]) { display: flex; flex: 1 1 auto; }
      .button { display: inline-flex; justify-content: center; align-items: center; gap: var(--lu-space-2); width: 100%; min-width: var(--lu-target); min-height: var(--lu-target); padding: 0 var(--lu-space-5); border: 1px solid transparent; border-radius: var(--lu-radius-pill); font: 600 var(--lu-type-label)/1.2 var(--lu-font); cursor: pointer; transition: transform var(--lu-motion-press) var(--lu-ease-press), background-color var(--lu-motion-label) var(--lu-ease); }
      .button:active:not(:disabled) { transform: scale(var(--lu-scale-pressed)); }
      .primary { color: var(--lu-accent-ink); background-color: var(--lu-accent); }
      .primary:focus-visible { box-shadow: inset 0 -3px 0 0 var(--lu-accent-ink); background-image: linear-gradient(color-mix(in srgb, var(--lu-accent-ink) 14%, transparent), color-mix(in srgb, var(--lu-accent-ink) 14%, transparent)); }
      .secondary { color: var(--lu-ink); background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised); }
      .quiet { color: var(--lu-ink-2); background-color: transparent; border-color: var(--lu-edge); }
      .danger { color: var(--lu-danger); background-color: var(--lu-glass-raised); border-color: color-mix(in srgb, var(--lu-danger) 40%, var(--lu-edge)); }
      .button:hover:not(:disabled):not(.primary) { background-color: color-mix(in srgb, var(--lu-ink) 14%, transparent); }
      .button:disabled { opacity: var(--lu-disabled-opacity); cursor: default; box-shadow: none; }
      .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icon { flex: none; font-size: 20px; }
      .spinner { flex: none; width: 16px; height: 16px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; }
      @media (prefers-reduced-motion: no-preference) { .spinner { animation: spin 0.9s linear infinite; } }
      @keyframes spin { to { transform: rotate(360deg); } }
    `,
  ];
}

customElements.define("aq-pill-button", LuPillButton);

declare global {
  interface HTMLElementTagNameMap {
    "aq-pill-button": LuPillButton;
  }
}

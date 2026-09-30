import { LitElement, css, html, nothing } from "lit";
import { icon, type IconName } from "../lib/icons.ts";
import { TOKENS_CSS } from "../styles/tokens.ts";

export type LuChipKind = "positive" | "warning" | "danger" | "info" | "neutral";

/** A passive status badge: an icon or dot plus a short text, so the state never rests on colour
 * alone. Not focusable and not a control (Lucent: passive badges are not targets). */
export class LuChip extends LitElement {
  static properties = {
    label: { type: String },
    kind: { type: String, reflect: true },
    icon: { type: String },
    dot: { type: Boolean },
  };

  declare label: string;
  declare kind: LuChipKind;
  declare icon: IconName | "";
  declare dot: boolean;

  constructor() {
    super();
    this.label = "";
    this.kind = "neutral";
    this.icon = "";
    this.dot = false;
  }

  render() {
    return html`<span class="chip">${this.icon ? icon(this.icon) : this.dot ? html`<span class="dot" aria-hidden="true"></span>` : nothing}<span class="text">${this.label}</span></span>`;
  }

  static styles = [
    TOKENS_CSS,
    css`
      :host { display: inline-flex; min-width: 0; max-width: 100%; }
      .chip { display: inline-flex; align-items: center; gap: var(--lu-space-1); min-width: 0; height: 28px; padding: 0 var(--lu-space-3) 0 var(--lu-space-2); color: var(--lu-ink); background: color-mix(in srgb, var(--lu-card) 82%, transparent); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); font: 500 var(--lu-type-caption)/1 var(--lu-font); white-space: nowrap; }
      .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .icon { flex: none; font-size: 16px; color: var(--lu-ink-2); }
      .dot { flex: none; width: 8px; height: 8px; margin: 0 var(--lu-space-1); border-radius: 50%; background: var(--lu-ink-3); }
      :host([kind="positive"]) .dot, :host([kind="positive"]) .icon { color: var(--lu-positive); background-color: transparent; }
      :host([kind="positive"]) .dot { background: var(--lu-positive); }
      :host([kind="warning"]) .icon { color: var(--lu-warning); }
      :host([kind="warning"]) .dot { background: var(--lu-warning); }
      :host([kind="danger"]) .icon { color: var(--lu-danger); }
      :host([kind="danger"]) .dot { background: var(--lu-danger); }
      :host([kind="info"]) .icon { color: var(--lu-info); }
      :host([kind="info"]) .dot { background: var(--lu-info); }
    `,
  ];
}

customElements.define("aq-chip", LuChip);

declare global {
  interface HTMLElementTagNameMap {
    "aq-chip": LuChip;
  }
}

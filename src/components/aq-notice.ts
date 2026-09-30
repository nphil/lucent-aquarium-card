import { LitElement, css, html, nothing } from "lit";
import { icon, type IconName } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./aq-pill-button.ts";

export type LuNoticeKind = "info" | "warning" | "error";

/** An honest state: what is wrong (or empty), why, and one useful next step. It keeps the
 * surrounding layout in place instead of collapsing it. `role="alert"` for errors, `status`
 * otherwise. Emits `notice-action` when its button is pressed. */
export class LuNotice extends LitElement {
  static properties = {
    kind: { type: String, reflect: true },
    heading: { type: String },
    message: { type: String },
    actionLabel: { type: String, attribute: "action-label" },
    actionIcon: { type: String, attribute: "action-icon" },
    busy: { type: Boolean },
    compact: { type: Boolean, reflect: true },
  };

  declare kind: LuNoticeKind;
  declare heading: string;
  declare message: string;
  declare actionLabel: string;
  declare actionIcon: IconName | "";
  declare busy: boolean;
  declare compact: boolean;

  constructor() {
    super();
    this.kind = "info";
    this.heading = "";
    this.message = "";
    this.actionLabel = "";
    this.actionIcon = "";
    this.busy = false;
    this.compact = false;
  }

  render() {
    const glyph: IconName = this.kind === "info" ? "info" : "alert";
    return html`<div class="notice" role=${this.kind === "error" ? "alert" : "status"}>
      <span class="glyph">${icon(glyph)}</span>
      <div class="copy">
        ${this.heading ? html`<p class="heading">${this.heading}</p>` : nothing}
        ${this.message ? html`<p class="message">${this.message}</p>` : nothing}
      </div>
      ${this.actionLabel ? html`<aq-pill-button variant="secondary" .label=${this.actionLabel} .icon=${this.actionIcon} ?loading=${this.busy} @lu-press=${this._act}></aq-pill-button>` : nothing}
    </div>`;
  }

  private _act(event: Event): void {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("notice-action", { bubbles: true, composed: true }));
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; container-type: inline-size; }
      .notice { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: var(--lu-space-3); row-gap: var(--lu-space-2); padding: var(--lu-space-3) var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); color: var(--lu-ink); }
      :host([kind="warning"]) .notice { border-color: color-mix(in srgb, var(--lu-warning) 45%, var(--lu-edge)); }
      :host([kind="error"]) .notice { border-color: color-mix(in srgb, var(--lu-danger) 45%, var(--lu-edge)); }
      .glyph { grid-column: 1; align-self: start; display: grid; font-size: 24px; color: var(--lu-info); }
      :host([kind="warning"]) .glyph { color: var(--lu-warning); }
      :host([kind="error"]) .glyph { color: var(--lu-danger); }
      .copy { grid-column: 2; min-width: 0; }
      aq-pill-button { grid-column: 3; }
      p { margin: 0; }
      .heading { font: 600 var(--lu-type-label)/1.3 var(--lu-font); }
      .message { color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); overflow-wrap: anywhere; }
      .heading + .message { margin-top: var(--lu-space-1); }
      :host([compact]) .notice { padding: var(--lu-space-2) var(--lu-space-3); }
      @container (max-width: 420px) { aq-pill-button { grid-column: 2 / -1; justify-self: start; } }
    `,
  ];
}

customElements.define("aq-notice", LuNotice);

declare global {
  interface HTMLElementTagNameMap {
    "aq-notice": LuNotice;
  }
}

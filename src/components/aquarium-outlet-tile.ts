import { LitElement, css, html, nothing } from "lit";
import type { StatusTone } from "../lib/equipment.ts";
import { icon, type IconName } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

/** One switched outlet as a tile: what is plugged in, whether it is on, what it is doing and what
 * it draws. The whole tile is the switch (48 px and far more). It reports the press with
 * `outlet-press` and changes nothing itself: the card decides whether to switch at once, ask for
 * a hold first, or explain why it cannot.
 *
 * State is never colour alone: the tile is raised and its badge lit when on, the status is a
 * word, and the switch role carries on/off for assistive technology. */
export class AquariumOutletTile extends LitElement {
  static properties = {
    icon: { type: String },
    name: { type: String },
    on: { type: Boolean, reflect: true },
    unavailable: { type: Boolean, reflect: true },
    pending: { type: String, reflect: true },
    statusLabel: { type: String, attribute: "status-label" },
    statusTone: { type: String, attribute: "status-tone" },
    detail: { type: String },
    watts: { type: String },
    note: { type: String },
    noteTone: { type: String, attribute: "note-tone" },
  };

  declare icon: IconName;
  declare name: string;
  declare on: boolean;
  declare unavailable: boolean;
  /** The target state while a switch command is on its way ("on" / "off"), else empty. */
  declare pending: "on" | "off" | "";
  declare statusLabel: string;
  declare statusTone: StatusTone;
  /** A plainer second line for the status ("On, drawing no power."), read out but not drawn. */
  declare detail: string;
  /** What it draws now, already formatted ("6.8 W"), or empty. */
  declare watts: string;
  /** An extra line under the numbers (the CO2 guard). */
  declare note: string;
  declare noteTone: "neutral" | "warning";

  constructor() {
    super();
    this.icon = "powerSocket";
    this.name = "";
    this.on = false;
    this.unavailable = false;
    this.pending = "";
    this.statusLabel = "";
    this.statusTone = "neutral";
    this.detail = "";
    this.watts = "";
    this.note = "";
    this.noteTone = "neutral";
  }

  private _press(): void {
    this.dispatchEvent(new CustomEvent("outlet-press", { bubbles: true, composed: true }));
  }

  render() {
    const busy = this.pending !== "";
    const status = busy ? `Switching ${this.pending}…` : this.statusLabel;
    const description = [status, this.watts, this.detail, this.note].filter((part) => part !== "").join(". ");
    return html`<button type="button" class="tile" role="switch" aria-checked=${this.on ? "true" : "false"} aria-disabled=${this.unavailable ? "true" : "false"} aria-busy=${busy ? "true" : "false"} aria-label=${this.name} aria-describedby="description" @click=${this._press}>
      <span class="top">
        <span class="badge" aria-hidden="true">${busy ? html`<span class="spinner"></span>` : icon(this.icon)}</span>
        <span class="status" data-tone=${busy ? "neutral" : this.statusTone}><i class="dot"></i><span class="status-text">${status}</span></span>
      </span>
      <span class="name">${this.name}</span>
      <span class="meta">
        ${this.watts ? html`<span class="watts">${this.watts}</span>` : nothing}
        ${this.note ? html`<span class="note" data-tone=${this.noteTone}>${this.noteTone === "warning" ? icon("alert") : nothing}<span>${this.note}</span></span>` : nothing}
      </span>
      <span class="sr-only" id="description">${description}</span>
    </button>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; }
      .tile { display: grid; grid-template-rows: auto auto 1fr; align-content: start; gap: var(--lu-space-2); width: 100%; height: 100%; min-height: 124px; padding: var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); background-color: var(--lu-tile); color: var(--lu-ink); text-align: left; cursor: pointer; transition: background-color var(--lu-motion-card) var(--lu-ease), transform var(--lu-motion-press) var(--lu-ease-press); }
      .tile:hover { background-color: var(--lu-selected-wash); }
      .tile:active { transform: scale(var(--lu-scale-pressed)); }
      :host([on]) .tile { background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
      :host([unavailable]) .tile { border-style: dashed; cursor: default; }
      :host([unavailable]) .tile:active { transform: none; }

      .top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--lu-space-1) var(--lu-space-2); min-width: 0; }
      .badge { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 50%; background-color: var(--lu-well); color: var(--lu-ink-2); font-size: 24px; }
      :host([on]) .badge { background-color: var(--lu-accent-soft); color: var(--lu-accent); }
      :host([unavailable]) .badge { color: var(--lu-ink-3); }
      .spinner { width: 18px; height: 18px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; }
      @media (prefers-reduced-motion: no-preference) { .spinner { animation: spin 0.9s linear infinite; } }
      @keyframes spin { to { transform: rotate(360deg); } }

      .status { display: inline-flex; align-items: flex-start; gap: 6px; max-width: 100%; padding-top: 2px; color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1.3 var(--lu-font); }
      .status-text { min-width: 0; overflow-wrap: break-word; }
      .dot { flex: none; width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background-color: var(--lu-ink-3); }
      .status[data-tone="positive"] .dot { background-color: var(--lu-positive); }
      .status[data-tone="warning"] .dot { background-color: var(--lu-warning); }
      .status[data-tone="danger"] .dot { background-color: var(--lu-danger); }
      .status[data-tone="positive"], .status[data-tone="warning"], .status[data-tone="danger"] { color: var(--lu-ink); }

      .name { min-width: 0; font: 600 var(--lu-type-body)/1.25 var(--lu-font); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .meta { display: grid; align-content: start; gap: var(--lu-space-1); min-width: 0; }
      .watts { font: 600 var(--lu-type-title)/1.2 var(--lu-font); font-variant-numeric: tabular-nums; }
      .note { display: flex; align-items: flex-start; gap: var(--lu-space-1); color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.35 var(--lu-font); overflow-wrap: anywhere; }
      .note .icon { flex: none; margin-top: 1px; font-size: 14px; color: var(--lu-warning); }
      .note[data-tone="warning"] { color: var(--lu-ink); }
      @media (prefers-reduced-motion: reduce) { .tile { transition: none; } }
      @media (forced-colors: active) { .tile { border-color: ButtonText; } :host([on]) .badge { forced-color-adjust: none; background-color: Highlight; color: HighlightText; } }
    `,
  ];
}

customElements.define("aquarium-outlet-tile", AquariumOutletTile);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-outlet-tile": AquariumOutletTile;
  }
}

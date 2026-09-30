import { LitElement, css, html, nothing } from "lit";
import { icon, type IconName } from "../lib/icons.ts";
import { STRIP_CSS } from "../styles/schedule.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./aq-pill-button.ts";
import "./aquarium-hold-button.ts";

/** The lock in front of something that changes real equipment: a one-line consequence and a
 * press-and-hold button. Holding confirms. For people who cannot hold (Lucent: the hold is a
 * shortcut, never the only way), a quick tap turns the button into an ordinary Cancel / Confirm
 * choice. Either way it emits one `confirmed` event and nothing else; the owner does the work
 * and sets `busy` while it runs. */
export class AquariumConfirmAction extends LitElement {
  static properties = {
    label: { type: String },
    completeLabel: { type: String, attribute: "complete-label" },
    confirmLabel: { type: String, attribute: "confirm-label" },
    icon: { type: String },
    tone: { type: String, reflect: true },
    consequence: { type: String },
    busy: { type: Boolean },
    disabled: { type: Boolean },
    _asking: { state: true },
  };

  declare label: string;
  declare completeLabel: string;
  /** Label of the button in the tap alternative ("Switch now"). */
  declare confirmLabel: string;
  declare icon: IconName;
  declare tone: "neutral" | "danger";
  /** What will happen, in one line. */
  declare consequence: string;
  declare busy: boolean;
  declare disabled: boolean;
  declare _asking: boolean;

  constructor() {
    super();
    this.label = "Hold to confirm";
    this.completeLabel = "Done";
    this.confirmLabel = "Confirm";
    this.icon = "check";
    this.tone = "neutral";
    this.consequence = "";
    this.busy = false;
    this.disabled = false;
    this._asking = false;
  }

  protected willUpdate(): void {
    if ((this.disabled || this.busy) && this._asking) this._asking = false;
  }

  private _ask = (event: Event): void => {
    event.stopPropagation();
    if (this.disabled || this.busy) return;
    this._asking = true;
    void this.updateComplete.then(() => this.renderRoot.querySelector("aq-pill-button")?.shadowRoot?.querySelector<HTMLElement>("button")?.focus());
  };

  private _confirm = (event?: Event): void => {
    event?.stopPropagation();
    this._asking = false;
    this.dispatchEvent(new CustomEvent("confirmed", { bubbles: true, composed: true }));
  };

  private _cancel = (): void => {
    this._asking = false;
  };

  private _onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this._asking) return;
    event.preventDefault();
    event.stopPropagation();
    this._cancel();
  };

  render() {
    const danger = this.tone === "danger";
    if (this._asking) {
      return html`<div class="strip" role="group" aria-label="Confirm" @keydown=${this._onKey}>
        <span class="strip-text">${this.consequence || this.label}</span>
        <div class="strip-actions">
          <aq-pill-button variant="secondary" label="Cancel" @lu-press=${this._cancel}></aq-pill-button>
          <aq-pill-button variant=${danger ? "danger" : "primary"} .label=${this.confirmLabel} @lu-press=${this._confirm}></aq-pill-button>
        </div>
      </div>`;
    }
    return html`<div class="confirm">
      ${this.consequence ? html`<p class="consequence">${icon(danger ? "alert" : "info")}<span>${this.consequence}</span></p>` : nothing}
      <aquarium-hold-button .label=${this.label} .completeLabel=${this.completeLabel} .icon=${this.icon} .tone=${this.tone} ?disabled=${this.disabled} ?busy=${this.busy} @confirmed=${this._confirm} @tap-confirm=${this._ask}></aquarium-hold-button>
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    STRIP_CSS,
    css`
      :host { display: block; min-width: 0; }
      .confirm { display: grid; gap: var(--lu-space-2); }
      .consequence { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .consequence .icon { flex: none; margin-top: 1px; font-size: 18px; color: var(--lu-ink-2); }
      :host([tone="danger"]) .consequence .icon { color: var(--lu-danger); }
    `,
  ];
}

customElements.define("aquarium-confirm-action", AquariumConfirmAction);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-confirm-action": AquariumConfirmAction;
  }
}

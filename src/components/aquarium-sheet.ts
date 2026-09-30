import { LitElement, css, html, type PropertyValues } from "lit";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./lu-icon-button.ts";

function deepestActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/** A modal sheet: a bottom sheet on phones, a centred dialog from 640 px.
 *
 * Built on the native `<dialog>` and `showModal()`, so it renders in the browser's TOP LAYER:
 * glass host themes put `backdrop-filter` on `ha-card`, which would trap a `position: fixed`
 * overlay inside the card. The background becomes inert and Escape / focus return come from the
 * platform. `close-request` (cancelable) fires before any close, so an editor can refuse to
 * lose unsaved work; `closed` fires after.
 *
 * Slots: `header` (title), `actions` (extra header buttons), default (scrolling body), `footer`. */
export class AquariumSheet extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    label: { type: String },
    closeOnScrim: { type: Boolean, attribute: "close-on-scrim" },
  };

  declare open: boolean;
  declare label: string;
  declare closeOnScrim: boolean;

  private _opener: HTMLElement | null = null;

  constructor() {
    super();
    this.open = false;
    this.label = "Dialog";
    this.closeOnScrim = true;
  }

  private get _dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector("dialog");
  }

  protected updated(changed: PropertyValues<this>): void {
    if (!changed.has("open")) return;
    const dialog = this._dialog;
    if (!dialog) return;
    if (this.open && !dialog.open) {
      this._opener = deepestActiveElement();
      dialog.showModal();
      this.dispatchEvent(new CustomEvent("opened", { bubbles: true, composed: true }));
    } else if (!this.open && dialog.open) {
      dialog.close();
      this._opener?.focus();
      this._opener = null;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._dialog?.open) this._dialog.close();
  }

  /** Ask to close. Listeners may `preventDefault()` on `close-request` to keep it open. */
  requestClose(): void {
    if (!this.open) return;
    const allowed = this.dispatchEvent(new CustomEvent("close-request", { bubbles: true, composed: true, cancelable: true }));
    if (allowed) this.close();
  }

  /** Close without asking. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
  }

  private _onCancel = (event: Event): void => {
    event.preventDefault();
    this.requestClose();
  };

  private _onDialogClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget && this.closeOnScrim) this.requestClose();
  };

  private _onNativeClose = (): void => {
    // The platform closed it (e.g. form method dialog): keep our state truthful. The event is queued
    // and can arrive after the sheet was opened again; a dialog that is open now is not closed.
    if (this.open && !this._dialog?.open) this.close();
  };

  render() {
    return html`<dialog aria-label=${this.label} @cancel=${this._onCancel} @click=${this._onDialogClick} @close=${this._onNativeClose}>
      <div class="panel">
        <header class="header">
          <div class="title"><slot name="header"></slot></div>
          <slot name="actions"></slot>
          <lu-icon-button icon="close" label="Close" @lu-press=${this.requestClose}></lu-icon-button>
        </header>
        <div class="body"><slot></slot></div>
        <footer class="footer"><slot name="footer"></slot></footer>
      </div>
    </dialog>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: contents; }
      dialog { position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; overflow: visible; background: transparent; color: var(--lu-ink); font-family: var(--lu-font); }
      dialog:not([open]) { display: none; }
      dialog[open] { display: flex; align-items: flex-end; justify-content: center; }
      dialog::backdrop { background: var(--lu-scrim); }
      .panel { display: flex; flex-direction: column; width: 100%; max-height: min(94dvh, 960px); overflow: hidden; background: linear-gradient(var(--lu-card), var(--lu-card)), var(--lu-canvas); border: 1px solid var(--lu-edge); border-bottom: 0; border-radius: var(--lu-radius-sheet) var(--lu-radius-sheet) 0 0; box-shadow: var(--lu-highlight-rest), var(--lu-shadow-overlay); }
      dialog[open] .panel { animation: sheet-in var(--lu-motion-layer) var(--lu-ease) both; }
      dialog[open]::backdrop { animation: fade-in var(--lu-motion-layer) var(--lu-ease) both; }
      .header { display: flex; align-items: center; gap: var(--lu-space-1); padding: var(--lu-space-3) var(--lu-space-2) var(--lu-space-2) var(--lu-space-5); }
      .title { flex: 1 1 auto; min-width: 0; }
      .body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 var(--lu-space-5) var(--lu-space-4); }
      .footer { padding: var(--lu-space-3) var(--lu-space-5) calc(var(--lu-space-4) + env(safe-area-inset-bottom)); border-top: 1px solid var(--lu-edge); }
      .footer:not(:has(::slotted(*))) { display: none; }
      @media (min-width: 640px) {
        dialog[open] { align-items: center; padding: var(--lu-space-6); }
        .panel { width: min(100%, 720px); max-height: min(90dvh, 900px); border-bottom: 1px solid var(--lu-edge); border-radius: var(--lu-radius-sheet); }
      }
      @keyframes sheet-in { from { opacity: 0; transform: translateY(var(--lu-travel-layer)); } }
      @keyframes fade-in { from { opacity: 0; } }
    `,
  ];
}

customElements.define("aquarium-sheet", AquariumSheet);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-sheet": AquariumSheet;
  }
}

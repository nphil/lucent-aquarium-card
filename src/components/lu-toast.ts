import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { icon } from "../lib/icons.ts";
import { realScheduler } from "../lib/throttle.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

export interface ToastRequest {
  message: string;
  kind?: "info" | "error";
  actionLabel?: string;
  action?: () => void;
  /** Milliseconds on screen. Default 5000 (8000 for errors); 0 keeps it until dismissed. */
  timeoutMs?: number;
}

const SUPPORTS_POPOVER = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

/** One toast at a time, queued. It shows in the top layer (a popover) so it is visible above the
 * card's own sheet and immune to glass-theme `backdrop-filter` containment on ancestors; older
 * browsers get a plain fixed element. The message is also mirrored into a polite live region
 * that is always in the DOM, because inserting text into a freshly shown popover is announced
 * unreliably. Timers pause while the pointer or focus is on the toast. */
export class LuToast extends LitElement {
  static properties = {
    _current: { state: true },
    _queue: { state: true },
    _announce: { state: true },
  };

  declare _current: ToastRequest | null;
  declare _queue: ToastRequest[];
  declare _announce: string;

  private _timer: unknown = null;
  private _paused = false;

  constructor() {
    super();
    this._current = null;
    this._queue = [];
    this._announce = "";
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clearTimer();
  }

  enqueue(request: ToastRequest): void {
    if (!request.message) return;
    if (!this._current) this._show(request);
    else this._queue = [...this._queue, request];
  }

  private _show(request: ToastRequest): void {
    this._current = request;
    this._announce = request.message;
    this._arm(request.timeoutMs ?? (request.kind === "error" ? 8000 : 5000));
  }

  private _arm(ms: number): void {
    this._clearTimer();
    if (ms > 0) this._timer = realScheduler.setTimeout(() => (this._paused ? this._arm(1500) : this._dismiss()), ms);
  }

  private _clearTimer(): void {
    if (this._timer !== null) realScheduler.clearTimeout(this._timer);
    this._timer = null;
  }

  private _dismiss = (): void => {
    this._clearTimer();
    this._current = null;
    this._announce = "";
    const [next, ...rest] = this._queue;
    this._queue = rest;
    if (next) this._show(next);
  };

  private _runAction = (): void => {
    const action = this._current?.action;
    this._dismiss();
    action?.();
  };

  protected updated(changed: PropertyValues<this>): void {
    if (!changed.has("_current") || !SUPPORTS_POPOVER) return;
    const toast = this.renderRoot.querySelector<HTMLElement>(".toast");
    if (!toast) return;
    if (this._current && !toast.matches(":popover-open")) toast.showPopover();
  }

  render() {
    const current = this._current;
    return html`<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">${this._announce}</div>
      ${current
        ? html`<div class="toast ${current.kind ?? "info"}" popover=${SUPPORTS_POPOVER ? "manual" : nothing} @pointerenter=${() => (this._paused = true)} @pointerleave=${() => (this._paused = false)} @focusin=${() => (this._paused = true)} @focusout=${() => (this._paused = false)}>
            ${current.kind === "error" ? icon("alert") : nothing}
            <span class="message">${current.message}</span>
            ${current.actionLabel && current.action ? html`<button type="button" class="action" @click=${this._runAction}>${current.actionLabel}</button>` : nothing}
            <button type="button" class="dismiss" aria-label="Dismiss" @click=${this._dismiss}>${icon("close")}</button>
          </div>`
        : nothing}`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: contents; }
      .toast { position: fixed; inset: auto auto calc(var(--lu-space-4) + env(safe-area-inset-bottom)) 50%; transform: translateX(-50%); margin: 0; display: flex; align-items: center; gap: var(--lu-space-2); width: max-content; max-width: min(560px, calc(100vw - 32px)); padding: var(--lu-space-1) var(--lu-space-1) var(--lu-space-1) var(--lu-space-4); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: linear-gradient(var(--lu-card), var(--lu-card)), var(--lu-canvas); box-shadow: var(--lu-highlight-rest), var(--lu-shadow-overlay); font: 500 var(--lu-type-label)/1.35 var(--lu-font); animation: toast-in var(--lu-motion-layer) var(--lu-ease) both; }
      .toast[popover]:not(:popover-open) { display: none; }
      .toast.error .icon { color: var(--lu-danger); font-size: 20px; flex: none; }
      .message { min-width: 0; overflow-wrap: anywhere; }
      .action { flex: none; min-height: var(--lu-target); padding: 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-pill); background: transparent; color: var(--lu-accent); font: 600 var(--lu-type-label)/1 var(--lu-font); cursor: pointer; }
      .dismiss { flex: none; display: grid; place-items: center; width: var(--lu-target); height: var(--lu-target); padding: 0; border: 0; border-radius: var(--lu-radius-pill); background: transparent; color: var(--lu-ink-2); font-size: 20px; cursor: pointer; }
      @keyframes toast-in { from { opacity: 0; transform: translate(-50%, var(--lu-travel-layer)); } }
    `,
  ];
}

customElements.define("lu-toast", LuToast);

declare global {
  interface HTMLElementTagNameMap {
    "lu-toast": LuToast;
  }
}

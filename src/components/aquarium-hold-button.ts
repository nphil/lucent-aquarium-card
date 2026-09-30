/** Press-and-hold confirm, the touch-safe lock in front of an overwrite (saving a DIY program
 * replaces what is on the light). Holding charges an accent sweep behind the label; letting go
 * early drains it back instead of firing. A quick TAP is the ordinary-confirmation route for
 * people who cannot hold (Lucent: the hold is a shortcut, never the only way): it emits
 * `tap-confirm` and the owner shows a normal Cancel / Save choice. Keyboard: hold Space or
 * Enter; a click without a preceding pointer press (assistive tech) also counts as a tap.
 * Reduced motion keeps the same timing but drops the sweep animation. */

import { LitElement, css, html, type PropertyValues } from "lit";
import { DEFAULT_HOLD_CONFIG, HOLD_IDLE, holdPress, holdProgress, holdRelease, holdTick, isTapRelease, type HoldConfig, type HoldState } from "../lib/hold-progress.ts";
import { fireHaptic } from "../lib/haptics.ts";
import { icon, type IconName } from "../lib/icons.ts";
import { CONTROL_CSS, prefersReducedMotion, TOKENS_CSS } from "../styles/tokens.ts";

/** How long the confirmed state shows before the button is ready again. */
const SETTLE_MS = 900;

export class AquariumHoldButton extends LitElement {
  static properties = {
    label: { type: String },
    completeLabel: { type: String, attribute: "complete-label" },
    icon: { type: String },
    disabled: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
    tone: { type: String, reflect: true },
    config: { attribute: false },
  };

  declare label: string;
  declare completeLabel: string;
  declare icon: IconName;
  declare disabled: boolean;
  /** The confirmed action is in progress: show a spinner and refuse presses. */
  declare busy: boolean;
  /** `danger` for an action that can hurt (the charge and icon turn to the danger colour). */
  declare tone: "neutral" | "danger";
  declare config: HoldConfig;

  private _hold: HoldState = HOLD_IDLE;
  private _settled = false;
  private _raf: number | null = null;
  private _lastTs = 0;
  private _settleTimer: number | undefined;
  private _keyboardHold = false;
  private _pointerActive = false;

  constructor() {
    super();
    this.label = "Hold to confirm";
    this.completeLabel = "Done";
    this.icon = "save";
    this.disabled = false;
    this.busy = false;
    this.tone = "neutral";
    this.config = DEFAULT_HOLD_CONFIG;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("blur", this._cancelCharge);
    document.addEventListener("visibilitychange", this._cancelCharge);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("blur", this._cancelCharge);
    document.removeEventListener("visibilitychange", this._cancelCharge);
    this._stopLoop();
    window.clearTimeout(this._settleTimer);
  }

  protected updated(changed: PropertyValues<this>): void {
    if ((changed.has("disabled") && this.disabled) || (changed.has("busy") && this.busy)) this._reset();
  }

  private _reset(): void {
    this._stopLoop();
    this._hold = HOLD_IDLE;
    this._settled = false;
    this._keyboardHold = false;
    this._pointerActive = false;
    this.requestUpdate();
  }

  private _stopLoop(): void {
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  private _startLoop(): void {
    if (this._raf !== null) return;
    this._lastTs = performance.now();
    const step = (ts: number): void => {
      const delta = ts - this._lastTs;
      this._lastTs = ts;
      const before = this._hold.phase;
      this._hold = holdTick(this._hold, delta, this.config);
      this.requestUpdate();
      if (before === "charging" && this._hold.phase === "completed") this._onCompleted();
      if (this._hold.phase === "idle" || this._hold.phase === "completed") {
        this._raf = null;
        return;
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  private _onCompleted(): void {
    this._settled = true;
    this._keyboardHold = false;
    this._pointerActive = false;
    fireHaptic("success");
    this.dispatchEvent(new CustomEvent("confirmed", { bubbles: true, composed: true }));
    this._settleTimer = window.setTimeout(() => {
      this._hold = HOLD_IDLE;
      this._settled = false;
      this.requestUpdate();
    }, SETTLE_MS);
  }

  private _begin(): void {
    this._hold = holdPress();
    fireHaptic("light");
    this._startLoop();
  }

  private _end(): void {
    if (this._hold.phase !== "charging") return;
    const tap = isTapRelease(this._hold);
    this._hold = holdRelease(this._hold);
    this._startLoop();
    if (tap) this._emitTap();
  }

  private _emitTap(): void {
    this.dispatchEvent(new CustomEvent("tap-confirm", { bubbles: true, composed: true }));
  }

  private _cancelCharge = (): void => {
    if (this._hold.phase !== "charging") return;
    this._keyboardHold = false;
    this._pointerActive = false;
    this._hold = holdRelease(this._hold);
    this._startLoop();
  };

  private get _inert(): boolean {
    return this.disabled || this.busy || this._settled;
  }

  private _onPointerDown = (event: PointerEvent): void => {
    if (this._inert || (event.pointerType === "mouse" && event.button !== 0)) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    this._pointerActive = true;
    this._begin();
  };

  private _onPointerUp = (): void => {
    if (!this._pointerActive) return;
    this._pointerActive = false;
    this._end();
  };

  private _onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || (event.key !== " " && event.key !== "Enter") || this._inert || this._hold.phase === "charging") return;
    event.preventDefault();
    this._keyboardHold = true;
    this._begin();
  };

  private _onKeyUp = (event: KeyboardEvent): void => {
    if (!this._keyboardHold || (event.key !== " " && event.key !== "Enter")) return;
    this._keyboardHold = false;
    this._end();
  };

  /** A click that no pointer press or key hold produced comes from assistive technology. */
  private _onClick = (event: MouseEvent): void => {
    if (this._inert || event.detail !== 0 || this._keyboardHold) return;
    this._emitTap();
  };

  private _onFocusOut = (): void => {
    if (this._keyboardHold) this._cancelCharge();
  };

  render() {
    const progress = holdProgress(this._hold, this.config);
    const reduced = prefersReducedMotion();
    const label = this._settled ? this.completeLabel : this.label;
    const ring = 2 * Math.PI * 9;
    return html`<button type="button" class="hold ${reduced ? "reduced" : ""}" ?disabled=${this.disabled} aria-busy=${this.busy ? "true" : "false"} aria-label=${label} @pointerdown=${this._onPointerDown} @pointerup=${this._onPointerUp} @pointercancel=${this._onPointerUp} @keydown=${this._onKeyDown} @keyup=${this._onKeyUp} @focusout=${this._onFocusOut} @click=${this._onClick}>
      <span class="fill" style="transform: scaleX(${progress})"></span>
      <span class="content">
        <span class="lead">
          ${this.busy
            ? html`<span class="spinner" aria-hidden="true"></span>`
            : this._settled
              ? icon("check")
              : html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity="0.28" stroke-width="2.5"></circle><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray=${ring} stroke-dashoffset=${ring * (1 - progress)} transform="rotate(-90 12 12)"></circle></svg>`}
        </span>
        <span class="label">${label}</span>
      </span>
    </button>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; }
      .hold { position: relative; display: block; width: 100%; min-height: var(--lu-target); padding: 0; border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background-color: var(--lu-glass-raised); box-shadow: var(--lu-highlight-raised); overflow: hidden; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; }
      :host([tone="danger"]) .hold { border-color: color-mix(in srgb, var(--lu-danger) 45%, var(--lu-edge)); }
      :host([tone="danger"]) .fill { background: color-mix(in srgb, var(--lu-danger) 26%, transparent); }
      :host([tone="danger"]) .lead { color: var(--lu-danger); }
      .hold:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }
      .fill { position: absolute; inset: 0; background: var(--lu-accent-soft); transform-origin: left center; transform: scaleX(0); pointer-events: none; }
      .hold:not(.reduced) .fill { transition: transform var(--lu-motion-press) linear; }
      .content { position: relative; display: flex; align-items: center; justify-content: center; gap: var(--lu-space-2); min-height: calc(var(--lu-target) - 2px); padding: 0 var(--lu-space-5); font: 600 var(--lu-type-label)/1.2 var(--lu-font); }
      .lead { display: inline-flex; flex: none; color: var(--lu-accent); font-size: 20px; }
      .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .spinner { width: 16px; height: 16px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; }
      @media (prefers-reduced-motion: no-preference) { .spinner { animation: spin 0.9s linear infinite; } }
      @keyframes spin { to { transform: rotate(360deg); } }
    `,
  ];
}

customElements.define("aquarium-hold-button", AquariumHoldButton);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-hold-button": AquariumHoldButton;
  }
}

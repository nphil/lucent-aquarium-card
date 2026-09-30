import { LitElement, css, html, nothing } from "lit";
import type { DeviceModel, EffectDef } from "../adapters/types.ts";
import { cssRgb, glowFor } from "../lib/channels.ts";
import { icon } from "../lib/icons.ts";
import { nextRovingIndex } from "../lib/roving.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./lu-notice.ts";
import "./lu-pill-button.ts";

export interface EffectSelectDetail {
  id: string;
}

/** The Effects tab: the light's built-in scenes or native effects as tiles, and the Demo.
 *
 * The Demo replays the running schedule's 24 hours (Pawfly: one hour per second, about 24 s); it
 * only exists while a schedule is running, has no stop command, and ends as soon as any colour,
 * effect or schedule command is sent. It therefore has no state of its own on the light: the card
 * counts the run down locally (`demoRemainingMs`) and says what ends it.
 *
 * Events: `effect-select` `{id}`, `demo-start`, `open-schedule`. */
export class AquariumEffectsPanel extends LitElement {
  static properties = {
    model: { attribute: false },
    disabled: { type: Boolean },
    selectionPending: { type: Boolean, attribute: "selection-pending" },
    demoRemainingMs: { attribute: false },
    _focus: { state: true },
  };

  declare model: DeviceModel | null;
  declare disabled: boolean;
  declare selectionPending: boolean;
  /** Time left in a running Demo, or null when none runs. */
  declare demoRemainingMs: number | null;
  declare _focus: number;

  constructor() {
    super();
    this.model = null;
    this.disabled = false;
    this.selectionPending = false;
    this.demoRemainingMs = null;
    this._focus = 0;
  }

  private _select(effect: EffectDef): void {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent<EffectSelectDetail>("effect-select", { detail: { id: effect.id }, bubbles: true, composed: true }));
  }

  private _onKey(event: KeyboardEvent, current: number, count: number): void {
    const next = nextRovingIndex(event.key, current, count);
    if (next === null) return;
    event.preventDefault();
    this._focus = next;
    void this.updateComplete.then(() => this.renderRoot.querySelectorAll<HTMLButtonElement>(".tile")[next]?.focus());
  }

  /** The tile's colour: its own art colour, else the effect's colours at full strength (hue kept,
   * brightness lifted so a dim mix still reads), else null for a plain tile. */
  private _colour(effect: EffectDef, model: DeviceModel): string | null {
    if (effect.art && effect.art !== "cycle") return effect.art;
    if (effect.glow && "rgb" in effect.glow) return cssRgb(effect.glow.rgb);
    if (effect.glow && "levels" in effect.glow && model.channels.length > 0) {
      const glow = glowFor(effect.glow.levels, model.channels, 100);
      if (glow.intensity > 0) return cssRgb(glow.rgb);
    }
    return null;
  }

  private _renderStop(model: DeviceModel) {
    const effects = model.effects;
    if (!effects?.offId || !effects.runningId || model.phase !== "on") return nothing;
    return html`<lu-pill-button variant="quiet" icon="stop" label="Stop effect" ?disabled=${this.disabled} @lu-press=${() => this.dispatchEvent(new CustomEvent<EffectSelectDetail>("effect-select", { detail: { id: effects.offId as string }, bubbles: true, composed: true }))}></lu-pill-button>`;
  }

  private _renderDemo(model: DeviceModel) {
    const demo = model.effects?.demo;
    if (!demo) return nothing;
    const remaining = this.demoRemainingMs;
    if (remaining !== null) {
      const done = Math.min(1, Math.max(0, 1 - remaining / demo.durationMs));
      return html`<div class="demo running" role="status">
        <div class="demo-copy"><p class="demo-title">Demo running, ${Math.ceil(remaining / 1000)} s left</p><p class="demo-note">Any colour, effect or schedule change ends it.</p></div>
        <div class="bar" aria-hidden="true"><span style="transform:scaleX(${done})"></span></div>
      </div>`;
    }
    const canRun = demo.available && !this.disabled;
    return html`<div class="demo">
      <div class="demo-copy">
        <p class="demo-title">Demo</p>
        <p class="demo-note">${demo.available ? demo.description : demo.reason}</p>
      </div>
      <div class="demo-actions">
        <lu-pill-button variant="secondary" icon="playCircle" label="Play demo" ?disabled=${!canRun} @lu-press=${() => this.dispatchEvent(new CustomEvent("demo-start", { bubbles: true, composed: true }))}></lu-pill-button>
        ${demo.available || !model.schedule ? nothing : html`<lu-pill-button variant="quiet" label="Open schedule" ?disabled=${this.disabled} @lu-press=${() => this.dispatchEvent(new CustomEvent("open-schedule", { bubbles: true, composed: true }))}></lu-pill-button>`}
      </div>
    </div>`;
  }

  render() {
    const model = this.model;
    const effects = model?.effects;
    if (!model || !effects) return nothing;
    const list = effects.effects;
    const active = model.phase === "on" ? effects.runningId : null;
    const activeIndex = list.findIndex((effect) => effect.id === active);
    const focusable = activeIndex >= 0 ? activeIndex : Math.min(this._focus, Math.max(0, list.length - 1));
    return html`
      ${this.disabled ? html`<lu-notice kind="warning" compact heading="Effects are paused" message="They come back when the light is reachable again."></lu-notice>` : nothing}
      ${list.length === 0
        ? html`<lu-notice kind="info" compact heading="No effects reported yet" message="The light has not sent its effect list. It appears once Home Assistant has the light's state."></lu-notice>`
        : html`<section aria-labelledby="effects-title">
            <h3 id="effects-title">Scenes</h3>
            <div class="tiles" role="radiogroup" aria-label="Scenes">
              ${list.map((effect, position) => {
                const selected = position === activeIndex;
                const colour = this._colour(effect, model);
                return html`<button type="button" role="radio" class="tile" aria-checked=${selected ? "true" : "false"} tabindex=${position === focusable ? "0" : "-1"} ?disabled=${this.disabled} @click=${() => this._select(effect)} @keydown=${(event: KeyboardEvent) => this._onKey(event, position, list.length)}>
                  <span class="art ${effect.art === "cycle" ? "cycle" : ""} ${colour ? "" : "plain"}" style=${colour ? `--tile-colour:${colour}` : nothing}>${icon(effect.icon)}</span>
                  <span class="name">${effect.name}</span>
                  <span class="state">${selected ? (this.selectionPending ? "Starting" : "Playing") : ""}</span>
                  ${selected ? html`<span class="mark">${this.selectionPending ? html`<span class="spinner"></span>` : icon("check")}</span>` : nothing}
                </button>`;
              })}
            </div>
          </section>`}
      ${this._renderStop(model)}
      ${this._renderDemo(model)}
    `;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: grid; gap: var(--lu-space-4); min-width: 0; container-type: inline-size; }
      h3 { margin: 0 0 var(--lu-space-2); color: var(--lu-ink); font: 600 var(--lu-type-label)/1.3 var(--lu-font); }
      .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--lu-space-2); }
      @container (min-width: 460px) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      .tile { position: relative; display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: var(--lu-space-2); min-height: 96px; padding: var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); color: var(--lu-ink); background-color: transparent; text-align: left; cursor: pointer; transition: transform var(--lu-motion-press) var(--lu-ease-press), background-color var(--lu-motion-focus) var(--lu-ease); }
      .tile:hover:not(:disabled):not([aria-checked="true"]) { background-color: var(--lu-hover-wash); }
      .tile:active:not(:disabled) { transform: scale(var(--lu-scale-pressed)); }
      .tile:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }
      .tile[aria-checked="true"] { background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
      /* The tile art is content: a little dark tank with the effect's own colour glowing in it. */
      .art { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: 50%; color: color-mix(in srgb, var(--tile-colour) 62%, #fff); font-size: 22px; background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--tile-colour) 32%, transparent), transparent 74%), #0a1c26; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--tile-colour) 55%, transparent); }
      .art.plain { color: var(--lu-ink-2); background: var(--lu-tile); box-shadow: inset 0 0 0 1px var(--lu-edge); }
      .art.cycle { position: relative; color: #f4f7fa; background: #0a1c26; box-shadow: none; }
      .art.cycle::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 200deg, #f2545b, #f6c945, #2fc77a, #3fd0e0, #4b8bf5, #b061f0, #f2545b); -webkit-mask: radial-gradient(circle, transparent 62%, #000 64%); mask: radial-gradient(circle, transparent 62%, #000 64%); }
      .name { min-width: 0; font: 600 var(--lu-type-label)/1.25 var(--lu-font); overflow-wrap: break-word; }
      .state { min-height: 1.2em; margin-top: calc(var(--lu-space-1) * -1); color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1.2 var(--lu-font); }
      .mark { position: absolute; top: var(--lu-space-2); right: var(--lu-space-2); display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: var(--lu-accent-ink); background: var(--lu-accent); font-size: 16px; }
      .spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; }
      @media (prefers-reduced-motion: no-preference) { .spinner { animation: spin 0.9s linear infinite; } }
      @keyframes spin { to { transform: rotate(360deg); } }
      .demo { display: grid; gap: var(--lu-space-3); padding: var(--lu-space-3) var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); }
      .demo-copy { min-width: 0; }
      .demo-copy p { margin: 0; }
      .demo-title { font: 600 var(--lu-type-label)/1.3 var(--lu-font); }
      .demo-note { margin-top: var(--lu-space-1) !important; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .demo-actions { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
      .bar { height: 6px; overflow: hidden; border-radius: var(--lu-radius-pill); background: var(--lu-track-off); }
      .bar span { display: block; height: 100%; transform-origin: left center; background: var(--lu-accent); }
    `,
  ];
}

customElements.define("aquarium-effects-panel", AquariumEffectsPanel);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-effects-panel": AquariumEffectsPanel;
  }
}

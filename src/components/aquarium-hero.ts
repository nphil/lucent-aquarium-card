import { LitElement, css, html, nothing } from "lit";
import type { DeviceModel, EffectMotion, TankColour } from "../adapters/types.ts";
import { clamp, cssRgbTriple, glowFor, type Glow } from "../lib/channels.ts";
import { icon } from "../lib/icons.ts";
import { CONTROL_CSS, prefersReducedMotion, TOKENS_CSS } from "../styles/tokens.ts";
import "./lu-chip.ts";
import "./lu-icon-button.ts";
import "./lu-skeleton.ts";
import "./aquarium-slider.ts";
import type { SliderDetail } from "./aquarium-slider.ts";

/** The card's hero: a calm "tank glow" of the light's current colour at its current brightness,
 * status chips, the power button and the master brightness slider.
 *
 * The art is CONTENT, not chrome: it depicts the light, so its water, glow and silhouettes are
 * literal colours that ignore the host theme. Everything drawn over it (chips, the control strip)
 * uses the theme's own glass. `tank` is what the tank shows; the card passes the running scene's
 * colours or the schedule's live colour when the light's own status colour is not what it is doing.
 *
 * Some effects animate on the real light (the storm flickers, the RGB cycle sweeps hues). When
 * `motion` says so and `ambient` allows it (card visible, motion not reduced) the tank does the
 * same, starting from `motionTank`; otherwise they are drawn still.
 *
 * Events: `power-toggle`, `more-info`, `brightness-input` / `brightness-change` with `{value}` (percent). */
export class AquariumHero extends LitElement {
  static properties = {
    model: { attribute: false },
    tank: { attribute: false },
    motion: { attribute: false },
    motionTank: { attribute: false },
    ambient: { type: Boolean },
    powerPending: { type: Boolean, attribute: "power-pending" },
    demo: { type: Boolean },
  };

  declare model: DeviceModel | null;
  /** The colour to draw; null draws the dark tank. */
  declare tank: TankColour | null;
  declare motion: EffectMotion | null;
  declare motionTank: TankColour | null;
  /** Ambient motion is allowed (card visible, tab in front, light on). */
  declare ambient: boolean;
  declare powerPending: boolean;
  /** A Demo run is in progress (adds a chip). */
  declare demo: boolean;

  constructor() {
    super();
    this.model = null;
    this.tank = null;
    this.motion = null;
    this.motionTank = null;
    this.ambient = false;
    this.powerPending = false;
    this.demo = false;
  }

  private _brightnessInput = (event: CustomEvent<SliderDetail>): void => {
    event.stopPropagation();
    this._forward("brightness-input", event.detail.value);
  };

  private _brightnessChange = (event: CustomEvent<SliderDetail>): void => {
    event.stopPropagation();
    this._forward("brightness-change", event.detail.value);
  };

  private _forward(name: string, value: number): void {
    this.dispatchEvent(new CustomEvent<SliderDetail>(name, { detail: { value }, bubbles: true, composed: true }));
  }

  private _moreInfo = (): void => {
    this.dispatchEvent(new CustomEvent("more-info", { bubbles: true, composed: true }));
  };

  private _togglePower = (): void => {
    this.dispatchEvent(new CustomEvent("power-toggle", { bubbles: true, composed: true }));
  };

  private _glow(model: DeviceModel, tank: TankColour | null, on: boolean): Glow {
    const brightness = model.brightness ?? 100;
    if (!tank || !on) return { rgb: [0, 0, 0], intensity: 0 };
    if ("levels" in tank) return model.channels.length > 0 ? glowFor(tank.levels, model.channels, brightness, on) : { rgb: [0, 0, 0], intensity: 0 };
    return { rgb: [...tank.rgb], intensity: Math.round(Math.pow(clamp(brightness, 0, 100) / 100, 0.6) * 1000) / 1000 };
  }

  render() {
    const model = this.model;
    if (!model || model.phase === "loading") {
      return html`<div class="hero loading"><lu-skeleton label="Loading the light" height="100%"></lu-skeleton></div>`;
    }
    const on = model.phase === "on";
    const unavailable = model.phase === "unavailable";
    const moving = this.motion !== null && this.ambient && on && !prefersReducedMotion();
    let tank = this.tank;
    if (this.motionTank && ((this.motion === "storm" && on) || (this.motion === "cycle" && moving))) tank = this.motionTank;
    const glow = this._glow(model, tank, on);
    const lit = glow.intensity > 0.02;
    const powerLabel = unavailable ? "Light unavailable" : on ? "Turn the light off" : "Turn the light on";
    const state = [on ? "on" : "", unavailable ? "unavailable" : "", moving ? `motion-${this.motion}` : "", this.motion === "storm" && on && !moving ? "storm-still" : "", this.ambient && on && lit ? "sway" : ""].filter(Boolean).join(" ");
    const scheduleDark = on && !lit && model.running.kind !== "effect";

    return html`<div class="hero ${state}" style="--glow-rgb:${cssRgbTriple(glow.rgb)};--glow-i:${glow.intensity}">
      <div class="art" role="img" aria-label=${model.status.summary}>
        <div class="water"></div>
        <div class="glow">
          <div class="beam"></div>
          <div class="rays"></div>
          <div class="lamp"></div>
        </div>
        <svg class="floor" viewBox="0 0 320 200" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          <path class="sand" d="M0 200V178C38 170 88 181 140 174S252 168 320 176V200Z"></path>
          <ellipse class="stone" cx="62" cy="186" rx="22" ry="9"></ellipse>
          <ellipse class="stone" cx="258" cy="184" rx="30" ry="11"></ellipse>
          <path class="plant" d="M30 190C26 160 40 138 34 108"></path>
          <path class="plant" d="M40 190C46 164 58 148 60 122"></path>
          <path class="plant" d="M286 190C292 166 282 146 292 116"></path>
          <path class="plant" d="M276 190C270 170 262 156 266 134"></path>
        </svg>
        ${scheduleDark ? html`<p class="dark-note">${model.running.kind === "schedule" ? "Dark at this hour of the schedule" : "All channels at 0%"}</p>` : nothing}
      </div>
      <div class="top">
        ${model.status.chips.map((chip) => html`<lu-chip label=${chip.label} kind=${chip.kind} icon=${chip.icon}></lu-chip>`)}
        ${model.status.mode ? html`<lu-chip label=${model.status.mode}></lu-chip>` : nothing}
        ${this.demo ? html`<lu-chip label="Demo running" kind="warning" icon="playCircle"></lu-chip>` : nothing}
      </div>
      <lu-icon-button class="more" icon="info" label="Open light details" tone="raised" @lu-press=${this._moreInfo}></lu-icon-button>
      <div class="bottom">
        <button type="button" class="power" aria-label=${powerLabel} aria-pressed=${on ? "true" : "false"} ?disabled=${unavailable} aria-busy=${this.powerPending ? "true" : "false"} @click=${this._togglePower}>
          ${icon("power")}
        </button>
        ${model.hasBrightness
          ? html`<aquarium-slider class="dimmer" label="Brightness" icon="brightness" .value=${model.brightness ?? 100} min="1" max="100" ?disabled=${unavailable} @slider-input=${this._brightnessInput} @slider-change=${this._brightnessChange}></aquarium-slider>`
          : html`<span class="no-dimmer">${on ? "On" : "Off"}</span>`}
      </div>
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host {
        display: block;
        min-width: 0;
        /* Content art: the tank, drawn in its own colours whatever the host theme is. */
        --art-water-top: #0d2b3a;
        --art-water-mid: #08202c;
        --art-water-bottom: #040d14;
        --art-floor: #050c10;
      }
      .hero { position: relative; isolation: isolate; width: 100%; aspect-ratio: var(--hero-aspect, 16 / 10); height: var(--hero-height, auto); min-height: 200px; overflow: hidden; border-radius: var(--hero-radius, var(--lu-radius-tile)); background: var(--art-water-bottom); }
      .hero.loading lu-skeleton { display: block; height: 100%; }
      .art { position: absolute; inset: 0; z-index: 0; }
      .water { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 0%, transparent 42%, rgb(0 0 0 / 0.5) 100%), linear-gradient(180deg, var(--art-water-top), var(--art-water-mid) 48%, var(--art-water-bottom)); }
      .glow { position: absolute; inset: 0; opacity: 0; transition: opacity var(--lu-motion-card) var(--lu-ease); }
      .hero.on .glow { opacity: 1; }
      .beam { position: absolute; inset: 0; background: radial-gradient(78% 112% at 50% 0%, rgb(var(--glow-rgb) / calc(var(--glow-i) * 1)) 0%, rgb(var(--glow-rgb) / calc(var(--glow-i) * 0.55)) 30%, rgb(var(--glow-rgb) / calc(var(--glow-i) * 0.2)) 62%, transparent 92%), radial-gradient(120% 70% at 50% 100%, rgb(var(--glow-rgb) / calc(var(--glow-i) * 0.18)), transparent 70%); }
      .rays { position: absolute; inset: -10% -20% 30%; opacity: calc(var(--glow-i) * 0.9); background: repeating-linear-gradient(104deg, rgb(var(--glow-rgb) / 0.13) 0 3px, transparent 3px 54px); -webkit-mask-image: linear-gradient(180deg, #000, transparent 78%); mask-image: linear-gradient(180deg, #000, transparent 78%); }
      .hero.sway .rays { animation: sway 26s linear infinite; }
      .lamp { position: absolute; top: 10px; left: 50%; width: 44%; height: 7px; transform: translateX(-50%); border-radius: var(--lu-radius-pill); background: color-mix(in srgb, rgb(var(--glow-rgb)) calc(var(--glow-i) * 100%), #2a3a44); box-shadow: 0 0 calc(6px + var(--glow-i) * 26px) calc(var(--glow-i) * 5px) rgb(var(--glow-rgb) / calc(var(--glow-i) * 0.85)); }
      .floor { position: absolute; inset: 0; width: 100%; height: 100%; }
      .floor .sand, .floor .stone { fill: color-mix(in srgb, rgb(var(--glow-rgb)) calc(var(--glow-i) * 10%), var(--art-floor)); }
      .floor .plant { fill: none; stroke: color-mix(in srgb, rgb(var(--glow-rgb)) calc(var(--glow-i) * 14%), var(--art-floor)); stroke-width: 3; stroke-linecap: round; }
      .hero.storm-still .glow { opacity: 0.5; }
      .hero.motion-storm .glow { animation: storm 9s linear infinite; }
      .hero.motion-cycle .glow { animation: cycle 24s linear infinite; will-change: filter; }
      .dark-note { position: absolute; left: 50%; top: 42%; margin: 0; transform: translate(-50%, -50%); padding: var(--lu-space-1) var(--lu-space-3); border-radius: var(--lu-radius-pill); color: rgb(255 255 255 / 0.72); background: rgb(0 0 0 / 0.28); font: 500 var(--lu-type-caption)/1.3 var(--lu-font); text-align: center; white-space: nowrap; }
      .hero.unavailable .art { filter: saturate(0.25) brightness(0.8); }
      .top { position: absolute; z-index: 1; top: var(--lu-space-2); left: var(--lu-space-2); right: calc(var(--lu-target) + var(--lu-space-3)); display: flex; flex-wrap: wrap; gap: var(--lu-space-1); pointer-events: none; }
      .more { position: absolute; z-index: 1; top: var(--lu-space-1); right: var(--lu-space-1); }
      .bottom { position: absolute; z-index: 1; left: var(--lu-space-2); right: var(--lu-space-2); bottom: var(--lu-space-2); display: flex; align-items: center; gap: var(--lu-space-2); padding: var(--lu-space-1) var(--lu-space-3) var(--lu-space-1) var(--lu-space-1); color: var(--lu-ink); background: color-mix(in srgb, var(--lu-card) 84%, transparent); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); }
      .power { flex: none; display: grid; place-items: center; width: var(--lu-target); height: var(--lu-target); padding: 0; border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background-color: var(--lu-glass-raised); box-shadow: var(--lu-highlight-raised); font-size: 24px; cursor: pointer; transition: transform var(--lu-motion-press) var(--lu-ease-press); }
      .power[aria-pressed="true"] { color: var(--lu-accent); }
      .power:active:not(:disabled) { transform: scale(var(--lu-scale-pressed)); }
      .power:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }
      .dimmer { flex: 1 1 0; min-width: 0; --aquarium-slider-label: 28px; }
      .no-dimmer { flex: 1 1 auto; color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.3 var(--lu-font); }
      @keyframes sway { from { transform: translateX(0); } to { transform: translateX(-54px); } }
      /* Rare, brief flashes over a dim glow: never more than two in a second. */
      @keyframes storm { 0%, 5%, 12%, 50%, 56%, 100% { opacity: 0.16; } 6% { opacity: 1; } 8% { opacity: 0.22; } 10% { opacity: 0.85; } 51% { opacity: 0.7; } 53% { opacity: 0.16; } }
      @keyframes cycle { to { filter: hue-rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .hero .glow, .hero .rays { animation: none !important; } .glow { transition: none; } }
    `,
  ];
}

customElements.define("aquarium-hero", AquariumHero);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-hero": AquariumHero;
  }
}

import { LitElement, css, html, nothing } from "lit";
import type { DeviceModel } from "../adapters/types.ts";
import { levelsEqual, levelsLabel, swatchColour, zeroLevels, type Levels } from "../lib/channels.ts";
import { icon } from "../lib/icons.ts";
import { nextRovingIndex } from "../lib/roving.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./aq-notice.ts";
import "./aquarium-slider.ts";
import type { SliderDetail } from "./aquarium-slider.ts";

export interface ChannelChangeDetail {
  /** Channel index in `model.channels`. */
  index: number;
  value: number;
  commit: boolean;
}

export interface LevelsSelectDetail {
  levels: Levels;
}

/** The Colour tab: colour presets and one slider per LED channel, whatever the light's channels
 * are called. Sliders show the light's manual colour; while a scene or schedule runs, moving one
 * switches the light to manual and the panel says so first.
 *
 * Events: `channel-change` `{index, value, commit}` for a slider (only the moved channel is sent
 * to the light) and `levels-select` `{levels}` for a preset (all channels at once). */
export class AquariumColourPanel extends LitElement {
  static properties = {
    model: { attribute: false },
    disabled: { type: Boolean },
    _focus: { state: true },
  };

  declare model: DeviceModel | null;
  declare disabled: boolean;
  declare _focus: number;

  constructor() {
    super();
    this.model = null;
    this.disabled = false;
    this._focus = 0;
  }

  private _channel(index: number, event: CustomEvent<SliderDetail>, commit: boolean): void {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent<ChannelChangeDetail>("channel-change", { detail: { index, value: event.detail.value, commit }, bubbles: true, composed: true }));
  }

  private _pick(levels: Levels): void {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent<LevelsSelectDetail>("levels-select", { detail: { levels }, bubbles: true, composed: true }));
  }

  private _onSwatchKey(event: KeyboardEvent, current: number, count: number): void {
    const next = nextRovingIndex(event.key, current, count);
    if (next === null) return;
    event.preventDefault();
    this._focus = next;
    void this.updateComplete.then(() => this.renderRoot.querySelectorAll<HTMLButtonElement>(".swatch")[next]?.focus());
  }

  render() {
    const model = this.model;
    if (!model || model.channels.length === 0) return nothing;
    const { channels, swatches } = model;
    const levels = model.levels ?? zeroLevels(channels.length);
    const selected = swatches.findIndex((swatch) => levelsEqual(swatch.levels, levels));
    const focusable = selected >= 0 ? selected : Math.min(this._focus, Math.max(0, swatches.length - 1));
    // Long channel names ("Cold White") need room; the default width suits short ones ("Green").
    const labelWidth = Math.min(112, Math.max(72, Math.max(...channels.map((channel) => channel.name.length)) * 7.5 + 22));
    const running = model.phase === "on" && model.running.kind !== "manual" ? model.status.mode : null;
    return html`
      ${this.disabled
        ? html`<aq-notice kind="warning" compact heading="Colour controls are paused" message="They come back when the light is reachable again."></aq-notice>`
        : running
          ? html`<aq-notice kind="info" compact message=${`Running ${running}. Moving a slider or choosing a colour switches the light to manual.`}></aq-notice>`
          : nothing}
      ${model.notices.map((notice) => html`<aq-notice kind=${notice.kind} compact message=${notice.text}></aq-notice>`)}
      ${swatches.length > 0
        ? html`<section class="group" aria-labelledby="presets-title">
            <h3 id="presets-title">Presets</h3>
            <div class="swatches" role="radiogroup" aria-label="Colour presets">
              ${swatches.map(
                (swatch, index) => html`<button type="button" role="radio" class="swatch" aria-checked=${index === selected ? "true" : "false"} aria-label=${`${swatch.name}: ${levelsLabel(swatch.levels, channels)}`} title=${swatch.name} tabindex=${index === focusable ? "0" : "-1"} ?disabled=${this.disabled} @click=${() => this._pick(swatch.levels)} @keydown=${(event: KeyboardEvent) => this._onSwatchKey(event, index, swatches.length)}>
                  <span class="chip" style="background:${swatchColour(swatch.levels, channels)}">${index === selected ? icon("check") : nothing}</span>
                </button>`,
              )}
            </div>
            <p class="caption" aria-live="polite">${selected >= 0 ? swatches[selected]!.name : "Custom mix"}</p>
          </section>`
        : nothing}
      <section class="group" aria-labelledby="mix-title" style=${`--aquarium-slider-label:${labelWidth}px`}>
        <h3 id="mix-title">Mix</h3>
        ${channels.map(
          (channel, index) => html`<aquarium-slider label=${channel.name} dot=${channel.colour} fill=${channel.colour} .value=${levels[index] ?? 0} ?disabled=${this.disabled} @slider-input=${(event: CustomEvent<SliderDetail>) => this._channel(index, event, false)} @slider-change=${(event: CustomEvent<SliderDetail>) => this._channel(index, event, true)}></aquarium-slider>`,
        )}
      </section>
    `;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: grid; gap: var(--lu-space-4); min-width: 0; }
      .group { display: grid; gap: var(--lu-space-1); min-width: 0; }
      h3 { margin: 0 0 var(--lu-space-1); color: var(--lu-ink); font: 600 var(--lu-type-label)/1.3 var(--lu-font); }
      .swatches { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
      .swatch { display: grid; place-items: center; width: var(--lu-target); height: var(--lu-target); padding: 0; border: 0; border-radius: var(--lu-radius-pill); background-color: transparent; cursor: pointer; transition: transform var(--lu-motion-press) var(--lu-ease-press); }
      .swatch:active:not(:disabled) { transform: scale(var(--lu-scale-pressed)); }
      .swatch:disabled { opacity: var(--lu-disabled-opacity); cursor: default; }
      .chip { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; color: #fff; font-size: 20px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lu-ink) 26%, transparent), var(--lu-shadow-raised); transition: transform var(--lu-motion-focus) var(--lu-ease); }
      .swatch[aria-checked="true"] .chip { transform: scale(1.12); box-shadow: 0 0 0 2px var(--lu-card), 0 0 0 4px var(--lu-ink); }
      .swatch:focus-visible { box-shadow: none; background-image: none; }
      .swatch:focus-visible .chip { box-shadow: 0 0 0 2px var(--lu-card), 0 0 0 4px var(--lu-accent); }
      .caption { min-height: 1.4em; margin: 0; color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.4 var(--lu-font); }
      @media (prefers-reduced-motion: reduce) { .chip { transition: none; } }
    `,
  ];
}

customElements.define("aquarium-colour-panel", AquariumColourPanel);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-colour-panel": AquariumColourPanel;
  }
}

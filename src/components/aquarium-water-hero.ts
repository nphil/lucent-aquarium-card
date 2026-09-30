import { LitElement, css, html, nothing } from "lit";
import { bandTrack, type Band, type HistoryPoint } from "../lib/equipment.ts";
import { icon } from "../lib/icons.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import "./aq-chip.ts";
import "./aq-skeleton.ts";
import "./aquarium-sparkline.ts";

export type HeroTone = "positive" | "warning" | "danger" | "neutral";
export type HistoryState = "loading" | "ready" | "empty" | "error";

/** The water temperature as the card's hero: a big light numeral, a plain-words verdict, a band
 * indicator that shows where the reading sits against the comfortable range, and the last day as
 * a line. It only draws what it is given; the numbers and the words come from `lib/equipment.ts`
 * through the card. Without a reading it says so and why instead of showing a stale zero. */
export class AquariumWaterHero extends LitElement {
  static properties = {
    heading: { type: String },
    value: { attribute: false },
    unit: { type: String },
    band: { attribute: false },
    verdict: { type: String },
    tone: { type: String, reflect: true },
    problem: { type: String },
    age: { type: String },
    stale: { type: Boolean },
    battery: { attribute: false },
    batteryTone: { type: String, attribute: "battery-tone" },
    history: { attribute: false },
    historyStart: { type: Number, attribute: "history-start" },
    historyEnd: { type: Number, attribute: "history-end" },
    historyState: { type: String, attribute: "history-state" },
    historyLabel: { type: String, attribute: "history-label" },
  };

  declare heading: string;
  /** The reading, or null without one. */
  declare value: number | null;
  declare unit: string;
  declare band: Band | null;
  declare verdict: string;
  declare tone: HeroTone;
  /** Why there is no reading, when there is none. */
  declare problem: string;
  /** "Updated 3 min ago". */
  declare age: string;
  /** The reading is old enough to doubt. */
  declare stale: boolean;
  declare battery: number | null;
  declare batteryTone: "neutral" | "warning" | "danger";
  declare history: readonly HistoryPoint[];
  declare historyStart: number;
  declare historyEnd: number;
  declare historyState: HistoryState;
  /** The text alternative of the history line ("Last 24 hours: 76.1 to 78.0°F"). */
  declare historyLabel: string;

  constructor() {
    super();
    this.heading = "Water temperature";
    this.value = null;
    this.unit = "";
    this.band = null;
    this.verdict = "";
    this.tone = "neutral";
    this.problem = "";
    this.age = "";
    this.stale = false;
    this.battery = null;
    this.batteryTone = "neutral";
    this.history = [];
    this.historyStart = 0;
    this.historyEnd = 0;
    this.historyState = "loading";
    this.historyLabel = "";
  }

  private _renderIndicator() {
    const band = this.band;
    if (!band) return nothing;
    const track = bandTrack(this.value, band);
    const percent = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`;
    return html`<div class="indicator" role="img" aria-label=${this.value === null ? `Comfortable range ${band.min} to ${band.max}${this.unit}` : `${this.verdict}`}>
      <div class="track">
        <span class="band" style=${`left:${percent(track.from)};width:${percent(track.to - track.from)}`}></span>
        ${track.marker === null ? nothing : html`<span class="marker" style=${`left:${percent(track.marker)}`}></span>`}
      </div>
      <div class="edges" aria-hidden="true">
        <span style=${`left:${percent(track.from)}`}>${band.min}</span>
        <span style=${`left:${percent(track.to)}`}>${band.max}</span>
      </div>
    </div>`;
  }

  private _renderHistory() {
    switch (this.historyState) {
      case "loading":
        return html`<aq-skeleton label="Loading the last 24 hours" height="64px"></aq-skeleton>`;
      case "error":
        return html`<p class="quiet">The last 24 hours aren't available right now.</p>`;
      case "empty":
        return html`<p class="quiet">No readings from the last 24 hours yet.</p>`;
      case "ready":
        return html`<aquarium-sparkline .points=${this.history} .start=${this.historyStart} .end=${this.historyEnd} .band=${this.band} .label=${this.historyLabel}></aquarium-sparkline>
          <div class="span" aria-hidden="true"><span>24 h ago</span><span>Now</span></div>`;
    }
  }

  render() {
    const reading = this.value === null ? null : this.value.toFixed(1);
    return html`<section class="hero" aria-labelledby="heading">
      <div class="head">
        <h2 class="label" id="heading">${this.heading}</h2>
        ${this.battery !== null ? html`<aq-chip kind=${this.batteryTone === "neutral" ? "neutral" : this.batteryTone === "warning" ? "warning" : "danger"} icon=${this.batteryTone === "neutral" ? "batteryOutline" : "batteryAlert"} label=${`Battery ${this.battery}%`}></aq-chip>` : nothing}
      </div>
      <div class="reading" role="status">
        ${reading === null
          ? html`<span class="numeral gone" aria-label="No reading">—</span>`
          : html`<span class="numeral">${reading}</span><span class="unit">${this.unit}</span>`}
      </div>
      ${reading === null
        ? html`<p class="verdict"><span class="glyph">${icon("alert")}</span><span>${this.problem || "The thermometer has no reading."}</span></p>`
        : this.verdict
          ? html`<p class="verdict"><i class="dot" aria-hidden="true"></i><span>${this.verdict}</span></p>`
          : nothing}
      ${this._renderIndicator()}
      <div class="history">${this._renderHistory()}</div>
      ${this.age ? html`<p class="updated" data-stale=${this.stale ? "true" : "false"}>${this.stale ? icon("alert") : nothing}<span>${this.age}</span></p>` : nothing}
    </section>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: flex; flex-direction: column; min-width: 0; container-type: inline-size; --tone: var(--lu-accent); }
      :host([tone="positive"]) { --tone: var(--lu-positive); }
      :host([tone="warning"]) { --tone: var(--lu-warning); }
      :host([tone="danger"]) { --tone: var(--lu-danger); }
      .hero { display: flex; flex: 1 1 auto; flex-direction: column; gap: var(--lu-space-3); padding: var(--lu-space-5) var(--lu-space-4) var(--lu-space-4); background: radial-gradient(130% 90% at 0% 0%, color-mix(in srgb, var(--tone) 18%, transparent), transparent 65%), var(--lu-tile); }
      .head { display: flex; align-items: center; justify-content: space-between; gap: var(--lu-space-2); min-height: 28px; }
      .label { margin: 0; color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.3 var(--lu-font); }
      .reading { display: flex; align-items: baseline; gap: var(--lu-space-2); min-width: 0; }
      .numeral { color: var(--lu-ink); font: 300 clamp(52px, 22cqw, 84px)/1 var(--lu-font); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
      .numeral.gone { color: var(--lu-ink-3); }
      .unit { color: var(--lu-ink-2); font: 300 clamp(20px, 8cqw, 30px)/1 var(--lu-font); }
      .verdict { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink); font: 500 var(--lu-type-label)/1.4 var(--lu-font); }
      .dot { flex: none; width: 10px; height: 10px; margin-top: 4px; border-radius: 50%; background-color: var(--tone); }
      .glyph { display: grid; flex: none; font-size: 20px; color: var(--lu-warning); }

      .indicator { display: grid; gap: 2px; padding: 0 var(--lu-space-2); }
      .track { position: relative; height: 12px; border-radius: var(--lu-radius-pill); background-color: var(--lu-track-off); box-shadow: var(--lu-inset), 0 0 0 1px var(--lu-well-edge); }
      .band { position: absolute; top: 0; bottom: 0; border-radius: var(--lu-radius-pill); background-color: color-mix(in srgb, var(--lu-positive) 45%, transparent); }
      .marker { position: absolute; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; border: 3px solid var(--tone); border-radius: 50%; background-color: var(--lu-card); box-shadow: var(--lu-shadow-raised); }
      .edges { position: relative; height: 18px; color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/18px var(--lu-font); font-variant-numeric: tabular-nums; }
      .edges span { position: absolute; top: 0; transform: translateX(-50%); }
      @media (forced-colors: active) {
        .track { border: 1px solid CanvasText; box-shadow: none; }
        .band { forced-color-adjust: none; background-color: Highlight; }
        .marker { border-color: CanvasText; background-color: Canvas; }
        .hero { border-bottom: 1px solid CanvasText; }
      }

      .history { display: grid; gap: 2px; margin-top: auto; padding-top: var(--lu-space-2); min-width: 0; }
      .span { display: flex; justify-content: space-between; color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.3 var(--lu-font); }
      .quiet { margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-label)/1.4 var(--lu-font); }
      .updated { display: flex; align-items: center; gap: var(--lu-space-1); margin: 0; color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.3 var(--lu-font); }
      .updated[data-stale="true"] { color: var(--lu-ink); font-weight: 600; }
      .updated .icon { flex: none; font-size: 16px; color: var(--lu-warning); }
    `,
  ];
}

customElements.define("aquarium-water-hero", AquariumWaterHero);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-water-hero": AquariumWaterHero;
  }
}

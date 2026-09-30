import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { sparkline, type Band, type HistoryPoint, type Sparkline } from "../lib/equipment.ts";
import { TOKENS_CSS } from "../styles/tokens.ts";

const HEIGHT = 64;
const PAD = 5;

/** A minimal history line: no axes, the comfortable band as a faint stripe behind it and a dot on
 * the latest reading. It is a picture of the shape of the last day; the numbers are said in words
 * by whoever places it (`label` is its text alternative). */
export class AquariumSparkline extends LitElement {
  static properties = {
    points: { attribute: false },
    start: { type: Number },
    end: { type: Number },
    band: { attribute: false },
    label: { type: String },
    _width: { state: true },
  };

  declare points: readonly HistoryPoint[];
  declare start: number;
  declare end: number;
  declare band: Band | null;
  declare label: string;
  declare _width: number;

  private _line: Sparkline | null = null;
  private _resize: ResizeObserver | undefined;

  constructor() {
    super();
    this.points = [];
    this.start = 0;
    this.end = 0;
    this.band = null;
    this.label = "";
    this._width = 0;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._resize = new ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      if (width !== this._width) this._width = width;
    });
    this._resize.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resize?.disconnect();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (this._width === 0) this._width = Math.round(this.getBoundingClientRect().width);
    if (changed.has("points") || changed.has("start") || changed.has("end") || changed.has("band") || changed.has("_width")) {
      this._line = this._width > 0 ? sparkline(this.points, this.start, this.end, { width: this._width, height: HEIGHT, pad: PAD }, this.band) : null;
    }
  }

  render() {
    const line = this._line;
    const width = this._width;
    if (!line || width === 0) return html`<div class="empty" style=${`height:${HEIGHT}px`}></div>`;
    return html`<svg width=${width} height=${HEIGHT} viewBox=${`0 0 ${width} ${HEIGHT}`} role="img" aria-label=${this.label}>
      ${line.band ? svg`<rect class="band" x="0" y=${line.band.top} width=${width} height=${Math.max(0, line.band.bottom - line.band.top)} rx="4"></rect>` : nothing}
      <path class="line" d=${line.path}></path>
      ${line.last ? svg`<circle class="dot" cx=${line.last.x} cy=${line.last.y} r="4"></circle>` : nothing}
    </svg>`;
  }

  static styles = [
    TOKENS_CSS,
    css`
      :host { display: block; min-width: 0; }
      svg { display: block; overflow: visible; }
      .band { fill: color-mix(in srgb, var(--lu-positive) 16%, transparent); }
      .line { fill: none; stroke: var(--lu-ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .dot { fill: var(--lu-ink); stroke: var(--lu-card); stroke-width: 2; }
      @media (forced-colors: active) { svg { forced-color-adjust: none; } .line { stroke: CanvasText; } .dot { fill: CanvasText; } }
    `,
  ];
}

customElements.define("aquarium-sparkline", AquariumSparkline);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-sparkline": AquariumSparkline;
  }
}

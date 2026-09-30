import { LitElement, css, html, nothing, svg, type PropertyValues, type SVGTemplateResult, type TemplateResult } from "lit";
import { clamp, swatchColour, type ChannelDef } from "../lib/channels.ts";
import { hourTicks, minutesToX, nearestLevelField, nearestPointIndex, valueToY, xToMinutes, yToValue, type PlotBox } from "../lib/chart-geometry.ts";
import { channelGeometry, chartLayout, chartSummary, keyStep, needsHalo, readoutWidth, ribbonGradient, ribbonStops, scrubMinutes, type ChannelGeometry, type ChartLayout } from "../lib/chart-model.ts";
import { colourAt } from "../lib/curve.ts";
import { formatTime, LAST_MINUTE, neighbourBounds, SNAP_MINUTES, type SchedulePoint } from "../lib/points.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

export interface PointSelectDetail {
  index: number;
}
export interface PointMoveDetail {
  index: number;
  /** Fractional minutes under the pointer (or the key's target); the editor snaps and clamps. */
  minutes: number;
  commit: boolean;
  /** The grid the editor should snap to: the chart's `snap`, or 1 for Shift / `fine`. */
  step: number;
}
export interface PointLevelDetail {
  index: number;
  /** Index into every point's `levels` (the position in the chart's `channels`). */
  channel: number;
  value: number;
  commit: boolean;
}
export interface PointAddDetail {
  minutes: number;
}
export interface DragStateDetail {
  dragging: boolean;
}

/** Half of a grip's 48 px hit area. */
const GRIP_REACH = 24;
/** Half of a level dot's 44 px hit area. */
const DOT_REACH = 22;
/** How close (px) a tap on the empty plot must be to a point to select it. */
const PLOT_SELECT_REACH = 20;
/** A press that travels less than this is a tap, not a drag. */
const DRAG_SLOP = 3;
const TAP_SLOP = 8;
const TAP_MAX_MS = 600;
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_SLOP = 28;
const NOW_PILL = { width: 36, height: 18 } as const;

interface DragInfo {
  kind: "time" | "level";
  pointerId: number;
  index: number;
  /** Channel index for a level drag. */
  channel: number;
  /** Minutes or level when the drag began (what Escape restores). */
  origin: number;
  /** Pointer offset from the handle's centre along the drag axis, so the handle does not jump. */
  grab: number;
  startX: number;
  startY: number;
  moved: boolean;
  last: number;
  step: number;
  capture: HTMLElement;
}

interface TapRecord {
  x: number;
  y: number;
  t: number;
}

/** The 24 h schedule chart, for any set of channels. Read-only it draws one line per channel, a
 * colour ribbon of the whole day, a "now" marker and a scrub readout. With `interactive` it adds
 * HTML handles over the drawing (not SVG: `touch-action` and pointer capture must work on them):
 * a time grip per point on a rail, and level dots on the selected point. It never changes
 * `points`; it reports what the user asked for and the editor applies it with the rules in
 * `lib/points.ts`.
 *
 * Events (all bubble, composed): `point-select`, `point-move`, `point-level`, `point-add`,
 * `drag-state`, `interaction`. */
export class AquariumScheduleChart extends LitElement {
  static properties = {
    points: { attribute: false },
    channels: { attribute: false },
    nowMinutes: { attribute: false },
    label: { type: String },
    interactive: { type: Boolean, reflect: true },
    compact: { type: Boolean, reflect: true },
    selected: { type: Number },
    snap: { type: Number },
    stale: { type: Boolean, reflect: true },
    fine: { type: Boolean },
    _width: { state: true },
    _hidden: { state: true },
    _scrub: { state: true },
    _drag: { state: true },
  };

  /** Sorted, unique times; each point's `levels` align with `channels`. */
  declare points: SchedulePoint[];
  declare channels: readonly ChannelDef[];
  declare nowMinutes: number | null;
  /** Accessible name of the program ("Dutch style"). */
  declare label: string;
  declare interactive: boolean;
  /** A short chart without the colour ribbon and the channel legend: a live preview. */
  declare compact: boolean;
  /** Selected point index (editor). */
  declare selected: number;
  /** Time step in minutes for drags and keys. */
  declare snap: number;
  /** The points are the last ones known, not confirmed current. */
  declare stale: boolean;
  /** Fine mode: drags and keys move one minute at a time. */
  declare fine: boolean;
  declare _width: number;
  /** Ids of the channels switched off in the legend. */
  declare _hidden: string[];
  declare _scrub: { minutes: number } | null;
  declare _drag: { kind: "time" | "level"; index: number; channel: number } | null;

  private _layout: ChartLayout = chartLayout(0, false);
  private _geometry: ChannelGeometry[] = [];
  private _ribbon = "";
  private _summary = "";
  private _resize: ResizeObserver | undefined;
  private _observed: Element | null = null;
  private _dragInfo: DragInfo | null = null;
  private _tapStart: (TapRecord & { id: number }) | null = null;
  private _lastTap: TapRecord | null = null;
  private _lastChannel: string | undefined;

  constructor() {
    super();
    this.points = [];
    this.channels = [];
    this.nowMinutes = null;
    this.label = "Schedule";
    this.interactive = false;
    this.compact = false;
    this.selected = -1;
    this.snap = SNAP_MINUTES;
    this.stale = false;
    this.fine = false;
    this._width = 0;
    this._hidden = [];
    this._scrub = null;
    this._drag = null;
  }

  private get _stage(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".stage");
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._resize = new ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      if (width !== this._width) this._width = width;
    });
    if (this.hasUpdated) this._observeStage();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resize?.disconnect();
    this._observed = null;
    window.removeEventListener("keydown", this._onWindowKey, true);
    this._dragInfo = null;
    this._drag = null;
  }

  private _observeStage(): void {
    const stage = this._stage;
    if (stage && stage !== this._observed) {
      this._resize?.observe(stage);
      this._observed = stage;
    }
  }

  protected updated(): void {
    this._observeStage();
  }

  /** Abandon a drag in progress and put the point back where it started (Escape does this too). */
  cancelDrag(): void {
    const drag = this._dragInfo;
    if (!drag) return;
    if (drag.moved) {
      if (drag.kind === "time") this._emit<PointMoveDetail>("point-move", { index: drag.index, minutes: drag.origin, commit: true, step: 1 });
      else this._emit<PointLevelDetail>("point-level", { index: drag.index, channel: drag.channel, value: drag.origin, commit: true });
    }
    this._finishDrag();
  }

  // ---- memoised model ----

  protected willUpdate(changed: PropertyValues<this>): void {
    if (this._width === 0) this._width = Math.round(this.getBoundingClientRect().width);
    const layoutChanged = changed.has("_width") || changed.has("interactive") || changed.has("compact");
    const shapeChanged = changed.has("points") || changed.has("channels");
    if (layoutChanged) this._layout = chartLayout(this._width, this.interactive, this.compact);
    if (layoutChanged || shapeChanged) this._geometry = channelGeometry(this.points, this._layout.box, this.channels);
    if (shapeChanged) this._ribbon = ribbonGradient(ribbonStops(this.points, this.channels));
    if (changed.has("points") || changed.has("label")) this._summary = chartSummary(this.label, this.points);
  }

  private _emit<T>(name: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private _isVisible(channel: ChannelDef): boolean {
    return !this._hidden.includes(channel.id);
  }

  // ---- drawing ----

  private _renderPlot(layout: ChartLayout): TemplateResult {
    const { box } = layout;
    const plotBottom = box.top + box.height;
    const ticks = hourTicks(layout.width);
    const visible = this._geometry.filter((geometry) => this._isVisible(geometry.channel));
    const selectedIndex = this.interactive && this.points[this.selected] ? this.selected : -1;
    const now = this.nowMinutes;
    const scrub = this._scrub;

    const grid = [100, 50, 0].map((value) => {
      const y = valueToY(box, value);
      return svg`<line class=${value === 0 ? "axis" : "gridline"} x1=${box.left} x2=${box.left + box.width} y1=${y} y2=${y}></line>
        <text class="ylabel" x=${box.left - 8} y=${y} dy="0.35em" text-anchor="end">${value}%</text>`;
    });
    const axis = ticks.map((hour) => {
      const x = minutesToX(box, hour * 60);
      return svg`<line class="tick" x1=${x} x2=${x} y1=${plotBottom} y2=${plotBottom + 4}></line>
        <text class="xlabel" x=${x} y=${layout.labelY} text-anchor="middle">${String(hour).padStart(2, "0")}:00</text>`;
    });

    return html`<svg class="plot" width=${layout.width} height=${layout.height} viewBox=${`0 0 ${layout.width} ${layout.height}`} role="img" aria-label=${this._summary}>
      <g class="grid">${grid}${axis}</g>
      ${layout.railY === null ? nothing : svg`<line class="rail" x1=${box.left} x2=${box.left + box.width} y1=${layout.railY} y2=${layout.railY}></line>`}
      ${selectedIndex < 0 ? nothing : this._renderGuide(layout, selectedIndex)}
      <g class="lines ${this.stale ? "stale" : ""}">
        ${visible.map((geometry) => this._renderChannel(geometry, selectedIndex))}
      </g>
      ${now === null ? nothing : this._renderNow(layout, now)}
      ${scrub ? this._renderCrosshair(layout, visible, scrub.minutes) : nothing}
    </svg>`;
  }

  private _renderGuide(layout: ChartLayout, index: number): SVGTemplateResult {
    const x = minutesToX(layout.box, this.points[index]!.minutes);
    return svg`<line class="guide" x1=${x} x2=${x} y1=${layout.box.top} y2=${layout.railY ?? layout.box.top + layout.box.height}></line>`;
  }

  private _renderChannel(geometry: ChannelGeometry, selectedIndex: number): SVGTemplateResult {
    const colour = geometry.channel.colour;
    return svg`${needsHalo(geometry.channel) ? svg`<path class="halo" d=${geometry.path}></path>` : nothing}
      <path class="line" d=${geometry.path} stroke=${colour}></path>
      ${geometry.dots.map((dot) => (dot.index === selectedIndex ? nothing : svg`<circle class="vdot" cx=${dot.x} cy=${dot.y} r="2.5" fill=${colour}></circle>`))}`;
  }

  private _renderNow(layout: ChartLayout, now: number): SVGTemplateResult {
    const { box } = layout;
    const x = minutesToX(box, now);
    const pillX = clamp(x - NOW_PILL.width / 2, 2, layout.width - NOW_PILL.width - 2);
    const pillY = box.top - 12;
    return svg`<line class="now" x1=${x} x2=${x} y1=${pillY + NOW_PILL.height} y2=${box.top + box.height}></line>
      <rect class="now-pill" x=${pillX} y=${pillY} width=${NOW_PILL.width} height=${NOW_PILL.height} rx=${NOW_PILL.height / 2}></rect>
      <text class="now-text" x=${pillX + NOW_PILL.width / 2} y=${pillY + 12.5} text-anchor="middle">Now</text>`;
  }

  private _renderCrosshair(layout: ChartLayout, visible: ChannelGeometry[], minutes: number): SVGTemplateResult {
    const { box } = layout;
    const x = minutesToX(box, minutes);
    const mix = colourAt(this.points, minutes, this.channels.length);
    return svg`<line class="crosshair" x1=${x} x2=${x} y1=${box.top} y2=${box.top + box.height}></line>
      ${visible.map((geometry) => svg`<circle class="cross-dot" cx=${x} cy=${valueToY(box, mix[geometry.index] ?? 0) + geometry.dodge} r="3.5" fill=${geometry.channel.colour}></circle>`)}`;
  }

  private _renderReadout(layout: ChartLayout, minutes: number): TemplateResult {
    const mix = colourAt(this.points, minutes, this.channels.length);
    const x = minutesToX(layout.box, minutes);
    const width = Math.min(readoutWidth(this.channels), layout.width - 8);
    const left = clamp(x - width / 2, 4, Math.max(4, layout.width - width - 4));
    return html`<div class="readout" aria-hidden="true" style=${`width:${width}px;transform:translate(${left}px, ${layout.box.top + 6}px)`}>
      <span class="ro-time">${formatTime(minutes)}</span>
      ${this.channels.map((channel, index) => html`<span class="ro-item"><i class="ro-dot" style=${`background:${channel.colour}`}></i>${channel.short}<b>${mix[index] ?? 0}</b></span>`)}
    </div>`;
  }

  private _renderGrips(layout: ChartLayout): TemplateResult {
    const railY = layout.railY ?? 0;
    const count = this.points.length;
    return html`<div class="grips" @pointerdown=${this._onGripDown} @pointermove=${this._onDragMove} @pointerup=${this._onDragEnd} @pointercancel=${this._onDragEnd} @lostpointercapture=${this._onDragEnd} @keydown=${this._onGripKey}>
      ${this.points.map((point, index) => {
        const { lo, hi } = neighbourBounds(this.points, index);
        const x = minutesToX(layout.box, point.minutes);
        const isSelected = index === this.selected;
        return html`<div class="grip ${isSelected ? "on" : ""} ${this._drag?.kind === "time" && this._drag.index === index ? "drag" : ""}" role="slider" data-index=${index} tabindex=${isSelected ? 0 : -1}
          aria-label=${`Time of point ${index + 1} of ${count}`} aria-orientation="horizontal" aria-valuemin=${lo} aria-valuemax=${hi} aria-valuenow=${point.minutes} aria-valuetext=${formatTime(point.minutes)}
          style=${`transform:translate(${x - GRIP_REACH}px, ${railY - GRIP_REACH}px);z-index:${isSelected ? 2 : 1}`}><span class="knob" style=${`background:${swatchColour(point.levels, this.channels)}`}></span></div>`;
      })}
    </div>`;
  }

  private _renderDots(layout: ChartLayout): TemplateResult | typeof nothing {
    const point = this.points[this.selected];
    if (!this.interactive || !point) return nothing;
    const x = minutesToX(layout.box, point.minutes);
    const dragChannel = this._drag?.kind === "level" ? this._drag.channel : -1;
    return html`<div class="dots" @pointerdown=${this._onDotDown} @pointermove=${this._onDragMove} @pointerup=${this._onDragEnd} @pointercancel=${this._onDragEnd} @lostpointercapture=${this._onDragEnd}>
      ${this._geometry
        .filter((geometry) => this._isVisible(geometry.channel))
        .map((geometry) => {
          const value = point.levels[geometry.index] ?? 0;
          const y = valueToY(layout.box, value) + geometry.dodge;
          const dragging = dragChannel === geometry.index;
          return html`<div class="dot ${dragging ? "drag" : ""}" data-channel=${geometry.index} aria-hidden="true" style=${`transform:translate(${x - DOT_REACH}px, ${y - DOT_REACH}px)`}>
            <span class="dot-visual" style=${`background:${geometry.channel.colour}`}></span>${dragging ? html`<span class="dot-value">${value}%</span>` : nothing}
          </div>`;
        })}
    </div>`;
  }

  private _renderTimeLabel(layout: ChartLayout): TemplateResult | typeof nothing {
    const point = this.points[this.selected];
    if (!this.interactive || !point || layout.railY === null) return nothing;
    const x = clamp(minutesToX(layout.box, point.minutes), 30, layout.width - 30);
    return html`<div class="time-label" aria-hidden="true" style=${`transform:translate(${x}px, ${layout.railY - GRIP_REACH - 2}px) translate(-50%, -100%)`}>${formatTime(point.minutes)}</div>`;
  }

  private _toggleChannel(id: string): void {
    this._hidden = this._hidden.includes(id) ? this._hidden.filter((other) => other !== id) : [...this._hidden, id];
  }

  render() {
    const layout = this._layout;
    const ready = this._width > 0;
    return html`<div class="chart">
      <div class="stage" style=${`height:${layout.height}px`}>
        ${ready
          ? html`${this._renderPlot(layout)}
              <div class="hit" style=${`left:${layout.box.left}px;top:${layout.box.top}px;width:${layout.box.width}px;height:${layout.box.height}px`} @pointerdown=${this._onPlotDown} @pointermove=${this._onPlotMove} @pointerup=${this._onPlotUp} @pointerleave=${this._onPlotLeave} @pointercancel=${this._onPlotLeave}></div>
              ${this.interactive ? this._renderGrips(layout) : nothing}${this._renderDots(layout)}${this._renderTimeLabel(layout)}
              ${this._scrub && !this.interactive ? this._renderReadout(layout, this._scrub.minutes) : nothing}
              ${this.stale ? html`<div class="stale-chip" style=${`left:${layout.box.left + 8}px;top:${layout.box.top + 8}px`}>Last known values</div>` : nothing}`
          : nothing}
      </div>
      ${ready && !this.compact ? html`<div class="ribbon" aria-hidden="true" style=${`margin-left:${layout.box.left}px;width:${layout.box.width}px;background:${this._ribbon}`}></div>` : nothing}
      ${this.compact ? nothing : html`<div class="legend" role="group" aria-label="Channels shown">
        ${this.channels.map((channel) => {
          const on = this._isVisible(channel);
          return html`<button type="button" class="key" aria-pressed=${on ? "true" : "false"} aria-label=${channel.name} @click=${() => this._toggleChannel(channel.id)}>
            <span class="key-chip"><span class="key-dot ${on ? "" : "off"}" style=${`--c:${channel.colour}`}></span><span class="key-short" aria-hidden="true">${channel.short}</span><span class="key-name" aria-hidden="true">${channel.name}</span></span>
          </button>`;
        })}
      </div>`}
    </div>`;
  }

  // ---- read-only scrub, taps and double taps on the plot ----

  private _stageXY(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = this._stage?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
  }

  private _scrubTo(event: PointerEvent): void {
    const at = this._stageXY(event);
    if (!at) return;
    const minutes = scrubMinutes(this._layout.box, at.x);
    if (this._scrub?.minutes !== minutes) this._scrub = { minutes };
  }

  private _onPlotDown = (event: PointerEvent): void => {
    if (this.interactive) this._tapStart = { x: event.clientX, y: event.clientY, t: event.timeStamp, id: event.pointerId };
    else this._scrubTo(event);
  };

  private _onPlotMove = (event: PointerEvent): void => {
    if (!this.interactive) this._scrubTo(event);
  };

  private _onPlotUp = (event: PointerEvent): void => {
    if (!this.interactive) {
      if (event.pointerType !== "mouse") this._scrub = null;
      return;
    }
    const start = this._tapStart;
    this._tapStart = null;
    const at = this._stageXY(event);
    if (!start || !at || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP || event.timeStamp - start.t > TAP_MAX_MS) return;

    const box = this._layout.box;
    const previous = this._lastTap;
    if (previous && event.timeStamp - previous.t < DOUBLE_TAP_MS && Math.hypot(at.x - previous.x, at.y - previous.y) < DOUBLE_TAP_SLOP) {
      this._lastTap = null;
      this._emit<PointAddDetail>("point-add", { minutes: Math.min(LAST_MINUTE, Math.round(xToMinutes(box, at.x))) });
      return;
    }
    this._lastTap = { x: at.x, y: at.y, t: event.timeStamp };
    const index = nearestPointIndex(box, this.points.map((point) => point.minutes), at.x, PLOT_SELECT_REACH, this.selected);
    if (index >= 0 && index !== this.selected) this._emit<PointSelectDetail>("point-select", { index });
  };

  private _onPlotLeave = (): void => {
    this._scrub = null;
    this._tapStart = null;
  };

  // ---- handle drags ----

  private _onGripDown = (event: PointerEvent): void => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>(".grip");
    if (!grip || (event.pointerType === "mouse" && event.button !== 0)) return;
    const at = this._stageXY(event);
    if (!at) return;
    const box = this._layout.box;
    let index = nearestPointIndex(box, this.points.map((point) => point.minutes), at.x, GRIP_REACH, this.selected);
    if (index < 0) index = Number(grip.dataset.index);
    const point = this.points[index];
    if (!point) return;

    const target = this.renderRoot.querySelector<HTMLElement>(`.grip[data-index="${index}"]`) ?? grip;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    target.focus({ preventScroll: true });
    if (index !== this.selected) this._emit<PointSelectDetail>("point-select", { index });
    this._emit("interaction");
    this._beginDrag({
      kind: "time",
      pointerId: event.pointerId,
      index,
      channel: -1,
      origin: point.minutes,
      grab: at.x - minutesToX(box, point.minutes),
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      last: point.minutes,
      step: this.fine ? 1 : this.snap,
      capture: target,
    });
  };

  private _onDotDown = (event: PointerEvent): void => {
    const dot = (event.target as HTMLElement).closest<HTMLElement>(".dot");
    const point = this.points[this.selected];
    if (!dot || !point || (event.pointerType === "mouse" && event.button !== 0)) return;
    const at = this._stageXY(event);
    if (!at) return;
    const box = this._layout.box;
    const handles = this._geometry.filter((geometry) => this._isVisible(geometry.channel)).map((geometry) => ({ field: geometry.channel.id, value: point.levels[geometry.index] ?? 0 }));
    const id = nearestLevelField(box, handles, at.y, DOT_REACH, this._lastChannel);
    const channel = id === null ? Number(dot.dataset.channel) : this.channels.findIndex((candidate) => candidate.id === id);
    const value = point.levels[channel];
    if (value === undefined) return;
    const target = this.renderRoot.querySelector<HTMLElement>(`.dot[data-channel="${channel}"]`) ?? dot;

    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    this._lastChannel = this.channels[channel]?.id;
    this._emit("interaction");
    this._beginDrag({
      kind: "level",
      pointerId: event.pointerId,
      index: this.selected,
      channel,
      origin: value,
      grab: at.y - valueToY(box, value),
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      last: value,
      step: 1,
      capture: target,
    });
  };

  private _beginDrag(info: DragInfo): void {
    this._dragInfo = info;
    this._drag = { kind: info.kind, index: info.index, channel: info.channel };
    window.addEventListener("keydown", this._onWindowKey, true);
    this._emit<DragStateDetail>("drag-state", { dragging: true });
  }

  private _onDragMove = (event: PointerEvent): void => {
    const drag = this._dragInfo;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_SLOP) return;
      drag.moved = true;
    }
    const at = this._stageXY(event);
    if (!at) return;
    const box: PlotBox = this._layout.box;
    if (drag.kind === "time") {
      drag.step = event.shiftKey || this.fine ? 1 : this.snap;
      drag.last = xToMinutes(box, at.x - drag.grab);
      this._emit<PointMoveDetail>("point-move", { index: drag.index, minutes: drag.last, commit: false, step: drag.step });
    } else {
      drag.last = yToValue(box, at.y - drag.grab);
      this._emit<PointLevelDetail>("point-level", { index: drag.index, channel: drag.channel, value: drag.last, commit: false });
    }
  };

  /** pointerup, pointercancel and lostpointercapture all end a drag; only the first one acts. */
  private _onDragEnd = (event: PointerEvent): void => {
    const drag = this._dragInfo;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      if (drag.kind === "time") this._emit<PointMoveDetail>("point-move", { index: drag.index, minutes: drag.last, commit: true, step: drag.step });
      else this._emit<PointLevelDetail>("point-level", { index: drag.index, channel: drag.channel, value: drag.last, commit: true });
    }
    this._finishDrag();
  };

  private _finishDrag(): void {
    const drag = this._dragInfo;
    if (!drag) return;
    this._dragInfo = null;
    this._drag = null;
    window.removeEventListener("keydown", this._onWindowKey, true);
    try {
      drag.capture.releasePointerCapture(drag.pointerId);
    } catch {
      // Capture already released (the pointer went up).
    }
    this._emit<DragStateDetail>("drag-state", { dragging: false });
  }

  /** Escape during a drag cancels it and must not also close the sheet the chart sits in. */
  private _onWindowKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this._dragInfo) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelDrag();
  };

  private _onGripKey = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const grip = (event.target as HTMLElement).closest<HTMLElement>(".grip");
    const index = Number(grip?.dataset.index);
    const point = this.points[index];
    if (!point) return;
    const step = keyStep(event.key, event.shiftKey, point.minutes, this.fine ? 1 : this.snap, neighbourBounds(this.points, index));
    if (!step) return;
    event.preventDefault();
    this._emit("interaction");
    this._emit<PointMoveDetail>("point-move", { index, minutes: step.minutes, commit: true, step: step.step });
  };

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; }
      .chart { container-type: inline-size; container-name: chart; }
      .stage { position: relative; width: 100%; user-select: none; -webkit-user-select: none; }
      .plot { display: block; overflow: visible; pointer-events: none; }
      @media (forced-colors: active) { .plot { forced-color-adjust: none; } }

      .gridline { stroke: var(--lu-well-edge); stroke-width: 1; }
      .axis, .tick { stroke: var(--lu-edge-raised); stroke-width: 1; }
      .ylabel, .xlabel { fill: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1 var(--lu-font); font-variant-numeric: tabular-nums; }
      .rail { stroke: var(--lu-edge-raised); stroke-width: 2; stroke-linecap: round; }
      .guide { stroke: var(--lu-edge-raised); stroke-width: 1; stroke-dasharray: 2 3; }

      .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .halo { fill: none; stroke: var(--lu-shade); stroke-width: 5; stroke-linejoin: round; stroke-linecap: round; }
      .vdot { stroke: var(--lu-shade); stroke-width: 0.75; }
      .lines.stale { opacity: 0.45; }
      .now { stroke: var(--lu-accent); stroke-width: 1.5; }
      .now-pill { fill: var(--lu-accent); }
      .now-text { fill: var(--lu-accent-ink); font: 600 11px/1 var(--lu-font); }
      .crosshair { stroke: var(--lu-ink-2); stroke-width: 1; stroke-dasharray: 3 3; }
      .cross-dot { stroke: var(--lu-card); stroke-width: 1.5; }

      .hit { position: absolute; touch-action: pan-y; cursor: crosshair; }
      :host([interactive]) .hit { cursor: cell; }

      .grips, .dots { position: absolute; inset: 0; pointer-events: none; }
      .grip, .dot { position: absolute; left: 0; top: 0; display: grid; place-items: center; touch-action: none; pointer-events: auto; cursor: grab; }
      .grip { width: 48px; height: 48px; border-radius: 50%; }
      .dot { width: 44px; height: 44px; z-index: 3; }
      .grip.drag, .dot.drag { cursor: grabbing; }
      .knob { display: block; width: 24px; height: 24px; border: 2px solid var(--lu-ink-2); border-radius: 50%; box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
      .grip.on .knob { border-color: var(--lu-accent); box-shadow: 0 0 0 3px var(--lu-accent-soft), var(--lu-shadow-raised); }
      .grip:focus-visible { background-image: none; box-shadow: none; outline: 2px solid transparent; }
      .grip:focus-visible .knob { box-shadow: 0 0 0 4px var(--lu-focus-wash), var(--lu-focus-landing); }
      @media (forced-colors: active) { .knob { border-color: CanvasText; } .grip:focus-visible .knob { outline: 2px solid Highlight; } }
      .dot-visual { display: block; width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 0 2px var(--lu-card), 0 0 0 3px color-mix(in srgb, var(--lu-ink) 38%, transparent); }
      .dot.drag .dot-visual { transform: scale(1.35); }
      .dot-value { position: absolute; left: 50%; bottom: calc(50% + 12px); transform: translateX(-50%); padding: 2px 6px; border-radius: var(--lu-radius-pill); background: linear-gradient(var(--lu-card), var(--lu-card)), var(--lu-canvas); border: 1px solid var(--lu-edge-raised); color: var(--lu-ink); font: 600 var(--lu-type-caption)/1.2 var(--lu-font); font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }

      .time-label, .readout, .stale-chip { position: absolute; left: 0; top: 0; pointer-events: none; color: var(--lu-ink); font: 600 var(--lu-type-caption)/1.2 var(--lu-font); font-variant-numeric: tabular-nums; white-space: nowrap; background: linear-gradient(var(--lu-card), var(--lu-card)), var(--lu-canvas); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-pill); box-shadow: var(--lu-highlight-rest); }
      .time-label { z-index: 4; padding: 3px 10px; }
      .readout { z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--lu-space-2); padding: 4px 12px; border-radius: var(--lu-radius-control); }
      .ro-time { font-weight: 700; }
      .ro-item { display: inline-flex; align-items: center; gap: 3px; color: var(--lu-ink-2); font-weight: 500; }
      .ro-item b { color: var(--lu-ink); font-weight: 600; }
      .ro-dot { display: block; width: 6px; height: 6px; margin-right: 1px; border-radius: 50%; box-shadow: 0 0 0 1px color-mix(in srgb, var(--lu-ink) 30%, transparent); }
      .stale-chip { z-index: 4; padding: 3px 10px; color: var(--lu-ink-2); font-weight: 500; }

      .ribbon { height: 10px; margin-top: var(--lu-space-1); border-radius: var(--lu-radius-pill); box-shadow: inset 0 0 0 1px var(--lu-well-edge); }

      .legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 0 var(--lu-space-1); margin-top: var(--lu-space-1); }
      .key { display: inline-grid; place-items: center; min-width: var(--lu-target); min-height: var(--lu-target); padding: 8px 2px; border: 0; background: none; cursor: pointer; }
      .key:focus-visible { background-image: none; box-shadow: none; outline: 2px solid transparent; }
      .key-chip { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); font: 500 var(--lu-type-caption)/1 var(--lu-font); transition: background-color var(--lu-motion-focus) var(--lu-ease); }
      .key:hover .key-chip { background-color: var(--lu-hover-wash); }
      .key[aria-pressed="true"] .key-chip { color: var(--lu-ink); background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised); }
      .key[aria-pressed="false"] .key-chip { border-style: dashed; }
      .key:focus-visible .key-chip { background-image: linear-gradient(var(--lu-focus-wash), var(--lu-focus-wash)); box-shadow: var(--lu-focus-landing); }
      @media (forced-colors: active) { .key-chip { border-color: ButtonText; } .key:focus-visible .key-chip { outline: 2px solid Highlight; } }
      .key-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lu-ink) 30%, transparent); }
      .key-dot.off { background: transparent; box-shadow: inset 0 0 0 2px var(--c), 0 0 0 1px color-mix(in srgb, var(--lu-ink) 20%, transparent); }
      .key-short { font-weight: 600; }
      @container chart (max-width: 459px) { .key-name { display: none; } .key-chip { padding: 0 10px; } }
    `,
  ];
}

customElements.define("aquarium-schedule-chart", AquariumScheduleChart);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-schedule-chart": AquariumScheduleChart;
  }
}

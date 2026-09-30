/** Everything the schedule chart computes from `points`, its channels and its measured width,
 * kept pure so the component only draws: layout, one path per channel (with the vertical dodge),
 * the colour ribbon, scrub positions, the keyboard stepping of a time grip and the text
 * alternative. Channel-generic: Pawfly has four, a Fluval five, and nothing here knows which. */

import { clamp, swatchColour, type ChannelDef } from "./channels.ts";
import { minutesToX, pathFromVertices, valueToY, xToMinutes, type PlotBox } from "./chart-geometry.ts";
import { channelVertices, colourAt, dayColourStops, MINUTES_PER_DAY } from "./curve.ts";
import { formatTime, LAST_MINUTE, type SchedulePoint } from "./points.ts";

export const CHART_MIN_HEIGHT = 180;
export const CHART_MAX_HEIGHT = 300;
/** The compact chart (a live preview that stays in view while something else is edited). */
export const COMPACT_MIN_HEIGHT = 112;
export const COMPACT_MAX_HEIGHT = 150;
/** Height of the timeline rail the point grips sit on (editor only). */
export const RAIL_HEIGHT = 40;

/** Room around the plot for the y labels (left), the wrap-around line ends and the last hour
 * label (right), the "Now" pill and the top dodge (top) and the hour labels (bottom). */
const MARGIN = { left: 40, right: 20, top: 14, bottom: 28 } as const;

export interface ChartLayout {
  width: number;
  /** Drawing height: plot, hour labels and, in the editor, the rail. */
  height: number;
  box: PlotBox;
  /** Centre line of the grip rail; null when the chart is read-only. */
  railY: number | null;
  /** Text baseline of the hour labels. */
  labelY: number;
}

/** About half the width, kept between 180 and 300 px so it is neither a sliver nor a wall; a
 * compact chart is about a third of it, between 112 and 150 px. */
export function chartHeight(width: number, compact = false): number {
  return compact ? Math.round(clamp(width * 0.3, COMPACT_MIN_HEIGHT, COMPACT_MAX_HEIGHT)) : Math.round(clamp(width * 0.5, CHART_MIN_HEIGHT, CHART_MAX_HEIGHT));
}

export function chartLayout(width: number, interactive: boolean, compact = false): ChartLayout {
  const base = chartHeight(width, compact);
  const plotHeight = base - MARGIN.top - MARGIN.bottom;
  const plotBottom = MARGIN.top + plotHeight;
  const rail = interactive ? RAIL_HEIGHT : 0;
  return {
    width,
    height: base + rail,
    box: { left: MARGIN.left, top: MARGIN.top, width: Math.max(1, width - MARGIN.left - MARGIN.right), height: plotHeight },
    railY: interactive ? plotBottom + RAIL_HEIGHT / 2 : null,
    labelY: plotBottom + rail + 18,
  };
}

/** Channels at the same level would draw on top of each other and only the last would show, so
 * each is nudged by this many px from its neighbour. Purely cosmetic: hit-testing, the level
 * dots' values and the data all use the true value. */
export const DODGE_PX = 1.25;

/** Vertical nudge for channel `index` of `count`: symmetric around the true value. */
export function channelDodge(index: number, count: number): number {
  return (index - (count - 1) / 2) * DODGE_PX;
}

export interface VertexDot {
  index: number;
  x: number;
  y: number;
}

export interface ChannelGeometry {
  channel: ChannelDef;
  /** Position in the light's channel list (the index into every point's `levels`). */
  index: number;
  dodge: number;
  /** The channel across the whole day, wrap included: straight segments ARE the curve. */
  path: string;
  /** One dot per point. */
  dots: VertexDot[];
}

/** One line per channel, in the light's own channel order. */
export function channelGeometry(points: readonly SchedulePoint[], box: PlotBox, channels: readonly ChannelDef[]): ChannelGeometry[] {
  return channels.map((channel, index) => {
    const dodge = channelDodge(index, channels.length);
    return {
      channel,
      index,
      dodge,
      path: pathFromVertices(box, channelVertices(points, index), dodge),
      dots: points.map((point, i) => ({ index: i, x: minutesToX(box, point.minutes), y: valueToY(box, point.levels[index] ?? 0) + dodge })),
    };
  });
}

/** Relative luminance (0-1) of a `#rgb`, `#rrggbb` or `rgb(r, g, b)` colour; 0.5 when unreadable. */
function luminance(colour: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  let rgb: number[] | null = null;
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join("") : hex[1]!;
    rgb = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  } else {
    const parts = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(colour.trim());
    if (parts) rgb = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  }
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A near-white channel line vanishes on a light theme, so it is drawn over a darker halo. */
export function needsHalo(channel: ChannelDef): boolean {
  return luminance(channel.colour) > 0.6;
}

export interface RibbonStop {
  /** 0-1 across the day. */
  offset: number;
  colour: string;
}

/** The mix across the day as gradient stops: every 30 minutes plus every point, so a sharp
 * 15-minute ramp is not smoothed away. Colours come from the light mix itself (`swatchColour`).
 * Points that share a minute are a step (the light switches at once): that minute gets two stops,
 * the colour arriving and the colour leaving, so the ribbon shows a hard edge, not a fade. */
export function ribbonStops(points: readonly SchedulePoint[], channels: readonly ChannelDef[]): RibbonStop[] {
  const minutes = new Set<number>(dayColourStops(points, channels.length, 30).map((stop) => stop.minutes));
  for (const point of points) minutes.add(point.minutes);
  const stops: RibbonStop[] = [];
  for (const minute of [...minutes].sort((a, b) => a - b)) {
    const offset = minute / MINUTES_PER_DAY;
    const leaving = swatchColour(colourAt(points, minute, channels.length), channels);
    const firstHere = points.find((point) => point.minutes === minute);
    const arriving = firstHere ? swatchColour(firstHere.levels, channels) : leaving;
    if (arriving !== leaving) stops.push({ offset, colour: arriving });
    stops.push({ offset, colour: leaving });
  }
  return stops;
}

export function ribbonGradient(stops: readonly RibbonStop[]): string {
  return `linear-gradient(to right, ${stops.map((stop) => `${stop.colour} ${(stop.offset * 100).toFixed(2)}%`).join(", ")})`;
}

/** Whole minute under a scrubbing pointer. The day's right edge is 24:00, which is not a time of
 * day, so it reads as the last minute (23:59). */
export function scrubMinutes(box: PlotBox, x: number): number {
  return Math.min(LAST_MINUTE, Math.round(xToMinutes(box, x)));
}

/** Width of the scrub readout chip, so it can be kept inside the chart without measuring it:
 * the time, then one "dot, letters, value" item per channel. Capped by the caller at the chart
 * width; the items wrap onto a second row when the cap bites. */
export function readoutWidth(channels: readonly ChannelDef[]): number {
  return 54 + channels.reduce((total, channel) => total + 34 + 7 * channel.short.length, 0);
}

export function pointCountLabel(count: number): string {
  return `${count} ${count === 1 ? "point" : "points"}`;
}

/** The chart's text alternative: "Dutch style: 10 points from 06:00 to 22:00". `points` sorted. */
export function chartSummary(label: string, points: readonly SchedulePoint[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return `${label}: no points`;
  if (points.length === 1) return `${label}: 1 point at ${formatTime(first.minutes)}`;
  return `${label}: ${pointCountLabel(points.length)} from ${formatTime(first.minutes)} to ${formatTime(last.minutes)}`;
}

export interface KeyStep {
  /** Where the point should go (the editor snaps and holds it between its neighbours). */
  minutes: number;
  /** The grid to snap `minutes` to. */
  step: number;
}

/** What a key does to a focused time grip, or null when it does nothing there. Left/Right move by
 * `snap` (Shift: one minute), Page keys by an hour, Home/End go to the earliest/latest minute the
 * neighbours allow. Up/Down are deliberately unhandled: levels belong to the sliders. */
export function keyStep(key: string, shift: boolean, current: number, snap: number, bounds: { lo: number; hi: number }): KeyStep | null {
  switch (key) {
    case "ArrowLeft":
      return { minutes: current - (shift ? 1 : snap), step: shift ? 1 : snap };
    case "ArrowRight":
      return { minutes: current + (shift ? 1 : snap), step: shift ? 1 : snap };
    case "PageDown":
      return { minutes: current - 60, step: snap };
    case "PageUp":
      return { minutes: current + 60, step: snap };
    case "Home":
      return { minutes: bounds.lo, step: 1 };
    case "End":
      return { minutes: bounds.hi, step: 1 };
    default:
      return null;
  }
}

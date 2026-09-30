/** Schedule curve maths: what a program looks like across a 24 h day, for any number of channels.
 *
 * MODEL (verified on the real Pawfly light with a manipulated clock): between two points the
 * light fades LINEARLY, and the day wraps, so the segment after the last point runs into the
 * first point of the next day. `valueAt` is the only place that encodes this; the chart, ribbon
 * and point insertion all read the curve through it.
 */

import { clampPercent, type Levels } from "./channels.ts";
import type { SchedulePoint } from "./points.ts";

export const MINUTES_PER_DAY = 1440;

/** Level of channel `channel` at `minute` (any integer; wrapped into the day). `points` must be
 * sorted by minute with unique times. No points is a dark day; one point holds its level all day. */
export function valueAt(points: readonly SchedulePoint[], minute: number, channel: number): number {
  const count = points.length;
  if (count === 0) return 0;
  if (count === 1) return points[0]!.levels[channel] ?? 0;

  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  let previousIndex = -1;
  for (let i = 0; i < count; i++) {
    if (points[i]!.minutes <= m) previousIndex = i;
    else break;
  }

  const last = points[count - 1]!;
  const first = points[0]!;
  let from: { minutes: number; value: number };
  let to: { minutes: number; value: number };
  if (previousIndex === -1) {
    from = { minutes: last.minutes - MINUTES_PER_DAY, value: last.levels[channel] ?? 0 };
    to = { minutes: first.minutes, value: first.levels[channel] ?? 0 };
  } else if (previousIndex === count - 1) {
    from = { minutes: last.minutes, value: last.levels[channel] ?? 0 };
    to = { minutes: first.minutes + MINUTES_PER_DAY, value: first.levels[channel] ?? 0 };
  } else {
    const a = points[previousIndex]!;
    const b = points[previousIndex + 1]!;
    from = { minutes: a.minutes, value: a.levels[channel] ?? 0 };
    to = { minutes: b.minutes, value: b.levels[channel] ?? 0 };
  }
  const t = (m - from.minutes) / (to.minutes - from.minutes);
  return from.value + (to.value - from.value) * t;
}

/** All channels at `minute`, rounded to whole percent. `channelCount` is needed only when there
 * are no points to read it from. */
export function colourAt(points: readonly SchedulePoint[], minute: number, channelCount = points[0]?.levels.length ?? 0): number[] {
  return Array.from({ length: channelCount }, (_, channel) => clampPercent(valueAt(points, minute, channel)));
}

export interface Vertex {
  minutes: number;
  value: number;
}

/** Polyline vertices for one channel across the day: the day's edges (where the curve enters and
 * leaves through the wrap) plus every point. Straight segments between them ARE the curve. */
export function channelVertices(points: readonly SchedulePoint[], channel: number): Vertex[] {
  if (points.length === 0) {
    return [
      { minutes: 0, value: 0 },
      { minutes: MINUTES_PER_DAY, value: 0 },
    ];
  }
  const vertices: Vertex[] = [];
  const edge = valueAt(points, 0, channel);
  if (points[0]!.minutes > 0) vertices.push({ minutes: 0, value: edge });
  for (const point of points) vertices.push({ minutes: point.minutes, value: point.levels[channel] ?? 0 });
  vertices.push({ minutes: MINUTES_PER_DAY, value: edge });
  return vertices;
}

export interface ColourStop {
  minutes: number;
  levels: Levels;
}

/** The mix sampled across the day, for the colour ribbon under the chart. */
export function dayColourStops(points: readonly SchedulePoint[], channelCount: number, stepMinutes = 30): ColourStop[] {
  const stops: ColourStop[] = [];
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += stepMinutes) {
    stops.push({ minutes, levels: colourAt(points, minutes, channelCount) });
  }
  stops.push({ minutes: MINUTES_PER_DAY, levels: colourAt(points, 0, channelCount) });
  return stops;
}

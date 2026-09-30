/** Plot geometry for the 24 h schedule chart: the one place minutes/percent become pixels and
 * back, so drawn lines, drag handles and hit-testing can never disagree. Pure. */

import { clamp } from "./channels.ts";
import { MINUTES_PER_DAY, type Vertex } from "./curve.ts";

export interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function minutesToX(box: PlotBox, minutes: number): number {
  return box.left + (clamp(minutes, 0, MINUTES_PER_DAY) / MINUTES_PER_DAY) * box.width;
}

/** Fractional minutes at pixel `x`, clamped to the day. */
export function xToMinutes(box: PlotBox, x: number): number {
  return clamp(((x - box.left) / box.width) * MINUTES_PER_DAY, 0, MINUTES_PER_DAY);
}

/** Percent (0 at the bottom edge, 100 at the top edge) to pixel `y`. */
export function valueToY(box: PlotBox, value: number): number {
  return box.top + box.height - (clamp(value, 0, 100) / 100) * box.height;
}

/** Whole percent at pixel `y`, clamped to 0-100. */
export function yToValue(box: PlotBox, y: number): number {
  return Math.round(clamp(((box.top + box.height - y) / box.height) * 100, 0, 100));
}

export function pathFromVertices(box: PlotBox, vertices: readonly Vertex[], yOffset = 0): string {
  return vertices
    .map((vertex, i) => `${i === 0 ? "M" : "L"}${minutesToX(box, vertex.minutes).toFixed(1)} ${(valueToY(box, vertex.value) + yOffset).toFixed(1)}`)
    .join(" ");
}

/** Hours to label on the x axis for a chart `width` px wide: every 6 h when narrow, 3 h when wide. */
export function hourTicks(width: number): number[] {
  const step = width >= 520 ? 3 : 6;
  const ticks: number[] = [];
  for (let hour = 0; hour <= 24; hour += step) ticks.push(hour);
  return ticks;
}

/** Index of the point whose x is nearest `x` within `maxDistance` px. On a tie (points closer
 * together than a finger) the `prefer` index wins, so an already-selected point stays grabbable. */
export function nearestPointIndex(box: PlotBox, minutesList: readonly number[], x: number, maxDistance: number, prefer = -1): number {
  let best = -1;
  let bestDistance = Infinity;
  minutesList.forEach((minutes, index) => {
    const distance = Math.abs(minutesToX(box, minutes) - x);
    if (distance > maxDistance) return;
    if (distance < bestDistance - 0.5 || (Math.abs(distance - bestDistance) <= 0.5 && index === prefer)) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

export interface LevelHandle {
  field: string;
  value: number;
}

/** Which channel dot a touch at pixel `y` grabs. Dots at the same level overlap; the
 * `preferField` (the last one used) wins ties, then the first in channel order. */
export function nearestLevelField(box: PlotBox, handles: readonly LevelHandle[], y: number, maxDistance: number, preferField?: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const handle of handles) {
    const distance = Math.abs(valueToY(box, handle.value) - y);
    if (distance > maxDistance) continue;
    const better = distance < bestDistance - 0.5 || (Math.abs(distance - bestDistance) <= 0.5 && handle.field === preferField);
    if (better) {
      best = handle.field;
      bestDistance = distance;
    }
  }
  return best;
}

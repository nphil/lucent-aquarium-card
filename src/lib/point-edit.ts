/** Editor operations on a draft that `points.ts` does not cover: typed times (which may pass a
 * neighbour and re-sort), putting a deleted point back, and where the selection starts. Pure. */

import { formatTime, LAST_MINUTE, parseTime, sortPoints, type Insertion, type SchedulePoint } from "./points.ts";

/** Minutes for what a person typed in the time field: "7:15", "07:15", "715", "0715", "7.15",
 * "7 15" or a bare hour ("7", "19"). null when it is not a 24-hour time of day. */
export function parseTypedTime(text: string): number | null {
  const typed = text.trim();
  const exact = parseTime(typed);
  if (exact !== null) return exact;
  const match = /^(\d{1,2})[.\s](\d{2})$/.exec(typed) ?? /^(\d{1,2})(\d{2})$/.exec(typed) ?? /^(\d{1,2})()$/.exec(typed);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

export type TimeEdit = { ok: true; points: SchedulePoint[]; index: number } | { ok: false; error: string };

/** Set point `index` to exactly `minutes` (a typed time). Unlike a drag it may jump past a
 * neighbour: the list is re-sorted and `index` follows the point. A time another point already
 * has is refused with a message and the draft is left as it was. */
export function setPointTime(points: readonly SchedulePoint[], index: number, minutes: number): TimeEdit {
  const point = points[index];
  if (!point) return { ok: false, error: "Select a point first." };
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > LAST_MINUTE) return { ok: false, error: "Choose a time between 00:00 and 23:59." };
  if (minutes === point.minutes) return { ok: true, points: points as SchedulePoint[], index };
  if (points.some((other, i) => i !== index && other.minutes === minutes)) return { ok: false, error: `${formatTime(minutes)} is already used` };
  const moved: SchedulePoint = { ...point, minutes };
  const next = sortPoints(points.map((other, i) => (i === index ? moved : other)));
  return { ok: true, points: next, index: next.indexOf(moved) };
}

/** Nearest unused minute to `wanted`, searching outwards (later before earlier on a tie). */
function nearestFreeMinute(used: ReadonlySet<number>, wanted: number): number {
  for (let offset = 0; offset <= LAST_MINUTE; offset++) {
    for (const candidate of offset === 0 ? [wanted] : [wanted + offset, wanted - offset]) {
      if (candidate >= 0 && candidate <= LAST_MINUTE && !used.has(candidate)) return candidate;
    }
  }
  return wanted;
}

/** Put a deleted point back on the current draft (Undo). It returns to its own time when that is
 * still free, otherwise to the nearest free minute; null when the program is already full. */
export function restorePoint(points: readonly SchedulePoint[], removed: SchedulePoint, max: number): Insertion | null {
  if (points.length >= max) return null;
  const minutes = nearestFreeMinute(new Set(points.map((point) => point.minutes)), removed.minutes);
  const restored: SchedulePoint = { ...removed, minutes };
  const next = sortPoints([...points, restored]);
  return { points: next, index: next.indexOf(restored) };
}

/** Where the editor starts: the point with the most light, so the level dots open spread out
 * instead of stacked on the floor of a dark first point. -1 for an empty draft. */
export function brightestPoint(points: readonly SchedulePoint[]): number {
  let best = -1;
  let bestTotal = -1;
  points.forEach((point, index) => {
    const total = point.levels.reduce((sum, level) => sum + level, 0);
    if (total > bestTotal) {
      best = index;
      bestTotal = total;
    }
  });
  return best;
}

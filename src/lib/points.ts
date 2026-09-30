/** The schedule point model and every rule the editor enforces on it. Pure.
 *
 * A point is a time of day (whole minutes, 0-1439) and one level per channel in device percent.
 * The editor keeps its working list sorted with unique times at every step, so neighbours never
 * cross while a point is dragged and what the user sees is exactly what is uploaded.
 */

import { clampPercent, type Levels } from "./channels.ts";
import { colourAt, MINUTES_PER_DAY } from "./curve.ts";

export const LAST_MINUTE = MINUTES_PER_DAY - 1;
/** Drag/keyboard time step. The light accepts any minute; 15 keeps a drag calm, and holding
 * Shift on the keyboard steps a single minute. */
export const SNAP_MINUTES = 15;

export interface SchedulePoint {
  minutes: number;
  /** One level per channel, percent. */
  levels: Levels;
}

export function formatTime(minutes: number): string {
  const m = Math.min(LAST_MINUTE, Math.max(0, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "7:05" / "07:05" -> minutes; null when it is not a 24 h time of day. */
export function parseTime(text: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function snapMinutes(minutes: number, step = SNAP_MINUTES): number {
  const latest = Math.floor(LAST_MINUTE / step) * step;
  return Math.min(latest, Math.max(0, Math.round(minutes / step) * step));
}

export function sortPoints(points: readonly SchedulePoint[]): SchedulePoint[] {
  return [...points].sort((a, b) => a.minutes - b.minutes);
}

export function pointsEqual(a: readonly SchedulePoint[], b: readonly SchedulePoint[]): boolean {
  return (
    a.length === b.length &&
    a.every((point, i) => {
      const other = b[i]!;
      return point.minutes === other.minutes && point.levels.length === other.levels.length && point.levels.every((level, c) => level === other.levels[c]);
    })
  );
}

export type PointIssueCode = "empty" | "too_many" | "bad_time" | "duplicate_time" | "bad_level";

export interface PointIssue {
  code: PointIssueCode;
  /** Offending point, when the issue is about one. */
  index?: number;
  message: string;
}

/** Everything that would make the light reject an upload, worded for the person editing. */
export function validatePoints(points: readonly SchedulePoint[], max: number, channelCount?: number): PointIssue[] {
  const issues: PointIssue[] = [];
  if (points.length === 0) issues.push({ code: "empty", message: "Add at least one point." });
  if (points.length > max) issues.push({ code: "too_many", message: `A program holds at most ${max} points.` });
  const seen = new Set<number>();
  points.forEach((point, index) => {
    if (!Number.isInteger(point.minutes) || point.minutes < 0 || point.minutes > LAST_MINUTE) {
      issues.push({ code: "bad_time", index, message: `Point ${index + 1} has a time outside the day.` });
    } else if (seen.has(point.minutes)) {
      issues.push({ code: "duplicate_time", index, message: `Two points share ${formatTime(point.minutes)}.` });
    } else {
      seen.add(point.minutes);
    }
    const wrongCount = channelCount !== undefined && point.levels.length !== channelCount;
    if (wrongCount || point.levels.some((value) => !Number.isInteger(value) || value < 0 || value > 100)) {
      issues.push({ code: "bad_level", index, message: `Point ${index + 1} has a level outside 0-100.` });
    }
  });
  return issues;
}

/** Earliest and latest minute point `index` may occupy without touching a neighbour. */
export function neighbourBounds(points: readonly SchedulePoint[], index: number): { lo: number; hi: number } {
  const previous = points[index - 1];
  const next = points[index + 1];
  return { lo: previous ? previous.minutes + 1 : 0, hi: next ? next.minutes - 1 : LAST_MINUTE };
}

/** Move point `index` to `target` minutes, snapped to `step` and held between its neighbours so
 * the list stays sorted and unique. Returns the same array when nothing changes. */
export function movePointTo(points: readonly SchedulePoint[], index: number, target: number, step = SNAP_MINUTES): SchedulePoint[] {
  const point = points[index];
  if (!point) return [...points];
  const { lo, hi } = neighbourBounds(points, index);
  const minutes = Math.min(hi, Math.max(lo, snapMinutes(target, step)));
  if (minutes === point.minutes) return points as SchedulePoint[];
  return points.map((p, i) => (i === index ? { ...p, minutes } : p));
}

/** Set one channel of one point (whole percent, clamped). Same array when nothing changes. */
export function setPointLevel(points: readonly SchedulePoint[], index: number, channel: number, value: number): SchedulePoint[] {
  const point = points[index];
  const level = clampPercent(value);
  if (!point || point.levels[channel] === level) return points as SchedulePoint[];
  const levels = point.levels.map((l, c) => (c === channel ? level : l));
  return points.map((p, i) => (i === index ? { ...p, levels } : p));
}

/** Nearest unused time on the `step` grid to `preferred` (circular over the day). */
function freeSlotNear(used: ReadonlySet<number>, preferred: number, step: number): number {
  const wanted = ((Math.round(preferred / step) * step) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  for (let offset = 0; offset <= MINUTES_PER_DAY / 2; offset += step) {
    for (const candidate of offset === 0 ? [wanted] : [wanted + offset, wanted - offset]) {
      const minute = ((candidate % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      if (!used.has(minute)) return minute;
    }
  }
  for (let minute = 0; minute <= LAST_MINUTE; minute++) if (!used.has(minute)) return minute;
  return wanted;
}

/** Middle of the widest gap between points (the wrap past midnight counts as a gap). */
function widestGapMiddle(sorted: readonly SchedulePoint[]): number {
  if (sorted.length === 0) return 12 * 60;
  let bestStart = sorted[0]!.minutes;
  let bestGap = -1;
  sorted.forEach((point, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1]!.minutes : sorted[0]!.minutes + MINUTES_PER_DAY;
    if (end - point.minutes > bestGap) {
      bestGap = end - point.minutes;
      bestStart = point.minutes;
    }
  });
  return bestStart + bestGap / 2;
}

export interface Insertion {
  points: SchedulePoint[];
  index: number;
}

export interface InsertOptions {
  /** Preferred time; the nearest free slot is used. Default: the middle of the widest gap. */
  at?: number;
  /** Most points a program may hold. */
  max: number;
  step?: number;
  /** Channels per point; read from the existing points when omitted. */
  channelCount?: number;
}

/** Add a point on a free time, coloured as the curve already is there so adding a point never
 * changes the light. null when the program is full. */
export function insertPoint(points: readonly SchedulePoint[], options: InsertOptions): Insertion | null {
  const { max, step = SNAP_MINUTES } = options;
  if (points.length >= max) return null;
  const sorted = sortPoints(points);
  const used = new Set(sorted.map((point) => point.minutes));
  const minutes = freeSlotNear(used, options.at ?? widestGapMiddle(sorted), step);
  const count = options.channelCount ?? sorted[0]?.levels.length ?? 0;
  const inserted: SchedulePoint = { minutes, levels: sorted.length === 0 ? new Array<number>(count).fill(50) : colourAt(sorted, minutes, count) };
  const next = sortPoints([...sorted, inserted]);
  return { points: next, index: next.findIndex((point) => point.minutes === minutes) };
}

/** Remove point `index`; the selection moves to the point that took its place. */
export function removePoint(points: readonly SchedulePoint[], index: number): Insertion {
  const next = points.filter((_, i) => i !== index);
  return { points: next, index: Math.min(index, next.length - 1) };
}

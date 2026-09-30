import { test } from "node:test";
import assert from "node:assert/strict";
import { colourAt } from "../src/lib/curve.ts";
import {
  formatTime,
  insertPoint,
  movePointTo,
  neighbourBounds,
  parseTime,
  pointsEqual,
  removePoint,
  setPointLevel,
  snapMinutes,
  validatePoints,
  type SchedulePoint,
} from "../src/lib/points.ts";
import { defaultDiyPoints } from "../src/adapters/pawfly-data.ts";

const MAX = 12;
/** A four-channel point with the same level on every channel. */
const at = (hour: number, minute: number, level = 0): SchedulePoint => ({ minutes: hour * 60 + minute, levels: [level, level, level, level] });

test("times format and parse as 24 h clock times", () => {
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(7 * 60 + 5), "07:05");
  assert.equal(formatTime(1439), "23:59");
  assert.equal(parseTime("7:05"), 425);
  assert.equal(parseTime(" 23:59 "), 1439);
  assert.equal(parseTime("07:05:00"), 425);
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("12:60"), null);
  assert.equal(parseTime("noon"), null);
});

test("snapping lands on the grid and stays inside the day", () => {
  assert.equal(snapMinutes(7 * 60 + 7), 7 * 60);
  assert.equal(snapMinutes(7 * 60 + 8), 7 * 60 + 15);
  assert.equal(snapMinutes(1439), 1425);
  assert.equal(snapMinutes(-40), 0);
  assert.equal(snapMinutes(429, 1), 429);
});

test("validation reports everything a light would reject", () => {
  assert.deepEqual(validatePoints([at(8, 0, 10), at(9, 0, 20)], MAX, 4), []);
  assert.equal(validatePoints([], MAX)[0]!.code, "empty");
  const many = Array.from({ length: MAX + 1 }, (_, i) => at(i, 0));
  assert.ok(validatePoints(many, MAX).some((issue) => issue.code === "too_many"));
  const dup = validatePoints([at(8, 0), at(8, 0)], MAX);
  assert.deepEqual(dup.map((issue) => [issue.code, issue.index]), [["duplicate_time", 1]]);
  assert.match(dup[0]!.message, /08:00/);
  assert.ok(validatePoints([{ minutes: 100, levels: [101, 0, 0, 0] }], MAX).some((issue) => issue.code === "bad_level"));
  assert.ok(validatePoints([{ minutes: 1440, levels: [0, 0, 0, 0] }], MAX).some((issue) => issue.code === "bad_time"));
  assert.ok(validatePoints([{ minutes: 100, levels: [0, 0, 0] }], MAX, 4).some((issue) => issue.code === "bad_level"), "wrong channel count");
});

test("a dragged point snaps to the grid and never crosses or touches its neighbours", () => {
  const points = [at(6, 0), at(8, 0), at(10, 0)];
  assert.equal(movePointTo(points, 1, 8 * 60 + 40)[1]!.minutes, 8 * 60 + 45);
  // Dragged far past the next point: stops one minute before it; the order is untouched.
  assert.deepEqual(movePointTo(points, 1, 12 * 60).map((p) => p.minutes), [360, 599, 600]);
  // Dragged before the previous point: stops one minute after it.
  assert.deepEqual(movePointTo(points, 1, 4 * 60).map((p) => p.minutes), [360, 361, 600]);
  // The first and last points are held by the day's edges (the last grid slot is 23:45).
  assert.equal(movePointTo(points, 0, -300)[0]!.minutes, 0);
  assert.equal(movePointTo(points, 2, 2000)[2]!.minutes, 1425);
});

test("moving a point to where it already is returns the same list", () => {
  const points = [at(6, 0), at(8, 0)];
  assert.equal(movePointTo(points, 1, 8 * 60 + 2), points);
});

test("one-minute steps work between tight neighbours", () => {
  const points = [at(7, 0), at(7, 5), at(7, 10)];
  assert.deepEqual(neighbourBounds(points, 1), { lo: 7 * 60 + 1, hi: 7 * 60 + 9 });
  assert.equal(movePointTo(points, 1, 7 * 60 + 8, 1)[1]!.minutes, 7 * 60 + 8);
});

test("levels clamp to whole percent, touch one channel, and unchanged levels keep identity", () => {
  const points = [at(6, 0, 10)];
  assert.deepEqual(setPointLevel(points, 0, 1, 250)[0]!.levels, [10, 100, 10, 10]);
  assert.deepEqual(setPointLevel(points, 0, 3, -3)[0]!.levels, [10, 10, 10, 0]);
  assert.equal(setPointLevel(points, 0, 0, 10), points);
  assert.deepEqual(points[0]!.levels, [10, 10, 10, 10], "the input is not mutated");
});

test("a new point goes into the widest gap (the wrap past midnight counts), coloured as the curve already is there", () => {
  const points = [at(12, 0, 0), at(14, 0, 50), at(23, 0, 100)];
  const result = insertPoint(points, { max: MAX })!;
  // The widest gap is 23:00 -> 12:00 next day (13 h); its middle is 05:30 the next morning.
  assert.deepEqual(result.points.map((p) => p.minutes), [330, 720, 840, 1380]);
  assert.equal(result.index, 0);
  // Adding a point must not change the light: 05:30 is halfway from 100 (23:00) down to 0 (12:00).
  assert.deepEqual(colourAt(points, 330), [50, 50, 50, 50]);
  assert.deepEqual(result.points[0], { minutes: 330, levels: [50, 50, 50, 50] });
});

test("a point added at a requested time lands on the nearest free slot", () => {
  const points = [at(8, 0, 10), at(9, 0, 20)];
  const result = insertPoint(points, { at: 8 * 60 + 2, max: MAX })!;
  assert.deepEqual(result.points.map((p) => p.minutes), [480, 495, 540]);
  assert.equal(result.index, 1);
  assert.deepEqual(insertPoint([], { max: MAX, channelCount: 5 })!.points, [{ minutes: 720, levels: [50, 50, 50, 50, 50] }]);
});

test("a full program refuses another point", () => {
  const full = Array.from({ length: MAX }, (_, i) => at(i * 2, 0));
  assert.equal(insertPoint(full, { max: MAX }), null);
});

test("deleting a point moves the selection to its successor, or the new last point", () => {
  const points = [at(6, 0), at(8, 0), at(10, 0)];
  assert.deepEqual(removePoint(points, 1), { points: [points[0], points[2]], index: 1 });
  assert.equal(removePoint(points, 2).index, 1);
  assert.deepEqual(removePoint([at(6, 0)], 0), { points: [], index: -1 });
});

test("pointsEqual compares every level", () => {
  const a = [at(6, 0, 10)];
  assert.ok(pointsEqual(a, [at(6, 0, 10)]));
  assert.ok(!pointsEqual(a, [{ ...at(6, 0, 10), levels: [10, 10, 10, 11] }]));
  assert.ok(!pointsEqual(a, []));
});

test("the Pawfly starter program is valid and starts and ends dark", () => {
  const points = defaultDiyPoints();
  assert.deepEqual(validatePoints(points, MAX, 4), []);
  assert.deepEqual(points[0]!.levels, [0, 0, 0, 0]);
  assert.deepEqual(points.at(-1)!.levels, [0, 0, 0, 0]);
});

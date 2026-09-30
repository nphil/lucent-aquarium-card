import { test } from "node:test";
import assert from "node:assert/strict";
import { channelVertices, colourAt, dayColourStops, valueAt } from "../src/lib/curve.ts";
import type { SchedulePoint } from "../src/lib/points.ts";

const point = (hour: number, minute: number, ...levels: number[]): SchedulePoint => ({ minutes: hour * 60 + minute, levels });
/** A four-channel point with the same level everywhere. */
const flat = (hour: number, minute: number, level: number): SchedulePoint => point(hour, minute, level, level, level, level);

test("levels fade linearly between neighbouring points", () => {
  const points = [flat(8, 0, 0), flat(10, 0, 100)];
  assert.equal(valueAt(points, 9 * 60, 0), 50);
  assert.equal(valueAt(points, 8 * 60, 0), 0);
  assert.equal(valueAt(points, 10 * 60, 0), 100);
  assert.equal(valueAt(points, 8 * 60 + 30, 0), 25);
});

test("the day wraps: after the last point the curve runs back into the first", () => {
  const points = [flat(6, 0, 20), flat(22, 0, 100)];
  // 22:00 (100) -> 06:00 next day (20): 8 h span, halfway is 02:00.
  assert.equal(valueAt(points, 2 * 60, 0), 60);
  assert.equal(valueAt(points, 0, 0), 100 + (20 - 100) * (2 / 8));
  // Before the first point uses the same wrapped segment.
  assert.equal(valueAt(points, 4 * 60, 0), 100 + (20 - 100) * (6 / 8));
  assert.equal(valueAt(points, 1440 + 2 * 60, 0), 60);
});

test("no points is a dark day and one point holds its colour all day", () => {
  assert.equal(valueAt([], 600, 3), 0);
  const single = [point(12, 0, 40, 10, 20, 30)];
  assert.deepEqual(colourAt(single, 3 * 60), [40, 10, 20, 30]);
  assert.deepEqual(colourAt([], 600, 4), [0, 0, 0, 0]);
});

test("channels fade independently, however many there are", () => {
  const points = [point(6, 0, 0, 100, 0, 50, 10), point(8, 0, 100, 0, 0, 50, 30)];
  assert.deepEqual(colourAt(points, 7 * 60), [50, 50, 0, 50, 20]);
});

test("vertices include the day's edges so the polyline IS the curve", () => {
  const vertices = channelVertices([flat(6, 0, 0), flat(12, 0, 100), flat(18, 0, 0)], 0);
  assert.deepEqual(vertices.map((v) => v.minutes), [0, 360, 720, 1080, 1440]);
  // Edge value is where the wrap segment crosses midnight (18:00 -> 06:00 is 0 -> 0).
  assert.equal(vertices[0]!.value, 0);
  assert.equal(vertices.at(-1)!.value, 0);
});

test("a point exactly at midnight is not duplicated at the left edge", () => {
  const vertices = channelVertices([flat(0, 0, 10), flat(12, 0, 90)], 0);
  assert.deepEqual(vertices.map((v) => v.minutes), [0, 720, 1440]);
  assert.equal(vertices.at(-1)!.value, 10);
});

test("empty programs draw a flat zero line", () => {
  assert.deepEqual(channelVertices([], 1), [
    { minutes: 0, value: 0 },
    { minutes: 1440, value: 0 },
  ]);
});

test("the colour ribbon samples the whole day inclusive of both edges", () => {
  const stops = dayColourStops([flat(6, 0, 0), flat(18, 0, 100)], 4, 60);
  assert.equal(stops.length, 25);
  assert.equal(stops[0]!.minutes, 0);
  assert.equal(stops.at(-1)!.minutes, 1440);
  assert.deepEqual(stops[12]!.levels, [50, 50, 50, 50]);
});

test("points that share a minute are a step, as on the light: the later one applies from that minute on", () => {
  // Night levels (10) until 23:00, then off (0) until sunrise at 08:00.
  const points = [flat(8, 0, 0), flat(9, 0, 80), flat(20, 0, 10), flat(23, 0, 10), flat(23, 0, 0)];
  assert.equal(valueAt(points, 1379, 0), 10, "still night the minute before");
  assert.equal(valueAt(points, 1380, 0), 0, "off from the shared minute");
  assert.equal(valueAt(points, 300, 0), 0, "and off until sunrise");
  assert.deepEqual(channelVertices(points, 0).filter((v) => v.minutes === 1380).map((v) => v.value), [10, 0], "the line drops straight down");
});

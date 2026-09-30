import { test } from "node:test";
import assert from "node:assert/strict";
import { hourTicks, minutesToX, nearestLevelField, nearestPointIndex, pathFromVertices, valueToY, xToMinutes, yToValue, type PlotBox } from "../src/lib/chart-geometry.ts";

const box: PlotBox = { left: 40, top: 10, width: 288, height: 100 };

test("minutes and pixels convert both ways across the whole day", () => {
  assert.equal(minutesToX(box, 0), 40);
  assert.equal(minutesToX(box, 1440), 328);
  assert.equal(minutesToX(box, 720), 184);
  for (const minutes of [0, 15, 385, 1439]) assert.ok(Math.abs(xToMinutes(box, minutesToX(box, minutes)) - minutes) < 1e-9);
  assert.equal(xToMinutes(box, -50), 0);
  assert.equal(xToMinutes(box, 9999), 1440);
});

test("percent 100 is the top edge and 0 the bottom, and pixels round to whole percent", () => {
  assert.equal(valueToY(box, 100), 10);
  assert.equal(valueToY(box, 0), 110);
  assert.equal(valueToY(box, 50), 60);
  assert.equal(yToValue(box, 60), 50);
  assert.equal(yToValue(box, 60.4), 50);
  assert.equal(yToValue(box, -20), 100);
  assert.equal(yToValue(box, 500), 0);
});

test("a polyline path uses the same mapping and can be nudged vertically", () => {
  const vertices = [
    { minutes: 0, value: 0 },
    { minutes: 720, value: 100 },
  ];
  assert.equal(pathFromVertices(box, vertices), "M40.0 110.0 L184.0 10.0");
  assert.equal(pathFromVertices(box, vertices, 2), "M40.0 112.0 L184.0 12.0");
});

test("the axis is labelled every 6 h when narrow and every 3 h when wide", () => {
  assert.deepEqual(hourTicks(300), [0, 6, 12, 18, 24]);
  assert.deepEqual(hourTicks(600), [0, 3, 6, 9, 12, 15, 18, 21, 24]);
});

test("a touch grabs the nearest point within reach, preferring the selected one on a tie", () => {
  const minutes = [420, 435, 900];
  assert.equal(nearestPointIndex(box, minutes, minutesToX(box, 900) + 3, 24), 2);
  assert.equal(nearestPointIndex(box, minutes, minutesToX(box, 600), 24), -1, "nothing within reach");
  // 07:00 and 07:15 are 3 px apart: the click lands between them.
  const between = (minutesToX(box, 420) + minutesToX(box, 435)) / 2;
  assert.equal(nearestPointIndex(box, minutes, between, 24, 1), 1);
  assert.equal(nearestPointIndex(box, minutes, between, 24, 0), 0);
});

test("a touch grabs the level dot nearest its height, with ties going to the last used channel", () => {
  const handles = [
    { field: "r", value: 70 },
    { field: "g", value: 70 },
    { field: "w", value: 20 },
  ];
  assert.equal(nearestLevelField(box, handles, valueToY(box, 22), 24), "w");
  assert.equal(nearestLevelField(box, handles, valueToY(box, 70), 24), "r");
  assert.equal(nearestLevelField(box, handles, valueToY(box, 70), 24, "g"), "g");
  assert.equal(nearestLevelField(box, handles, valueToY(box, 45), 10), null);
});

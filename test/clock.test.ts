import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesOfDay, zonedTimeToEpochMs } from "../src/lib/clock.ts";

test("the now marker follows Home Assistant's zone, not the viewer's", () => {
  const instant = new Date("2026-06-15T12:30:00Z");
  assert.equal(minutesOfDay(instant, "UTC"), 12 * 60 + 30);
  assert.equal(minutesOfDay(instant, "Europe/London"), 13 * 60 + 30); // BST
  assert.equal(minutesOfDay(instant, "America/New_York"), 8 * 60 + 30);
  assert.equal(minutesOfDay(new Date("2026-06-15T23:05:00Z"), "Asia/Tokyo"), 8 * 60 + 5); // next day
});

test("midnight is minute zero, not 24:00", () => {
  assert.equal(minutesOfDay(new Date("2026-06-15T00:00:00Z"), "UTC"), 0);
});

test("an unknown zone falls back to the device clock instead of throwing", () => {
  const instant = new Date("2026-06-15T12:30:00Z");
  assert.equal(minutesOfDay(instant, "Not/AZone"), instant.getHours() * 60 + instant.getMinutes());
});

test("a wall-clock time in a zone becomes the right instant, summer and winter", () => {
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 9, day: 27, hour: 8, minute: 30 }, "Europe/London"), Date.UTC(2026, 8, 27, 7, 30));
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 1, day: 15, hour: 8, minute: 30 }, "America/New_York"), Date.UTC(2026, 0, 15, 13, 30));
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 9, day: 27, hour: 8, minute: 30, second: 10 }, "Asia/Tokyo"), Date.UTC(2026, 8, 26, 23, 30, 10));
});

test("either side of a clock change resolves to the right offset", () => {
  // New York sprang forward at 02:00 on 2026-03-08.
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, "America/New_York"), Date.UTC(2026, 2, 8, 6, 30), "before: UTC-5");
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, "America/New_York"), Date.UTC(2026, 2, 8, 7, 30), "after: UTC-4");
  // London went back at 02:00 on 2026-10-25.
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 10, day: 25, hour: 12 }, "Europe/London"), Date.UTC(2026, 9, 25, 12), "after: UTC");
  assert.equal(zonedTimeToEpochMs({ year: 2026, month: 10, day: 24, hour: 12 }, "Europe/London"), Date.UTC(2026, 9, 24, 11), "before: UTC+1");
});

test("a missing or unknown zone uses the device's own clock", () => {
  const wall = { year: 2026, month: 6, day: 15, hour: 12, minute: 30 };
  const local = new Date(2026, 5, 15, 12, 30).getTime();
  assert.equal(zonedTimeToEpochMs(wall), local);
  assert.equal(zonedTimeToEpochMs(wall, "Not/AZone"), local);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesOfDay } from "../src/lib/clock.ts";

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

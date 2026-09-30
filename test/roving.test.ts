import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRovingIndex } from "../src/lib/roving.ts";

test("arrow keys wrap around, Home and End jump, other keys are ignored", () => {
  assert.equal(nextRovingIndex("ArrowRight", 2, 3), 0);
  assert.equal(nextRovingIndex("ArrowDown", 0, 3), 1);
  assert.equal(nextRovingIndex("ArrowLeft", 0, 3), 2);
  assert.equal(nextRovingIndex("ArrowUp", 2, 3), 1);
  assert.equal(nextRovingIndex("Home", 2, 5), 0);
  assert.equal(nextRovingIndex("End", 0, 5), 4);
  assert.equal(nextRovingIndex("a", 0, 5), null);
  assert.equal(nextRovingIndex("ArrowRight", 0, 0), null);
});

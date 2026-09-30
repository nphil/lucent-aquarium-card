import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOLD_CONFIG, HOLD_IDLE, holdPress, holdProgress, holdRelease, holdTick, isTapRelease, TAP_MAX_MS } from "../src/lib/hold-progress.ts";

test("holding for the full duration completes and stays completed", () => {
  const done = holdTick(holdPress(), DEFAULT_HOLD_CONFIG.durationMs, DEFAULT_HOLD_CONFIG);
  assert.equal(done.phase, "completed");
  assert.equal(holdProgress(done, DEFAULT_HOLD_CONFIG), 1);
  assert.equal(holdTick(done, 500, DEFAULT_HOLD_CONFIG), done);
});

test("letting go early drains back to idle instead of completing", () => {
  let state = holdTick(holdPress(), 600, DEFAULT_HOLD_CONFIG);
  state = holdRelease(state);
  assert.equal(state.phase, "draining");
  assert.ok(holdProgress(state, DEFAULT_HOLD_CONFIG) > 0.39);
  assert.deepEqual(holdTick(state, 10_000, DEFAULT_HOLD_CONFIG), HOLD_IDLE);
});

test("a press let go inside the tap window is a tap; a longer abandoned hold is not", () => {
  assert.equal(isTapRelease(holdTick(holdPress(), TAP_MAX_MS - 1, DEFAULT_HOLD_CONFIG)), true);
  assert.equal(isTapRelease(holdTick(holdPress(), TAP_MAX_MS, DEFAULT_HOLD_CONFIG)), false);
  assert.equal(isTapRelease(HOLD_IDLE), false);
});

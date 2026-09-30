import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../src/lib/errors.ts";

test("errors from the websocket become the human message they carry", () => {
  assert.equal(describeError({ code: "home_assistant_error", message: "The light is not connected" }), "The light is not connected");
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError("plain"), "plain");
  assert.equal(describeError({ code: "x" }), "Something went wrong. Try again.");
  assert.equal(describeError(undefined, "fallback"), "fallback");
});

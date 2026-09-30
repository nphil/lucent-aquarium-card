import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, errorCode } from "../src/lib/errors.ts";

test("errors from the websocket become the human message they carry", () => {
  assert.equal(describeError({ code: "home_assistant_error", message: "The light is not connected" }), "The light is not connected");
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError("plain"), "plain");
  assert.equal(describeError({ code: "x" }), "Something went wrong. Try again.");
  assert.equal(describeError(undefined, "fallback"), "fallback");
});

test("a refused REST call carries its message in the body", () => {
  assert.equal(describeError({ status_code: 400, body: { message: "Message malformed: extra keys not allowed" } }), "Message malformed: extra keys not allowed");
  assert.equal(describeError({ status_code: 500, body: "Server error" }), "Server error");
  assert.equal(describeError({ status_code: 500, body: {} }, "fallback"), "fallback");
});

test("the websocket error code is read when there is one", () => {
  assert.equal(errorCode({ code: "unauthorized", message: "no" }), "unauthorized");
  assert.equal(errorCode(new Error("x")), null);
  assert.equal(errorCode(undefined), null);
});

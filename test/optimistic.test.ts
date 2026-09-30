import { test } from "node:test";
import assert from "node:assert/strict";
import { OptimisticStore } from "../src/lib/optimistic.ts";
import { FakeScheduler } from "./_fake-scheduler.ts";

test("the user's value is shown until the entity agrees", () => {
  const clock = new FakeScheduler();
  const store = new OptimisticStore<"v", number>(2000, clock);
  store.set("v", 70);
  assert.equal(store.get("v", 40), 70);
  clock.advance(500);
  assert.equal(store.get("v", 55), 70, "an older echo does not pull the control back mid-gesture");
  assert.equal(store.get("v", 70), 70);
  assert.equal(store.has("v"), false, "agreement drops the override");
  assert.equal(store.get("v", 71), 71);
});

test("an override the entity never confirms expires and the control snaps back", () => {
  const clock = new FakeScheduler();
  const store = new OptimisticStore<"v", number>(2000, clock);
  store.set("v", 70);
  clock.advance(1999);
  assert.equal(store.get("v", 40), 70);
  clock.advance(1);
  assert.equal(store.get("v", 40), 40);
});

test("continued interaction keeps extending the hold", () => {
  const clock = new FakeScheduler();
  const store = new OptimisticStore<"v", number>(2000, clock);
  store.set("v", 10);
  clock.advance(1500);
  store.set("v", 20);
  clock.advance(1500);
  assert.equal(store.get("v", 0), 20);
});

test("prune drops expired overrides and reports when the next one expires", () => {
  const clock = new FakeScheduler();
  const store = new OptimisticStore<"a" | "b", number>(1000, clock);
  store.set("a", 1);
  clock.advance(600);
  store.set("b", 2);
  assert.equal(store.prune(), 400);
  clock.advance(400);
  assert.equal(store.prune(), 600);
  assert.equal(store.has("a"), false);
  clock.advance(600);
  assert.equal(store.prune(), null);
});

test("custom equality decides when a compound value counts as confirmed", () => {
  const clock = new FakeScheduler();
  const store = new OptimisticStore<"v", { r: number }>(1000, clock, (a, b) => a.r === b.r);
  store.set("v", { r: 5 });
  assert.deepEqual(store.get("v", { r: 9 }), { r: 5 });
  assert.deepEqual(store.get("v", { r: 5 }), { r: 5 });
  assert.equal(store.has("v"), false);
});

test("peek shows the live override with nothing to compare it against, and drops an expired one", () => {
  const clock = new FakeScheduler();
  const store = new OptimisticStore<"v", number>(1000, clock);
  assert.equal(store.peek("v"), undefined);
  store.set("v", 7);
  clock.advance(999);
  assert.equal(store.peek("v"), 7);
  clock.advance(1);
  assert.equal(store.peek("v"), undefined);
  assert.equal(store.has("v"), false);
});

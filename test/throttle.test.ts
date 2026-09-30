import { test } from "node:test";
import assert from "node:assert/strict";
import { throttle } from "../src/lib/throttle.ts";
import { FakeScheduler } from "./_fake-scheduler.ts";

test("the first call goes out at once; a burst collapses to the newest value at the window's end", () => {
  const clock = new FakeScheduler();
  const sent: number[] = [];
  const send = throttle((value: number) => sent.push(value), 250, clock);
  send(1);
  send(2);
  send(3);
  assert.deepEqual(sent, [1]);
  clock.advance(249);
  assert.deepEqual(sent, [1]);
  clock.advance(1);
  assert.deepEqual(sent, [1, 3]);
});

test("a drag of 100 events over one second sends at most 4 times and still delivers the last value", () => {
  const clock = new FakeScheduler();
  const sends: Array<{ at: number; value: number }> = [];
  const send = throttle((value: number) => sends.push({ at: clock.now(), value }), 250, clock);
  for (let i = 1; i <= 100; i++) {
    send(i);
    clock.advance(10);
  }
  clock.advance(300);
  const insideFirstSecond = sends.filter((s) => s.at < 1000);
  assert.ok(insideFirstSecond.length <= 4, `sent ${insideFirstSecond.length} times in the first second`);
  assert.equal(sends.at(-1)!.value, 100);
  for (let i = 1; i < sends.length; i++) assert.ok(sends[i]!.at - sends[i - 1]!.at >= 250, "sends are at least one interval apart");
});

test("a call after a quiet spell is sent immediately", () => {
  const clock = new FakeScheduler();
  const sent: number[] = [];
  const send = throttle((value: number) => sent.push(value), 250, clock);
  send(1);
  clock.advance(1000);
  send(2);
  assert.deepEqual(sent, [1, 2]);
});

test("flush sends the waiting value now and cancels the timer; cancel drops it", () => {
  const clock = new FakeScheduler();
  const sent: number[] = [];
  const send = throttle((value: number) => sent.push(value), 250, clock);
  send(1);
  send(2);
  assert.equal(send.pending, true);
  send.flush();
  assert.deepEqual(sent, [1, 2]);
  assert.equal(send.pending, false);
  clock.advance(1000);
  assert.deepEqual(sent, [1, 2]);

  clock.advance(1000);
  send(3);
  send(4);
  send.cancel();
  clock.advance(1000);
  assert.deepEqual(sent, [1, 2, 3]);
});

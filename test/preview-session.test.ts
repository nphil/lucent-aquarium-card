import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewSession, PREVIEW_IDLE_MS, PREVIEW_INTERVAL_MS, PREVIEW_KEEPALIVE_MS, type PreviewStatus } from "../src/lib/preview-session.ts";
import type { Levels } from "../src/lib/channels.ts";
import { FakeScheduler, settle } from "./_fake-scheduler.ts";

interface Harness {
  clock: FakeScheduler;
  session: PreviewSession;
  shown: Array<{ at: number; levels: Levels }>;
  ends: number[];
  statuses: PreviewStatus[];
  failShow: { error: Error | null };
}

function harness(): Harness {
  const clock = new FakeScheduler();
  const shown: Harness["shown"] = [];
  const ends: number[] = [];
  const statuses: PreviewStatus[] = [];
  const failShow: Harness["failShow"] = { error: null };
  const session = new PreviewSession(
    {
      show: async (levels) => {
        if (failShow.error) throw failShow.error;
        shown.push({ at: clock.now(), levels });
      },
      end: async () => {
        ends.push(clock.now());
      },
    },
    { scheduler: clock, onStatus: (status) => statuses.push(status) },
  );
  return { clock, session, shown, ends, statuses, failShow };
}

const mix = (r: number): Levels => [r, 0, 0, 0];

test("dragging sends at most 4 previews a second and the last colour always arrives", async () => {
  const { clock, session, shown } = harness();
  for (let i = 1; i <= 80; i++) {
    session.show(mix(i));
    clock.advance(12);
    await settle();
  }
  clock.advance(400);
  await settle();
  assert.ok(shown.filter((s) => s.at < 1000).length <= 4);
  assert.equal(shown.at(-1)!.levels[0], 80);
});

test("ending sends the end call once, drops any preview still waiting, and is safe to repeat", async () => {
  const { clock, session, shown, ends } = harness();
  session.show(mix(10));
  session.show(mix(20));
  await settle();
  assert.equal(shown.length, 1);
  await session.end();
  clock.advance(1000);
  await settle();
  assert.equal(shown.length, 1, "the pending colour must not be sent after end");
  assert.equal(ends.length, 1);
  await session.end();
  assert.equal(ends.length, 1);
  assert.equal(session.status.phase, "idle");
});

test("nothing was previewed, so closing sends no end call", async () => {
  const { session, ends } = harness();
  await session.end();
  assert.equal(ends.length, 0);
});

test("a preview that is still open is refreshed before the backend's 30 s timeout", async () => {
  const { clock, session, shown } = harness();
  session.show(mix(40));
  await settle();
  clock.advance(PREVIEW_KEEPALIVE_MS - 1);
  await settle();
  assert.equal(shown.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(shown.length, 2);
  assert.equal(shown[1]!.levels[0], 40);
  clock.advance(PREVIEW_KEEPALIVE_MS);
  await settle();
  assert.equal(shown.length, 3);
});

test("a session nobody touches ends itself and reports why", async () => {
  const { clock, session, ends, statuses } = harness();
  session.show(mix(40));
  await settle();
  clock.advance(PREVIEW_IDLE_MS);
  await settle();
  assert.equal(ends.length, 1);
  assert.deepEqual(statuses.at(-1), { phase: "idle", endedBy: "idle" });
  // Editing again starts a fresh preview.
  session.show(mix(50));
  await settle();
  assert.equal(session.status.phase, "active");
});

test("a failed send is reported with the reason", async () => {
  const { session, statuses, failShow } = harness();
  failShow.error = new Error("Link is down");
  session.show(mix(1));
  await settle();
  assert.deepEqual(statuses.at(-1), { phase: "error", message: "Link is down" });
});

test("recovery after an error shows active again once a send succeeds", async () => {
  const { clock, session, statuses, failShow, shown } = harness();
  failShow.error = new Error("Link is down");
  session.show(mix(1));
  await settle();
  failShow.error = null;
  session.show(mix(2));
  clock.advance(250);
  await settle();
  assert.equal(shown.length, 1);
  assert.equal(statuses.at(-1)!.phase, "active");
});

test("the end call waits for a colour still in flight", async () => {
  const clock = new FakeScheduler();
  const order: string[] = [];
  let release!: () => void;
  const session = new PreviewSession(
    {
      show: () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("show-done");
            resolve();
          };
        }),
      end: async () => {
        order.push("end");
      },
    },
    { scheduler: clock },
  );
  session.show(mix(5));
  const ending = session.end();
  await settle();
  assert.deepEqual(order, []);
  release();
  await ending;
  assert.deepEqual(order, ["show-done", "end"]);
});

// ---- ordering across a quick stop and restart ----

interface Gate {
  promise: Promise<void>;
  open(): void;
  fail(error: Error): void;
}

function gate(): Gate {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  return { promise, open: resolve, fail: reject };
}

/** A session whose colours and end frames are answered only when the test says so. */
function controlled() {
  const clock = new FakeScheduler();
  const order: string[] = [];
  const showGates: Gate[] = [];
  const endGates: Gate[] = [];
  const statuses: PreviewStatus[] = [];
  const session = new PreviewSession(
    {
      show: (levels) => {
        order.push(`show:${levels[0]}`);
        const g = gate();
        showGates.push(g);
        return g.promise;
      },
      end: () => {
        order.push("end");
        const g = gate();
        endGates.push(g);
        return g.promise;
      },
    },
    { scheduler: clock, onStatus: (status) => statuses.push(status) },
  );
  return { clock, order, showGates, endGates, statuses, session };
}

test("a quick stop and restart is not cancelled by the late end frame", async () => {
  const { clock, order, showGates, endGates, session } = controlled();
  session.show(mix(10)); // goes out at once and is slow to be answered
  const ending = session.end(); // the end frame has to wait for that colour
  session.show(mix(20)); // restarted straight away
  clock.advance(PREVIEW_INTERVAL_MS);
  await settle();
  assert.deepEqual(order, ["show:10"], "nothing else is sent while the first colour is unanswered");
  showGates[0]!.open();
  await settle();
  assert.deepEqual(order, ["show:10", "end"], "the restarted colour waits behind the end frame");
  endGates[0]!.open();
  await ending;
  await settle();
  assert.deepEqual(order, ["show:10", "end", "show:20"], "the end frame goes first, so the new colour has the last word");
  assert.equal(session.status.phase, "active");
});

test("the newest colour is the one that goes out behind the end frame", async () => {
  const { clock, order, showGates, endGates, session } = controlled();
  session.show(mix(10));
  showGates[0]!.open();
  await settle();
  const ending = session.end();
  await settle();
  session.show(mix(20));
  clock.advance(100);
  session.show(mix(30));
  clock.advance(PREVIEW_INTERVAL_MS);
  session.show(mix(40));
  assert.deepEqual(order, ["show:10", "end"]);
  endGates[0]!.open();
  await ending;
  await settle();
  assert.deepEqual(order, ["show:10", "end", "show:40"], "one colour, the latest, and no stale duplicates");
});

test("stopping again before the restarted colour ever reached the light leaves one end frame and no stray colour", async () => {
  const { clock, order, showGates, endGates, session } = controlled();
  session.show(mix(10));
  const first = session.end();
  session.show(mix(20));
  const second = session.end(); // nothing of the restart was sent: nothing more to end
  showGates[0]!.open();
  await settle();
  endGates[0]!.open();
  await first;
  await second;
  clock.advance(10_000);
  await settle();
  assert.deepEqual(order, ["show:10", "end"]);
  assert.equal(session.status.phase, "idle");
});

test("a late failure from before a restart does not mark the restarted preview as failed", async () => {
  const { clock, order, showGates, endGates, statuses, session } = controlled();
  session.show(mix(10));
  const ending = session.end();
  session.show(mix(20));
  clock.advance(PREVIEW_INTERVAL_MS);
  showGates[0]!.fail(new Error("Link is down"));
  await settle();
  endGates[0]!.open();
  await ending;
  await settle();
  assert.deepEqual(order, ["show:10", "end", "show:20"]);
  showGates[1]!.open();
  await settle();
  assert.equal(session.status.phase, "active");
  assert.ok(!statuses.some((status) => status.phase === "error"));
});

test("an end frame that fails after a restart does not stop the restarted preview", async () => {
  const { clock, order, showGates, endGates, session } = controlled();
  session.show(mix(10));
  const ending = session.end();
  showGates[0]!.open();
  await settle();
  session.show(mix(20));
  clock.advance(PREVIEW_INTERVAL_MS);
  endGates[0]!.fail(new Error("Link is down"));
  await ending;
  await settle();
  assert.equal(session.status.phase, "active");
  assert.deepEqual(order, ["show:10", "end", "show:20"], "the restarted colour is still sent");
});

test("an end frame that fails with no restart is reported", async () => {
  const { showGates, endGates, session } = controlled();
  session.show(mix(10));
  showGates[0]!.open();
  await settle();
  const ending = session.end();
  await settle();
  endGates[0]!.fail(new Error("Link is down"));
  await ending;
  assert.deepEqual(session.status, { phase: "idle", endedBy: "user", message: "Link is down" });
});

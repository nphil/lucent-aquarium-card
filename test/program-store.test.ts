import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgramStore } from "../src/lib/program-store.ts";
import type { ProgramData, ProgramReadOptions } from "../src/adapters/types.ts";
import { settle } from "./_fake-scheduler.ts";

const data = (id: string, count = 1): ProgramData => ({
  id,
  name: `P ${id}`,
  source: "device",
  editable: true,
  points: Array.from({ length: count }, (_, i) => ({ minutes: i * 60, levels: [0, 0, 0, 0] })),
});

function setup(fetcher: (id: string, options: ProgramReadOptions) => Promise<ProgramData>) {
  let changes = 0;
  const store = new ProgramStore(fetcher, () => changes++, (error) => (error instanceof Error ? error.message : "?"));
  return { store, changes: () => changes };
}

test("a program is read once; asking again while loaded or loading shares the read", async () => {
  let calls = 0;
  const { store } = setup(async (id) => {
    calls++;
    return data(id);
  });
  const first = store.load("diy_1");
  const second = store.load("diy_1");
  assert.equal(store.entry("diy_1").status, "loading");
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(store.entry("diy_1").status, "ready");
  await store.load("diy_1");
  assert.equal(calls, 1);
  await store.load("diy_1", { force: true });
  assert.equal(calls, 2);
});

test("a failed read keeps the last good points, flagged as an error, and can be retried", async () => {
  let fail = false;
  const { store } = setup(async (id) => {
    if (fail) throw new Error("The light is not connected");
    return data(id, 3);
  });
  await store.load("diy_2");
  fail = true;
  await store.load("diy_2", { force: true });
  const entry = store.entry("diy_2");
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "The light is not connected");
  assert.equal(entry.data!.points.length, 3);
  fail = false;
  await store.load("diy_2");
  assert.equal(store.entry("diy_2").status, "ready");
  assert.equal(store.entry("diy_2").error, null);
});

test("reset forgets everything and a read still in flight lands nowhere", async () => {
  let release!: (value: ProgramData) => void;
  const { store } = setup(() => new Promise<ProgramData>((resolve) => (release = resolve)));
  const pending = store.load("diy_3");
  store.reset();
  release(data("diy_3"));
  await pending;
  await settle();
  assert.equal(store.entry("diy_3").status, "idle");
  assert.equal(store.entry("diy_3").data, null);
});

test("put records confirmed data and tells listeners", () => {
  const { store, changes } = setup(async (id) => data(id));
  const before = changes();
  store.put("diy_1", data("diy_1", 4));
  assert.equal(store.entry("diy_1").data!.points.length, 4);
  assert.equal(store.entry("diy_1").status, "ready");
  assert.ok(changes() > before);
});

// ---- refresh: "Reload from the light" ----

function gated() {
  const seen: Array<{ id: string; refresh: boolean }> = [];
  const gates: Array<PromiseWithResolvers<void>> = [];
  const { store } = setup(async (id, options) => {
    seen.push({ id, refresh: options.refresh === true });
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    await gate.promise;
    return data(id);
  });
  return { store, seen, gates };
}

test("a plain read asks for no refresh, and a reload the user asked for passes it to the adapter", async () => {
  const seen: boolean[] = [];
  const { store } = setup(async (id, options) => {
    seen.push(options.refresh === true);
    return data(id);
  });
  await store.load("diy_1");
  await store.load("diy_1", { force: true });
  await store.load("diy_1", { force: true, refresh: true });
  assert.deepEqual(seen, [false, false, true]);
});

test("a refresh re-reads a program that is already loaded, even without force", async () => {
  let calls = 0;
  const { store } = setup(async (id) => (calls++, data(id)));
  await store.load("diy_1");
  await store.load("diy_1");
  assert.equal(calls, 1);
  await store.load("diy_1", { refresh: true });
  assert.equal(calls, 2);
});

test("a reload is not swallowed by a plain read that is still under way: it reads again behind it, asking the light", async () => {
  const { store, seen, gates } = gated();
  const plain = store.load("automatic");
  const reload = store.load("automatic", { force: true, refresh: true });
  assert.deepEqual(seen, [{ id: "automatic", refresh: false }], "the reload waits for the read under way");
  gates[0]!.resolve();
  await settle();
  assert.deepEqual(seen, [{ id: "automatic", refresh: false }, { id: "automatic", refresh: true }]);
  assert.equal(store.entry("automatic").status, "loading");
  gates[1]!.resolve();
  await Promise.all([plain, reload]);
  assert.equal(store.entry("automatic").status, "ready");
});

test("a plain read shares a reload that is already under way, and a second reload shares it too", async () => {
  const { store, seen, gates } = gated();
  const reload = store.load("automatic", { force: true, refresh: true });
  const plain = store.load("automatic");
  const again = store.load("automatic", { force: true, refresh: true });
  assert.equal(seen.length, 1);
  gates[0]!.resolve();
  await Promise.all([reload, plain, again]);
  assert.equal(seen.length, 1);
  assert.equal(store.entry("automatic").status, "ready");
});

test("a refresh that fails keeps the last good points, so the chart can still show them as stale", async () => {
  let fail = false;
  const { store } = setup(async (id, options) => {
    if (fail && options.refresh) throw new Error("The light didn't answer the refresh.");
    return data(id, 3);
  });
  await store.load("automatic");
  fail = true;
  await store.load("automatic", { force: true, refresh: true });
  const entry = store.entry("automatic");
  assert.deepEqual([entry.status, entry.error, entry.data?.points.length], ["error", "The light didn't answer the refresh.", 3]);
});

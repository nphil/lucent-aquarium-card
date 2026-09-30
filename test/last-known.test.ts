import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceController } from "../src/lib/device-controller.ts";
import { LastKnownMemory, parseLastKnown, type MemoryStorage } from "../src/lib/last-known.ts";
import type { AdapterCommands } from "../src/adapters/types.ts";

class FakeStorage implements MemoryStorage {
  readonly data = new Map<string, string>();
  reads = 0;
  writes = 0;
  getItem(key: string): string | null {
    this.reads++;
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.data.set(key, value);
  }
}

const KEY = "aquarium-light-card:last:light.tank";
const SAVED = JSON.stringify({ brightness: 70, levels: [10, 20, 30, 40, 50] });

const commands: AdapterCommands = {
  setPower: async () => undefined,
  setBrightness: async () => undefined,
  setChannels: async () => undefined,
  selectEffect: async () => undefined,
  playDemo: async () => undefined,
  activateSchedule: async () => undefined,
};
const newController = (): DeviceController => new DeviceController(() => commands, { onChange: () => undefined, onError: () => undefined });

test("saved values are validated: levels that do not fit the light are dropped, the brightness is kept", () => {
  assert.deepEqual(parseLastKnown(SAVED, 5), { brightness: 70, levels: [10, 20, 30, 40, 50] });
  assert.deepEqual(parseLastKnown(SAVED, 4), { brightness: 70, levels: null }, "another channel count");
  assert.deepEqual(parseLastKnown(JSON.stringify({ brightness: 250, levels: [-5, 200, 3, 4] }), 4), { brightness: 100, levels: [0, 100, 3, 4] });
  assert.deepEqual(parseLastKnown(JSON.stringify({ brightness: 50, levels: null }), 4), { brightness: 50, levels: null });
  assert.equal(parseLastKnown("{not json", 4), null);
  assert.equal(parseLastKnown(JSON.stringify({ levels: [1, 2] }), 2), null, "no brightness");
  assert.equal(parseLastKnown(JSON.stringify({ brightness: "x", levels: [1, 2] }), 2), null);
  assert.equal(parseLastKnown(null, 4), null);
});

test("a light that learns its channels late keeps its saved colour: nothing is read or written until they are known", () => {
  const storage = new FakeStorage();
  storage.data.set(KEY, SAVED);
  const memory = new LastKnownMemory(KEY, storage);
  const controller = newController();

  memory.restore(controller, 0); // the card has loaded, the channels have not
  memory.persist({ brightness: 78, levels: null }, true); // the light is on and reports a brightness
  assert.equal(storage.reads, 0, "restoring waits for the channel count");
  assert.equal(storage.writes, 0, "and so does saving: it would overwrite the saved colour with none");
  assert.equal(storage.data.get(KEY), SAVED);
  assert.equal(memory.isRestored, false);

  memory.restore(controller, 5); // the channel names arrived: retried on the next update
  assert.equal(memory.isRestored, true);
  assert.deepEqual(controller.lastKnown, { brightness: 70, levels: [10, 20, 30, 40, 50] });
  memory.persist(controller.lastKnown, true);
  assert.equal(storage.data.get(KEY), SAVED, "what is saved is the restored colour, not a blank");
});

test("restoring happens once; later calls neither read nor override", () => {
  const storage = new FakeStorage();
  storage.data.set(KEY, SAVED);
  const memory = new LastKnownMemory(KEY, storage);
  const controller = newController();
  memory.restore(controller, 5);
  memory.restore(controller, 5);
  memory.restore(controller, 4);
  assert.equal(storage.reads, 1);
});

test("values are saved while the light is on and only when they change", () => {
  const storage = new FakeStorage();
  const memory = new LastKnownMemory(KEY, storage);
  memory.restore(newController(), 4);
  memory.persist({ brightness: 60, levels: [1, 2, 3, 4] }, false);
  assert.equal(storage.writes, 0, "Home Assistant reports nothing while the light is off");
  memory.persist({ brightness: 60, levels: [1, 2, 3, 4] }, true);
  memory.persist({ brightness: 60, levels: [1, 2, 3, 4] }, true);
  assert.equal(storage.writes, 1);
  memory.persist({ brightness: 61, levels: [1, 2, 3, 4] }, true);
  assert.equal(storage.writes, 2);
  assert.deepEqual(JSON.parse(storage.data.get(KEY)!), { brightness: 61, levels: [1, 2, 3, 4] });
});

test("blocked or missing storage is harmless", () => {
  const throwing: MemoryStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  for (const storage of [throwing, null]) {
    const memory = new LastKnownMemory(KEY, storage);
    const controller = newController();
    memory.restore(controller, 4);
    memory.persist({ brightness: 60, levels: null }, true);
    assert.deepEqual(controller.lastKnown, { brightness: 100, levels: null });
  }
});

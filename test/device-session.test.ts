import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceSession, type SessionHost } from "../src/lib/device-session.ts";
import { PAWFLY_CHANNELS } from "../src/adapters/pawfly-data.ts";
import type { AdapterBinding, DeviceModel, ProgramData, ProgramReadOptions } from "../src/adapters/types.ts";
import { FakeScheduler, settle } from "./_fake-scheduler.ts";

const model = (load?: (id: string, options?: ProgramReadOptions) => Promise<ProgramData>): DeviceModel => ({
  phase: "on",
  name: "Tank",
  status: { chips: [], mode: "Manual colour", summary: "" },
  hasBrightness: true,
  brightness: 80,
  channels: PAWFLY_CHANNELS,
  levels: [10, 20, 30, 40],
  swatches: [],
  running: { kind: "manual" },
  tank: null,
  effects: null,
  schedule: {
    channels: PAWFLY_CHANNELS,
    programs: [],
    runningId: null,
    maxPoints: 12,
    load: load ?? (async () => Promise.reject(new Error("unused"))),
    newProgramPoints: () => [],
  },
  actions: [],
  notices: [],
  live: () => null,
});

interface FakeOptions {
  /** Held until the test lets the commands finish (a slow Bluetooth write). */
  hold?: Promise<void>;
  load?: (id: string, options?: ProgramReadOptions) => Promise<ProgramData>;
}

/** A light that records every command as "<name>:<command>:<arguments>". */
function fakeBinding(name: string, log: string[], options: FakeOptions = {}): AdapterBinding {
  const record =
    (command: string) =>
    async (...args: unknown[]): Promise<void> => {
      log.push(`${name}:${command}:${JSON.stringify(args[0] ?? null)}`);
      if (options.hold) await options.hold;
    };
  return {
    platform: "test",
    deviceId: name,
    key: `test:${name}`,
    watch: [],
    read: () => model(options.load),
    commands: {
      setPower: record("setPower"),
      setBrightness: record("setBrightness"),
      setChannels: record("setChannels"),
      selectEffect: record("selectEffect"),
      playDemo: record("playDemo"),
      activateSchedule: record("activateSchedule"),
    },
  };
}

function host() {
  const errors: string[] = [];
  const commands: string[] = [];
  let changes = 0;
  const value: SessionHost = { changed: () => changes++, error: (message) => errors.push(message), command: (kind) => commands.push(kind) };
  return { value, errors, commands, changes: () => changes };
}

const session = (identity: string, binding: AdapterBinding, h: ReturnType<typeof host>, clock: FakeScheduler) =>
  new DeviceSession(identity, binding, h.value, { memoryKey: `key:${identity}`, storage: null, scheduler: clock });

test("a drag still waiting when the card is pointed at another light is sent to the light it was made on", async () => {
  const clock = new FakeScheduler();
  const log: string[] = [];
  const h = host();
  const tank = session("tank", fakeBinding("tank", log), h, clock);
  tank.controller.display(model());
  tank.controller.setChannel(0, 10, false); // goes out at once
  tank.controller.setChannel(0, 20, false); // waits for its turn
  assert.deepEqual(log, ['tank:setChannels:{"0":10}']);

  tank.dispose(); // the card now shows another light
  const other = session("other", fakeBinding("other", log), h, clock);
  other.controller.display(model());
  clock.advance(5000);
  await settle();

  assert.deepEqual(log, ['tank:setChannels:{"0":10}', 'tank:setChannels:{"0":20}'], "the waiting drag reached the tank, and nothing reached the other light");
});

test("nothing the old light taught the card carries over to the new one", () => {
  const clock = new FakeScheduler();
  const log: string[] = [];
  const h = host();
  const tank = session("tank", fakeBinding("tank", log), h, clock);
  tank.controller.display(model());
  assert.deepEqual(tank.controller.lastKnown, { brightness: 80, levels: [10, 20, 30, 40] });
  tank.dispose();
  const other = session("other", fakeBinding("other", log), h, clock);
  assert.deepEqual(other.controller.lastKnown, { brightness: 100, levels: null }, "no remembered colour");
  assert.notEqual(other.store, tank.store);
  assert.notEqual(other.memory, tank.memory);
});

test("a disposed session stays quiet: a late failure is not shown against the light now on screen", async () => {
  const clock = new FakeScheduler();
  const log: string[] = [];
  const h = host();
  const hold = Promise.withResolvers<void>();
  const tank = session("tank", fakeBinding("tank", log, { hold: hold.promise }), h, clock);
  tank.controller.display(model());
  tank.controller.setChannel(0, 10, true); // in flight
  tank.dispose();
  hold.reject(new Error("The light is not connected"));
  await settle();
  assert.deepEqual(h.errors, []);
  assert.equal(tank.isLive, false);
  tank.controller.setPower(true); // a stray command on a disposed session does not reach the card
  assert.deepEqual(h.commands, ["colour"], "only the command made while it was live");
});

test("commands of a live session tell the card what they were, and errors reach it", async () => {
  const clock = new FakeScheduler();
  const log: string[] = [];
  const h = host();
  const hold = Promise.withResolvers<void>();
  const tank = session("tank", fakeBinding("tank", log, { hold: hold.promise }), h, clock);
  tank.controller.display(model());
  void tank.controller.selectEffect("Sunny");
  hold.reject(new Error("Nope"));
  await settle();
  assert.deepEqual(h.commands, ["effect"]);
  assert.deepEqual(h.errors, ["Nope"]);
});

test("the same light keeps its session and later commands use the freshly bound light", async () => {
  const clock = new FakeScheduler();
  const log: string[] = [];
  const h = host();
  const tank = session("tank", fakeBinding("v1", log), h, clock);
  tank.rebind(fakeBinding("v2", log));
  tank.controller.setPower(true);
  await settle();
  assert.deepEqual(log, ["v2:setPower:true"]);
});

test("program reads go through the light's own binding and carry the user's refresh", async () => {
  const clock = new FakeScheduler();
  const seen: Array<[string, ProgramReadOptions | undefined]> = [];
  const data = (id: string): ProgramData => ({ id, name: id, points: [], editable: false, source: "device" });
  const tank = session("tank", fakeBinding("tank", [], { load: async (id, options) => (seen.push([id, options]), data(id)) }), host(), clock);
  await tank.store.load("automatic");
  await tank.store.load("automatic", { force: true, refresh: true });
  assert.deepEqual(seen, [["automatic", { refresh: false }], ["automatic", { refresh: true }]]);
});

test("a program read still under way when the card moves on lands nowhere, and a disposed session reads nothing", async () => {
  const clock = new FakeScheduler();
  const pending = Promise.withResolvers<ProgramData>();
  const tank = session("tank", fakeBinding("tank", [], { load: () => pending.promise }), host(), clock);
  const reading = tank.store.load("automatic");
  tank.dispose();
  pending.resolve({ id: "automatic", name: "Automatic", points: [], editable: false, source: "device" });
  await reading;
  assert.equal(tank.store.entry("automatic").status, "idle");
  await tank.store.load("professional");
  assert.equal(tank.store.entry("professional").status, "error");
  assert.equal(tank.store.entry("professional").error, "This light has no schedules.");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceController, HOLD_MS, SELECTION_HOLD_MS, SEND_INTERVAL_MS, type CommandKind } from "../src/lib/device-controller.ts";
import { PAWFLY_CHANNELS } from "../src/adapters/pawfly-data.ts";
import type { AdapterCommands, DeviceModel } from "../src/adapters/types.ts";
import { FakeScheduler, settle } from "./_fake-scheduler.ts";

interface Call {
  at: number;
  method: string;
  args: unknown[];
}

function setup() {
  const clock = new FakeScheduler();
  const calls: Call[] = [];
  const errors: string[] = [];
  const commandKinds: CommandKind[] = [];
  let changes = 0;
  const fail = { message: null as string | null };
  /** While set, every command waits for it (a slow Bluetooth write). */
  const hold: { until: Promise<void> | null } = { until: null };
  const record =
    (method: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push({ at: clock.now(), method, args });
      if (hold.until) await hold.until;
      if (fail.message) throw { code: "home_assistant_error", message: fail.message };
    };
  const commands: AdapterCommands = {
    setPower: record("setPower"),
    setBrightness: record("setBrightness"),
    setChannels: record("setChannels"),
    selectEffect: record("selectEffect"),
    playDemo: record("playDemo"),
    activateSchedule: record("activateSchedule"),
  };
  const controller = new DeviceController(() => commands, { onChange: () => changes++, onError: (message) => errors.push(message), onCommand: (kind) => commandKinds.push(kind) }, clock);
  return { clock, calls, errors, commandKinds, controller, fail, hold, changes: () => changes };
}

const server = (over: Partial<DeviceModel> = {}): DeviceModel => ({
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
  effects: { effects: [], runningId: null, demo: null },
  schedule: { channels: PAWFLY_CHANNELS, programs: [], runningId: null, maxPoints: 12, load: async () => Promise.reject(new Error("unused")), newProgramPoints: () => [] },
  actions: [],
  notices: [],
  live: () => null,
  ...over,
});

const methods = (calls: Call[]): string[] => calls.map((c) => c.method);

test("dragging brightness shows the user's value at once and sends spaced calls", async () => {
  const { controller, calls, clock } = setup();
  for (let value = 1; value <= 100; value++) {
    controller.setBrightness(value, false);
    assert.equal(controller.display(server()).brightness, value);
    clock.advance(10);
  }
  controller.setBrightness(100, true);
  await settle();
  const drag = calls.slice(0, -1);
  for (let i = 1; i < drag.length; i++) assert.ok(drag[i]!.at - drag[i - 1]!.at >= SEND_INTERVAL_MS, "sends are at least one interval apart");
  assert.ok(calls.filter((c) => c.at < 1000).length <= 1000 / SEND_INTERVAL_MS + 1);
  assert.deepEqual(methods(calls).filter((m) => m !== "setBrightness"), [], "brightness alone: nothing else is touched");
  assert.deepEqual(calls.at(-1)!.args, [100]);
  assert.equal(controller.display(server({ running: { kind: "effect", effectId: "Sunny" } })).running.kind, "effect", "brightness never changes the mode");
});

test("a slider drag writes ONLY the channel that moved", async () => {
  const { controller, calls } = setup();
  controller.display(server());
  controller.setChannel(1, 55, false);
  controller.setChannel(1, 60, true);
  await settle();
  assert.deepEqual(calls.map((c) => [c.method, c.args]), [
    ["setChannels", [{ 1: 55 }]],
    ["setChannels", [{ 1: 60 }]],
  ]);
});

test("channels moved inside one window go out in a single call with the newest value of each", async () => {
  const { controller, calls, clock } = setup();
  controller.display(server());
  controller.setChannel(0, 10, false);
  clock.advance(20);
  controller.setChannel(0, 20, false);
  controller.setChannel(3, 70, false);
  clock.advance(SEND_INTERVAL_MS);
  await settle();
  assert.deepEqual(calls.map((c) => c.args[0]), [{ 0: 10 }, { 0: 20, 3: 70 }]);
});

test("moving a channel shows the new levels and manual mode straight away", () => {
  const { controller } = setup();
  controller.display(server({ running: { kind: "effect", effectId: "Sunny" }, effects: { effects: [], runningId: "Sunny", demo: null } }));
  controller.setChannel(2, 90, true);
  const shown = controller.display(server({ running: { kind: "effect", effectId: "Sunny" }, effects: { effects: [], runningId: "Sunny", demo: null } }));
  assert.deepEqual(shown.levels, [10, 20, 90, 40]);
  assert.equal(shown.running.kind, "manual");
  assert.equal(shown.effects?.runningId, null, "the scene tile stops looking selected");
});

test("two sliders moved before the next render both stay in the shown levels", () => {
  const { controller } = setup();
  controller.display(server());
  controller.setChannel(0, 90, false);
  controller.setChannel(3, 5, false);
  assert.deepEqual(controller.display(server()).levels, [90, 20, 30, 5]);
});

test("a swatch sets every channel in one call", async () => {
  const { controller, calls } = setup();
  controller.display(server());
  controller.setLevels([100, 0, 50, 20], true);
  await settle();
  assert.deepEqual(calls.map((c) => [c.method, c.args]), [["setChannels", [{ 0: 100, 1: 0, 2: 50, 3: 20 }]]]);
});

test("a colour change on a light that is off turns it on first", async () => {
  const { controller, calls } = setup();
  controller.display(server());
  const off = server({ phase: "off", brightness: null, levels: null });
  const shownOff = controller.display(off);
  assert.equal(shownOff.phase, "off");
  assert.deepEqual(shownOff.levels, [10, 20, 30, 40], "last known levels stay on the sliders");
  assert.equal(shownOff.brightness, 80);

  controller.setChannel(0, 50, true);
  await settle();
  assert.deepEqual(methods(calls), ["setPower", "setChannels"]);
  assert.deepEqual(calls[0]!.args, [true]);
  assert.equal(controller.display(off).phase, "on", "the display shows the light on straight away");
});

test("a refused channel write removes the optimistic colour and reports the reason", async () => {
  const { controller, errors, fail } = setup();
  controller.display(server());
  fail.message = "The light is not connected";
  controller.setChannel(0, 90, true);
  await settle();
  assert.deepEqual(errors, ["The light is not connected"]);
  assert.deepEqual(controller.display(server()).levels, [10, 20, 30, 40]);
});

test("a light that never reports its levels shows none until something is commanded, then what was last commanded", async () => {
  const { controller, clock } = setup();
  assert.equal(controller.display(server({ levels: null })).levels, null);
  controller.setChannel(1, 66, true);
  await settle();
  clock.advance(HOLD_MS + 500);
  const shown = controller.display(server({ levels: null }));
  assert.deepEqual(shown.levels, [0, 66, 0, 0], "the overlay expired, the commanded value was remembered");
});

test("the optimistic value gives way to the light once it agrees, and expires if it never does", () => {
  const { controller, clock } = setup();
  controller.setBrightness(30, true);
  assert.equal(controller.display(server({ brightness: 80 })).brightness, 30);
  assert.equal(controller.display(server({ brightness: 30 })).brightness, 30);
  assert.equal(controller.display(server({ brightness: 55 })).brightness, 55, "confirmed once, so a later change from elsewhere is shown");

  controller.setBrightness(40, true);
  clock.advance(HOLD_MS - 1);
  assert.equal(controller.display(server({ brightness: 80 })).brightness, 40);
  clock.advance(1);
  assert.equal(controller.display(server({ brightness: 80 })).brightness, 80);
});

test("a light without a master brightness never shows one", () => {
  const { controller } = setup();
  controller.setBrightness(30, true);
  assert.equal(controller.display(server({ hasBrightness: false, brightness: null })).brightness, null);
});

test("a refused brightness command reverts and reports", async () => {
  const { controller, errors, fail } = setup();
  fail.message = "nope";
  controller.setBrightness(30, true);
  await settle();
  assert.deepEqual(errors, ["nope"]);
  assert.equal(controller.display(server({ brightness: 80 })).brightness, 80);
});

test("power toggles call setPower and revert if refused", async () => {
  const { controller, calls, fail, errors } = setup();
  controller.display(server());
  controller.setPower(false);
  await settle();
  assert.deepEqual([calls[0]!.method, calls[0]!.args], ["setPower", [false]]);
  assert.equal(controller.display(server()).phase, "off");
  fail.message = "nope";
  controller.setPower(true);
  await settle();
  assert.equal(errors[0], "nope");
  assert.equal(controller.display(server({ phase: "off", brightness: null, levels: null })).phase, "off");
});

test("choosing an effect highlights it at once, calls it, and reverts if refused", async () => {
  const { controller, calls, fail, errors } = setup();
  const model = server({ effects: { effects: [], runningId: null, demo: null } });
  const ok = controller.selectEffect("Sunny");
  const shown = controller.display(model);
  assert.deepEqual([shown.running.kind, shown.running.effectId, shown.effects?.runningId], ["effect", "Sunny", "Sunny"]);
  assert.equal(controller.selectionPending, true);
  assert.equal(await ok, true);
  assert.deepEqual([calls[0]!.method, calls[0]!.args], ["selectEffect", ["Sunny"]]);

  fail.message = "Something failed";
  assert.equal(await controller.selectEffect("Moonlight"), false);
  assert.equal(errors[0], "Something failed");
  assert.equal(controller.display(server({ running: { kind: "effect", effectId: "Sunny" } })).running.effectId, "Sunny");
});

test("activating a schedule highlights it at once and marks the schedule running", async () => {
  const { controller, calls } = setup();
  assert.equal(await controller.activateSchedule("dutch_style"), true);
  assert.deepEqual([calls[0]!.method, calls[0]!.args], ["activateSchedule", ["dutch_style"]]);
  const shown = controller.display(server());
  assert.deepEqual([shown.running.kind, shown.running.scheduleId, shown.schedule?.runningId], ["schedule", "dutch_style", "dutch_style"]);
});

test("the Demo is a plain command that leaves the displayed mode alone", async () => {
  const { controller, calls } = setup();
  assert.equal(await controller.playDemo(), true);
  assert.equal(calls[0]!.method, "playDemo");
  assert.equal(controller.display(server({ running: { kind: "schedule", scheduleId: "dutch_style" } })).running.kind, "schedule");
});

test("the pending flag clears when the light confirms, or after the selection hold", () => {
  const { controller, clock } = setup();
  void controller.selectEffect("Sunny");
  controller.display(server({ running: { kind: "effect", effectId: "Sunny" } }));
  assert.equal(controller.selectionPending, false);

  void controller.selectEffect("Warm White");
  clock.advance(SELECTION_HOLD_MS);
  assert.equal(controller.display(server({ running: { kind: "effect", effectId: "Sunny" } })).running.effectId, "Sunny");
});

test("commands tell the card what kind they were, so a running Demo can end", async () => {
  const { controller, commandKinds } = setup();
  controller.setChannel(0, 1, true);
  void controller.selectEffect("Thunderstorm");
  void controller.activateSchedule("dutch_style");
  controller.setPower(false);
  controller.setBrightness(50, true);
  await settle();
  assert.deepEqual(commandKinds, ["colour", "effect", "schedule", "power"], "brightness does not end a Demo");
});

test("flush sends a drag that was still waiting when the card went away", async () => {
  const { controller, calls } = setup();
  controller.display(server());
  controller.setChannel(0, 1, false);
  controller.setChannel(0, 2, false);
  assert.equal(calls.length, 1);
  controller.flush();
  await settle();
  assert.deepEqual(calls.map((c) => c.args[0]), [{ 0: 1 }, { 0: 2 }]);
});

test("while the light is unavailable nothing is overlaid, and the sliders keep the last known values", () => {
  const { controller } = setup();
  controller.display(server());
  controller.setBrightness(30, true);
  const shown = controller.display(server({ phase: "unavailable", brightness: null, levels: null, running: { kind: "manual" } }));
  assert.equal(shown.phase, "unavailable");
  assert.equal(shown.brightness, 80, "the last value the light itself reported, not the unconfirmed 30");
  assert.deepEqual(shown.levels, [10, 20, 30, 40]);
});

test("remembered values from an earlier session fill in for a light that is off", () => {
  const { controller } = setup();
  controller.remember({ brightness: 65, levels: [1, 2, 3, 4] });
  const shown = controller.display(server({ phase: "off", brightness: null, levels: null }));
  assert.equal(shown.brightness, 65);
  assert.deepEqual(shown.levels, [1, 2, 3, 4]);
  controller.display(server());
  assert.deepEqual(controller.lastKnown, { brightness: 80, levels: [10, 20, 30, 40] });
});

test("a re-render is requested when an override expires so the control can snap back", () => {
  const { controller, clock, changes } = setup();
  controller.setBrightness(30, true);
  const before = changes();
  clock.advance(HOLD_MS + SEND_INTERVAL_MS);
  assert.ok(changes() > before);
});

// ---- last known values are confirmed values ----

test("a refused colour is not remembered as the light's colour, so it neither lingers nor gets saved", async () => {
  const { controller, errors, fail, clock } = setup();
  controller.display(server({ levels: null })); // a light that never reports its levels
  fail.message = "The light is not connected";
  controller.setChannel(1, 66, true);
  await settle();
  assert.deepEqual(errors, ["The light is not connected"]);
  assert.equal(controller.display(server({ levels: null })).levels, null, "the refused colour is gone from the sliders");
  assert.equal(controller.lastKnown.levels, null, "and would not be saved");
  clock.advance(HOLD_MS + 500);
  assert.equal(controller.display(server({ levels: null })).levels, null);
});

test("an accepted colour becomes the last known colour, for the channels that were sent", async () => {
  const { controller } = setup();
  controller.display(server({ levels: null }));
  controller.setChannel(1, 66, true);
  await settle();
  assert.deepEqual(controller.lastKnown.levels, [0, 66, 0, 0]);
  controller.setChannel(3, 20, true);
  await settle();
  assert.deepEqual(controller.lastKnown.levels, [0, 66, 0, 20], "the earlier accepted channel is kept");
});

test("a colour still on its way is shown, but not yet remembered", async () => {
  const { controller, hold } = setup();
  const release = Promise.withResolvers<void>();
  hold.until = release.promise;
  controller.display(server({ levels: null }));
  controller.setChannel(1, 66, true);
  await settle();
  assert.deepEqual(controller.display(server({ levels: null })).levels, [0, 66, 0, 0], "shown at once");
  assert.equal(controller.lastKnown.levels, null, "not known until the light accepts it");
  release.resolve();
  await settle();
  assert.deepEqual(controller.lastKnown.levels, [0, 66, 0, 0]);
});

test("a refused write forgets the pending colour, so the next slider move does not build on it", async () => {
  const { controller, fail } = setup();
  controller.display(server({ levels: null }));
  fail.message = "nope";
  controller.setChannel(1, 66, true);
  await settle();
  fail.message = null;
  controller.setChannel(3, 20, true);
  await settle();
  assert.deepEqual(controller.lastKnown.levels, [0, 0, 0, 20], "the refused 66 is not part of the mix");
});

test("a saved copy never overrides what the light has already said", () => {
  const { controller } = setup();
  controller.display(server({ brightness: 80, levels: [10, 20, 30, 40] }));
  controller.remember({ brightness: 65, levels: [1, 2, 3, 4] });
  assert.deepEqual(controller.lastKnown, { brightness: 80, levels: [10, 20, 30, 40] });
});

test("a saved copy fills only what is still unknown, and an empty one erases nothing", () => {
  const { controller } = setup();
  controller.display(server({ brightness: 80, levels: null })); // brightness learned, levels not
  controller.remember({ brightness: 65, levels: [1, 2, 3, 4] });
  assert.deepEqual(controller.lastKnown, { brightness: 80, levels: [1, 2, 3, 4] });
  controller.remember({ brightness: 50, levels: null });
  assert.deepEqual(controller.lastKnown, { brightness: 80, levels: [1, 2, 3, 4] });
});

test("a disposed controller sends what was waiting, then nothing more", async () => {
  const { controller, calls } = setup();
  controller.display(server());
  controller.setChannel(0, 10, false); // goes out at once
  controller.setChannel(0, 20, false); // waits for its turn
  controller.dispose();
  await settle();
  assert.deepEqual(calls.map((c) => c.args[0]), [{ 0: 10 }, { 0: 20 }], "the waiting drag is flushed");
  controller.setChannel(0, 30, true);
  controller.setBrightness(50, true);
  controller.setPower(false);
  assert.equal(await controller.selectEffect("Sunny"), false);
  assert.equal(await controller.activateSchedule("dutch_style"), false);
  assert.equal(await controller.playDemo(), false);
  await settle();
  assert.equal(calls.length, 2, "late commands from a view being replaced go nowhere");
});

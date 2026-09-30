import { test } from "node:test";
import assert from "node:assert/strict";
import { bindLight, findSupportedLights } from "../src/adapters/index.ts";
import { fluvalAdapter } from "../src/adapters/fluval.ts";
import { autoNote, autoSchedulePoints, channelDefs, describeFluvalStatus, effectDefs, parseSchedulePayload, programFromPayload, readFluvalState, resolveFluvalEntities, type AutoSchedule, type FluvalEntities } from "../src/adapters/fluval-data.ts";
import { valueAt } from "../src/lib/curve.ts";
import type { SchedulePoint } from "../src/lib/points.ts";
import type { HassRef } from "../src/adapters/types.ts";
import type { EntityRegistryEntry, HassEntityState, HomeAssistant } from "../src/types.ts";

const entry = (entity_id: string, key: string | null = null, device_id: string | null = "dev1"): EntityRegistryEntry => ({ entity_id, device_id, platform: "fluvalble", translation_key: key });
const state = (entity_id: string, value: string, attributes: Record<string, unknown> = {}): HassEntityState => ({ entity_id, state: value, attributes, last_changed: "", last_updated: "" });
const EFFECTS = ["off", "Thunderstorm", "Colour cycle", "Mostly sunny", "Crescent moon"];

const registry: Record<string, EntityRegistryEntry> = Object.fromEntries(
  [
    entry("light.plant", "light"),
    entry("select.plant_mode", "mode"),
    entry("button.plant_sync_clock", "sync_clock"),
    entry("button.plant_return_to_schedule", "return_to_schedule"),
    entry("binary_sensor.plant_connection", "connection"),
    entry("binary_sensor.plant_schedule_problem", "schedule_problem"),
    entry("light.other", "light", "dev2"),
    entry("select.other_mode", "mode", "dev2"),
  ].map((e) => [e.entity_id, e]),
);

const entities: FluvalEntities = { deviceId: "dev1", light: "light.plant", mode: "select.plant_mode", syncClock: "button.plant_sync_clock", returnToSchedule: "button.plant_return_to_schedule", connection: "binary_sensor.plant_connection", scheduleProblem: "binary_sensor.plant_schedule_problem" };

const PAYLOAD = {
  entry_id: "e1",
  points: null,
  mode: "manual",
  fixture: {
    available: true,
    mode: "automatic",
    channels: ["Pink", "Blue", "Cold White", "White", "Warm White"],
    auto: { sunrise: "08:00", sunrise_ramp: 60, sunset: "20:00", sunset_ramp: 90, sleep: "23:00", day_levels: [80, 70, 60, 50, 40], night_levels: [0, 5, 0, 0, 0] },
    professional: [
      { time: "12:00", channel_1: 80, channel_2: 70, channel_3: 60, channel_4: 50, channel_5: 40 },
      { time: "08:00", channel_1: 0, channel_2: 0, channel_3: 0, channel_4: 0, channel_5: 0 },
    ],
  },
};

test("siblings are found through the light's device by translation key", () => {
  assert.deepEqual(resolveFluvalEntities(registry, "light.plant"), entities);
  assert.equal(resolveFluvalEntities(registry, "light.other")?.mode, "select.other_mode");
  assert.equal(resolveFluvalEntities(registry, "switch.plant"), null);
});

test("channels take their colours from their names, with a palette for unknown ones", () => {
  const defs = channelDefs(["Pink", "Cold White", "Mystery"]);
  assert.deepEqual(defs.map((d) => [d.id, d.name, d.short]), [["channel_1", "Pink", "P"], ["channel_2", "Cold White", "CW"], ["channel_3", "Mystery", "M"]]);
  assert.equal(defs[0]!.colour, "#ff6fae");
  assert.ok(defs[2]!.colour.startsWith("#"));
});

test("effects drop the off sentinel, keep the light's names, and mark the animated ones", () => {
  const defs = effectDefs(EFFECTS);
  assert.deepEqual(defs.map((d) => d.id), ["Thunderstorm", "Colour cycle", "Mostly sunny", "Crescent moon"]);
  assert.deepEqual([defs[0]!.motion, defs[1]!.motion, defs[2]!.motion], ["storm", "cycle", undefined]);
  assert.equal(defs[1]!.art, "cycle");
  assert.equal(effectDefs(["off", "Brand new"])[0]!.icon, "effects");
});

test("the state reads brightness, colour, effect, mode, link, problem and override", () => {
  const states = {
    "light.plant": state("light.plant", "on", { brightness: 128, rgb_color: [255, 200, 100], effect: "off", effect_list: EFFECTS, level_source: "schedule", scheduled_levels: [10, 20, 30, 40, 50], friendly_name: "Plant" }),
    "select.plant_mode": state("select.plant_mode", "automatic", { options: ["manual", "automatic", "professional"], override_active: true, override_until: "2026-09-30T20:00:00+00:00" }),
    "binary_sensor.plant_connection": state("binary_sensor.plant_connection", "on"),
    "binary_sensor.plant_schedule_problem": state("binary_sensor.plant_schedule_problem", "on"),
  };
  const reading = readFluvalState(states, entities)!;
  assert.deepEqual([reading.phase, reading.brightness, reading.rgb, reading.effect, reading.mode], ["on", 50, [255, 200, 100], null, "automatic"]);
  assert.deepEqual([reading.scheduledLevels, reading.connected, reading.problem, reading.overrideActive], [[10, 20, 30, 40, 50], true, true, true]);
  const status = describeFluvalStatus(reading);
  assert.deepEqual(status.chips.map((c) => c.label), ["Connected", "Schedule problem", "Manual override"]);
  assert.equal(status.mode, "Automatic schedule");
  assert.equal(readFluvalState({}, entities), null);
  assert.equal(describeFluvalStatus({ ...reading, effect: "Thunderstorm" }).mode, "Thunderstorm effect");
  assert.equal(describeFluvalStatus({ ...reading, phase: "unavailable", connected: false }).chips[0]!.label, "Disconnected");
});

test("live levels are only trusted while the light says they come from its schedule", () => {
  const manual = readFluvalState({ "light.plant": state("light.plant", "on", { level_source: "reported", scheduled_levels: [1, 2, 3, 4, 5] }) }, entities)!;
  assert.equal(manual.scheduledLevels, null);
});

test("the schedule readback becomes the channel names, an Automatic curve and Professional points", () => {
  const payload = parseSchedulePayload(PAYLOAD)!;
  assert.deepEqual(payload.channels.length, 5);
  assert.deepEqual(payload.professional!.map((p) => p.minutes), [480, 720], "sorted");
  assert.deepEqual(payload.professional![1]!.levels, [80, 70, 60, 50, 40]);
  const auto = programFromPayload("automatic", payload);
  // Sunrise starts the ramp up (off before it, because a sleep time is set); sunset ENDS the ramp
  // down, which starts 90 min earlier; night holds until the sleep minute, where the light goes off.
  assert.deepEqual(auto.points.map((p) => p.minutes), [480, 540, 1110, 1200, 1380, 1380]);
  assert.deepEqual(auto.points.map((p) => p.levels), [[0, 0, 0, 0, 0], [80, 70, 60, 50, 40], [80, 70, 60, 50, 40], [0, 5, 0, 0, 0], [0, 5, 0, 0, 0], [0, 0, 0, 0, 0]]);
  assert.match(auto.note ?? "", /Sunrise starts at 08:00 and takes 60 min; sunset ends at 20:00 after a 90 min ramp down\. Off from 23:00 until sunrise\./);
  assert.equal(auto.editable, false);
  assert.equal(programFromPayload("professional", payload).points.length, 2);
  assert.throws(() => programFromPayload("professional", { ...payload, professional: null }), /not reported its Professional/);
  assert.throws(() => programFromPayload("bogus", payload), /no schedule called bogus/);
  assert.equal(parseSchedulePayload({ nope: 1 }), null);
});

// ---- the Automatic schedule, mirrored from the light ----

const AUTO: AutoSchedule = { sunrise: "08:00", sunriseRamp: 60, sunset: "20:00", sunsetRamp: 90, sleep: "23:00", dayLevels: [80, 70, 60, 50, 40], nightLevels: [0, 5, 0, 0, 0] };
const OFF5 = [0, 0, 0, 0, 0];
const DAY5 = [80, 70, 60, 50, 40];
const NIGHT5 = [0, 5, 0, 0, 0];

/** The light's own interpolation (the integration's `_interpolate_schedule`), transliterated. */
function lightLevels(points: readonly SchedulePoint[], minute: number): number[] {
  let previous = points[points.length - 1]!;
  let next = points[0]!;
  points.forEach((point, index) => {
    if (point.minutes <= minute) {
      previous = point;
      next = points[(index + 1) % points.length]!;
    }
  });
  const start = previous.minutes;
  let end = next.minutes;
  if (end <= start) end += 1440;
  const current = minute >= start ? minute : minute + 1440;
  const ratio = end === start ? 0 : (current - start) / (end - start);
  return previous.levels.map((value, i) => value + (next.levels[i]! - value) * ratio);
}

function assertDrawsWhatTheLightDoes(points: readonly SchedulePoint[], channels: number, label: string): void {
  for (let minute = 0; minute < 1440; minute++) {
    const expected = lightLevels(points, minute);
    for (let channel = 0; channel < channels; channel++) {
      assert.ok(Math.abs(valueAt(points, minute, channel) - expected[channel]!) < 1e-9, `${label}: minute ${minute}, channel ${channel}`);
    }
  }
}

test("with a sleep time the sunrise ramp starts from off, sunset ends its ramp, and the light switches off at the sleep minute", () => {
  const points = autoSchedulePoints(AUTO, 5);
  assert.deepEqual(points.map((p) => [p.minutes, ...p.levels]), [
    [480, ...OFF5],
    [540, ...DAY5],
    [1110, ...DAY5],
    [1200, ...NIGHT5],
    [1380, ...NIGHT5],
    [1380, ...OFF5],
  ]);
  assert.equal(valueAt(points, 300, 0), 0, "zero until sunrise");
  assert.equal(valueAt(points, 510, 0), 40, "half way up the sunrise ramp");
  assert.equal(valueAt(points, 1155, 0), 40, "half way down the sunset ramp, which ends at sunset");
  assert.equal(valueAt(points, 1200, 1), 5, "night levels at sunset");
  assert.equal(valueAt(points, 1379, 1), 5, "still night the minute before sleep");
  assert.equal(valueAt(points, 1380, 1), 0, "off from the sleep minute");
  assertDrawsWhatTheLightDoes(points, 5, "sleep");
});

test("without a sleep time the night levels hold until sunrise", () => {
  const points = autoSchedulePoints({ ...AUTO, sleep: null, sunrise: "07:00", sunriseRamp: 30, sunset: "21:00", sunsetRamp: 60, dayLevels: [100, 100, 100, 100, 100], nightLevels: [10, 0, 0, 0, 0] }, 5);
  assert.deepEqual(points.map((p) => [p.minutes, p.levels[0]]), [[420, 10], [450, 100], [1200, 100], [1260, 10]]);
  assert.equal(valueAt(points, 180, 0), 10, "night levels in the small hours, not off");
  assertDrawsWhatTheLightDoes(points, 5, "no sleep");
});

test("a ramp of zero minutes is a step: both points are kept, in the light's order", () => {
  const points = autoSchedulePoints({ ...AUTO, sleep: null, sunriseRamp: 0, sunsetRamp: 0 }, 5);
  assert.deepEqual(points.map((p) => [p.minutes, p.levels[0]]), [[480, 0], [480, 80], [1200, 80], [1200, 0]]);
  assert.equal(valueAt(points, 479, 0), 0);
  assert.equal(valueAt(points, 480, 0), 80, "the day levels apply from the sunrise minute");
  assert.equal(valueAt(points, 1199, 0), 80);
  assert.equal(valueAt(points, 1200, 0), 0, "and the night levels from the sunset minute");
  assertDrawsWhatTheLightDoes(points, 5, "zero ramps");
});

test("a sunrise that ramps across midnight wraps like the light's day", () => {
  const points = autoSchedulePoints({ ...AUTO, sleep: null, sunrise: "23:30", sunriseRamp: 60, sunset: "08:00", sunsetRamp: 30, dayLevels: [50, 50, 50, 50, 50], nightLevels: OFF5 }, 5);
  assert.deepEqual(points.map((p) => [p.minutes, p.levels[0]]), [[30, 50], [450, 50], [480, 0], [1410, 0]]);
  assert.equal(valueAt(points, 0, 0), 25, "half way up at midnight");
  assertDrawsWhatTheLightDoes(points, 5, "midnight");
});

test("ramps are clamped to the 0-240 minutes the light accepts", () => {
  const long = autoSchedulePoints({ ...AUTO, sleep: null, sunriseRamp: 500, sunsetRamp: 999 }, 5);
  assert.deepEqual(long.map((p) => p.minutes), [480, 720, 960, 1200], "240 minutes each way");
  const negative = autoSchedulePoints({ ...AUTO, sleep: null, sunriseRamp: -30, sunsetRamp: Number.NaN }, 5);
  assert.deepEqual(negative.map((p) => p.minutes), [480, 480, 1200, 1200]);
});

test("a four-channel light uses the first four levels; a schedule too short for the channels is refused", () => {
  const four = autoSchedulePoints(AUTO, 4);
  assert.ok(four.every((p) => p.levels.length === 4));
  assert.deepEqual(four[1]!.levels, [80, 70, 60, 50]);
  assert.throws(() => autoSchedulePoints({ ...AUTO, dayLevels: [1, 2, 3, 4] }, 5), /not reported a complete Automatic schedule/);
  assert.throws(() => autoSchedulePoints({ ...AUTO, sunrise: "soon" }, 5), /unusable sunrise or sunset/);
});

test("the note says what the schedule does, including a ramp that switches at once", () => {
  assert.match(autoNote({ ...AUTO, sleep: null }), /Night levels until sunrise\.$/);
  assert.match(autoNote({ ...AUTO, sunriseRamp: 0, sunsetRamp: 0 }), /Sunrise switches at 08:00; sunset switches at 20:00\. Off from 23:00 until sunrise\./);
});

test("the readback carries whether the light answered a refresh, and keeps repeated times as the light has them", () => {
  assert.equal(parseSchedulePayload(PAYLOAD)!.refreshOk, null);
  assert.equal(parseSchedulePayload({ ...PAYLOAD, refresh_ok: true })!.refreshOk, true);
  assert.equal(parseSchedulePayload({ ...PAYLOAD, refresh_ok: false })!.refreshOk, false);
  assert.equal(parseSchedulePayload({ ...PAYLOAD, refresh_ok: "yes" })!.refreshOk, null);
  const twice = parseSchedulePayload({ ...PAYLOAD, fixture: { ...PAYLOAD.fixture, professional: [{ time: "12:00", channel_1: 10 }, { time: "12:00", channel_1: 90 }, { time: "06:00", channel_1: 0 }] } })!;
  assert.deepEqual(twice.professional!.map((p) => [p.minutes, p.levels[0]]), [[360, 0], [720, 10], [720, 90]]);
});

// ---- binding ----

function fixture(over: Record<string, HassEntityState> = {}, reply: (message: Record<string, unknown>) => unknown = () => PAYLOAD) {
  const services: Array<{ domain: string; service: string; data: unknown; target: unknown }> = [];
  const ws: Array<Record<string, unknown>> = [];
  const hass = {
    states: {
      "light.plant": state("light.plant", "on", { brightness: 255, rgb_color: [255, 255, 255], effect: "off", effect_list: EFFECTS, friendly_name: "Plant" }),
      "select.plant_mode": state("select.plant_mode", "manual", { options: ["manual", "automatic", "professional"], override_active: false }),
      "binary_sensor.plant_connection": state("binary_sensor.plant_connection", "on"),
      ...over,
    },
    entities: registry,
    devices: { dev1: { id: "dev1", config_entries: ["e1"] } },
    callService: async (domain: string, service: string, data?: unknown, target?: unknown) => {
      services.push({ domain, service, data, target });
    },
    callWS: async (message: Record<string, unknown>) => {
      ws.push(message);
      return reply(message);
    },
  } as unknown as HomeAssistant;
  const ref: HassRef = { current: hass };
  return { ref, services, ws };
}

test("the adapters are told apart by the registry platform, and both lights are offered", () => {
  const f = fixture();
  assert.equal(bindLight(f.ref, "light.plant")?.platform, "fluvalble");
  assert.equal(fluvalAdapter.bind(f.ref, "select.plant_mode"), null);
  assert.deepEqual(findSupportedLights(f.ref.current).sort(), ["light.other", "light.plant"]);
});

test("the model has no channels until the readback arrives, then five named ones; schedules are read-only", async () => {
  const f = fixture();
  const binding = fluvalAdapter.bind(f.ref, "light.plant")!;
  const before = binding.read()!;
  assert.equal(before.channels.length, 0);
  assert.equal(before.schedule?.save, undefined);
  assert.equal(before.schedule?.preview, undefined);
  assert.match(before.schedule?.readOnlyNote ?? "", /isn't supported yet/);
  let changed = 0;
  const arrived = Promise.withResolvers<void>();
  const dispose = binding.connect!(() => {
    changed++;
    arrived.resolve();
  });
  await arrived.promise;
  assert.equal(changed, 1);
  assert.deepEqual(f.ws[0], { type: "fluvalble/get_schedule", entry_id: "e1", refresh: false });
  const after = binding.read()!;
  assert.deepEqual(after.channels.map((c) => c.name), ["Pink", "Blue", "Cold White", "White", "Warm White"]);
  assert.equal(after.notices.length, 1, "the sliders say the light does not report its levels");
  assert.equal(after.effects?.offId, "off");
  assert.equal(after.effects?.demo, null);
  assert.deepEqual(after.tank, { rgb: [255, 255, 255] });
  assert.deepEqual(after.schedule?.programs.map((p) => p.id), ["automatic", "professional"]);
  const loaded = await after.schedule!.load("automatic");
  assert.equal(loaded.points.length, 6, "four points, plus the two that switch the light off at the sleep minute");
  dispose();
});

test("commands go to the integration's services: channels by position, effects, mode, buttons", async () => {
  const f = fixture({ "select.plant_mode": state("select.plant_mode", "manual", { options: ["manual", "automatic"], override_active: true }) });
  const binding = fluvalAdapter.bind(f.ref, "light.plant")!;
  const { commands } = binding;
  await commands.setPower(false);
  await commands.setBrightness(50);
  await commands.setChannels({ 0: 40, 4: 7.6 });
  await commands.selectEffect("Thunderstorm");
  await commands.selectEffect("off");
  await commands.activateSchedule("professional");
  await assert.rejects(commands.playDemo(), /no demo/);
  assert.deepEqual(f.services.map((s) => [s.domain, s.service, s.data]), [
    ["light", "turn_off", {}],
    ["light", "turn_on", { brightness: 128 }],
    ["fluvalble", "set_channels", { device_id: "dev1", red: 40, channel_5: 8 }],
    ["light", "turn_on", { effect: "Thunderstorm" }],
    ["light", "turn_on", { effect: "off" }],
    ["select", "select_option", { option: "professional" }],
  ]);
  const actions = binding.read()!.actions;
  assert.deepEqual(actions.map((a) => [a.id, a.unavailable]), [["sync-clock", undefined], ["return-to-schedule", undefined]]);
  await actions[1]!.run();
  assert.deepEqual(f.services.at(-1), { domain: "button", service: "press", data: {}, target: { entity_id: "button.plant_return_to_schedule" } });
});

test("return to schedule says why it cannot run when no override is active", () => {
  const binding = fluvalAdapter.bind(fixture().ref, "light.plant")!;
  assert.equal(binding.read()!.actions[1]!.unavailable, "No manual override is active.");
});

test("a running schedule and a running effect are reported as such", () => {
  const scheduled = fluvalAdapter.bind(fixture({ "select.plant_mode": state("select.plant_mode", "professional", { options: [] }) }).ref, "light.plant")!.read()!;
  assert.deepEqual(scheduled.running, { kind: "schedule", scheduleId: "professional" });
  assert.equal(scheduled.schedule?.runningId, "professional");
  const effect = fluvalAdapter.bind(fixture({ "light.plant": state("light.plant", "on", { brightness: 255, effect: "Thunderstorm", effect_list: EFFECTS }) }).ref, "light.plant")!.read()!;
  assert.deepEqual(effect.running, { kind: "effect", effectId: "Thunderstorm" });
  assert.deepEqual(effect.live(null, 0), effectDefs(EFFECTS)[0]!.glow);
});

// ---- "Reload from the light" ----

test("a reload the user asked for tells the integration to ask the light: refresh goes through to get_schedule", async () => {
  const f = fixture();
  const schedule = fluvalAdapter.bind(f.ref, "light.plant")!.read()!.schedule!;
  await schedule.load("automatic");
  await schedule.load("automatic", { refresh: true });
  assert.deepEqual(f.ws.map((m) => [m.type, m.entry_id, m.refresh]), [["fluvalble/get_schedule", "e1", false], ["fluvalble/get_schedule", "e1", true]]);
});

test("a reload is not swallowed by a plain read that is still in flight", async () => {
  const first = Promise.withResolvers<unknown>();
  let calls = 0;
  const f = fixture({}, () => (++calls === 1 ? first.promise : PAYLOAD));
  const schedule = fluvalAdapter.bind(f.ref, "light.plant")!.read()!.schedule!;
  const plain = schedule.load("automatic");
  const reload = schedule.load("automatic", { refresh: true });
  assert.deepEqual(f.ws.map((m) => m.refresh), [false], "the reload waits for the read under way");
  first.resolve(PAYLOAD);
  await Promise.all([plain, reload]);
  assert.deepEqual(f.ws.map((m) => m.refresh), [false, true], "then the light is asked");
});

test("a plain read shares a reload that is already in flight instead of asking twice", async () => {
  const gate = Promise.withResolvers<unknown>();
  const f = fixture({}, () => gate.promise);
  const schedule = fluvalAdapter.bind(f.ref, "light.plant")!.read()!.schedule!;
  const reload = schedule.load("automatic", { refresh: true });
  const plain = schedule.load("professional");
  gate.resolve(PAYLOAD);
  await Promise.all([reload, plain]);
  assert.deepEqual(f.ws.map((m) => m.refresh), [true]);
});

test("a reload the light did not answer is an error, not fresh data; a plain read still returns what was last read", async () => {
  const f = fixture({}, () => ({ ...PAYLOAD, refresh_ok: false }));
  const schedule = fluvalAdapter.bind(f.ref, "light.plant")!.read()!.schedule!;
  await assert.rejects(schedule.load("automatic", { refresh: true }), /The light didn't answer the refresh\./);
  assert.equal((await schedule.load("automatic")).points.length, 6);
  const answered = fixture({}, () => ({ ...PAYLOAD, refresh_ok: true }));
  assert.equal((await fluvalAdapter.bind(answered.ref, "light.plant")!.read()!.schedule!.load("automatic", { refresh: true })).points.length, 6);
});

test("re-binding the same light keeps its channel names and does not read them again", async () => {
  const f = fixture();
  const first = fluvalAdapter.bind(f.ref, "light.plant")!;
  const arrived = Promise.withResolvers<void>();
  first.connect!(() => arrived.resolve());
  await arrived.promise;
  const second = fluvalAdapter.bind(f.ref, "light.plant")!;
  assert.equal(second.read()!.channels.length, 5, "the Colour tab does not disappear while they are read again");
  second.connect!(() => undefined);
  assert.equal(f.ws.length, 1);
});

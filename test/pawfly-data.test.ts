import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAWFLY_CHANNELS,
  describePawflyStatus,
  effectCatalogue,
  endPreview,
  fetchProgram,
  fromServiceRows,
  levelsFromRgbw,
  optionForProgram,
  programFromOption,
  programInfos,
  readPawflyState,
  resolvePawflyEntities,
  saveProgram,
  sceneEffects,
  scheduleProgramsFor,
  setChannels,
  showPreview,
  toServiceRows,
  PAWFLY_PROGRAMS,
  type PawflyEntities,
} from "../src/adapters/pawfly-data.ts";
import type { CallWS, EntityRegistryEntry, HassEntityState } from "../src/types.ts";

const entry = (entity_id: string, device_id: string | null, extra: Partial<EntityRegistryEntry> = {}): EntityRegistryEntry => ({ entity_id, device_id, platform: "pawfly", ...extra });

const registry: Record<string, EntityRegistryEntry> = Object.fromEntries(
  [
    entry("light.tank", "dev1"),
    entry("select.tank_program", "dev1", { translation_key: "program" }),
    entry("sensor.tank_mode", "dev1", { translation_key: "mode" }),
    entry("binary_sensor.tank_connected", "dev1", { translation_key: "connected" }),
    entry("button.tank_release_link", "dev1", { translation_key: "release_link" }),
    // A second light on another device must never leak into the first one's siblings.
    entry("light.other", "dev2"),
    entry("select.other_program", "dev2", { translation_key: "program" }),
  ].map((e) => [e.entity_id, e]),
);

test("siblings are found through the configured light's device", () => {
  assert.deepEqual(resolvePawflyEntities(registry, "light.tank"), {
    deviceId: "dev1",
    light: "light.tank",
    program: "select.tank_program",
    mode: "sensor.tank_mode",
    connected: "binary_sensor.tank_connected",
  });
  assert.equal(resolvePawflyEntities(registry, "light.other")?.program, "select.other_program");
});

test("entity ids are the fallback when the registry has no translation keys", () => {
  const bare = { "light.tank": entry("light.tank", "dev1"), "select.tank_program": entry("select.tank_program", "dev1") };
  assert.equal(resolvePawflyEntities(bare, "light.tank")?.program, "select.tank_program");
});

test("a light missing from the registry still controls, but has no device or siblings", () => {
  assert.deepEqual(resolvePawflyEntities({}, "light.tank"), { deviceId: "", light: "light.tank" });
  assert.equal(resolvePawflyEntities(registry, "switch.tank"), null);
});

// ---- state ----

const entities: PawflyEntities = { deviceId: "dev1", light: "light.tank", program: "select.tank_program", mode: "sensor.tank_mode", connected: "binary_sensor.tank_connected" };
const EFFECTS = ["Cloudy", "Thunderstorm", "Sunny", "Moonlight", "Warm White", "Bright White", "Day", "RGB Cycle", "Demo"];
const state = (entity_id: string, value: string, attributes: Record<string, unknown> = {}): HassEntityState => ({ entity_id, state: value, attributes, last_changed: "", last_updated: "" });
const states = (...list: HassEntityState[]): Record<string, HassEntityState> => Object.fromEntries(list.map((s) => [s.entity_id, s]));

test("an on light in manual mode reads brightness, levels and the static effect list", () => {
  const reading = readPawflyState(
    states(state("light.tank", "on", { brightness: 128, rgbw_color: [255, 0, 0, 51], effect: null, effect_list: EFFECTS, mode: "manual", program: null, scenario: null, friendly_name: "Tank" }), state("binary_sensor.tank_connected", "on")),
    entities,
  )!;
  assert.equal(reading.phase, "on");
  assert.equal(reading.brightness, 50);
  assert.deepEqual(reading.mix, [100, 0, 0, 20]);
  assert.equal(reading.mode, "manual");
  assert.equal(reading.scene, null);
  assert.equal(reading.connected, true);
  assert.equal(reading.effectList.length, 9);
  assert.equal(reading.name, "Tank");
  assert.equal(reading.maxPoints, 12);
});

test("scene mode reports the running scene index and effect", () => {
  const reading = readPawflyState(states(state("light.tank", "on", { brightness: 255, rgbw_color: [0, 0, 0, 0], effect: "Sunny", effect_list: EFFECTS, mode: "scene", scenario: 2, program: null })), entities)!;
  assert.deepEqual([reading.mode, reading.scene, reading.effect, reading.program], ["scene", 2, "Sunny", null]);
});

test("the scene falls back to the effect's place in the list when the scenario attribute is missing", () => {
  const reading = readPawflyState(states(state("light.tank", "on", { brightness: 255, rgbw_color: [0, 0, 0, 0], effect: "Moonlight", effect_list: EFFECTS })), entities)!;
  assert.deepEqual([reading.mode, reading.scene], ["scene", 3]);
});

test("program mode reads the program, with the light's own program list, the name and the select as fallbacks", () => {
  const byIndex = readPawflyState(states(state("light.tank", "on", { brightness: 255, rgbw_color: [1, 1, 1, 1], mode: "program", program: 4, program_name: "DIY 2", effect_list: EFFECTS })), entities)!;
  assert.equal(byIndex.program?.slug, "diy_2");
  const custom = readPawflyState(
    states(state("light.tank", "on", { mode: "program", program: 7, effect_list: EFFECTS, programs: [{ program: 7, slug: "night_owl", name: "Night owl", editable: true }] })),
    entities,
  )!;
  assert.deepEqual([custom.program?.slug, custom.programs.map((p) => p.slug)], ["night_owl", ["night_owl"]]);
  const bySelect = readPawflyState(states(state("light.tank", "on", { mode: "program", effect_list: EFFECTS }), state("select.tank_program", "dutch_style", { options: ["manual", "dutch_style"] })), entities)!;
  assert.equal(bySelect.program?.slug, "dutch_style");
  assert.deepEqual(bySelect.programOptions, ["manual", "dutch_style"]);
});

test("an off light has no brightness or mix (HA drops them) but keeps its mode and effect list", () => {
  const reading = readPawflyState(states(state("light.tank", "off", { effect_list: EFFECTS, mode: "manual", program: null, scenario: null })), entities)!;
  assert.deepEqual([reading.phase, reading.brightness, reading.mix, reading.mode], ["off", null, null, "manual"]);
  assert.equal(reading.effectList.length, 9);
});

test("an unavailable light is unavailable, and the link sensor says why", () => {
  const reading = readPawflyState(states(state("light.tank", "unavailable", { effect_list: EFFECTS }), state("binary_sensor.tank_connected", "off"), state("sensor.tank_mode", "unavailable")), entities)!;
  assert.deepEqual([reading.phase, reading.connected, reading.mode, reading.mix], ["unavailable", false, null, null]);
});

test("the mode sensor stands in when the light attribute is missing", () => {
  assert.equal(readPawflyState(states(state("light.tank", "off", {}), state("sensor.tank_mode", "scene")), entities)!.mode, "scene");
});

test("no light state yet means the card is still loading", () => {
  assert.equal(readPawflyState({}, entities), null);
});

test("the light's static scene colours and point limit are honoured", () => {
  const reading = readPawflyState(states(state("light.tank", "on", { scene_colors: { Sunny: [100, 90, 80, 70], Broken: "nope" }, max_program_points: 10, effect_list: EFFECTS })), entities)!;
  assert.deepEqual(reading.sceneColours, { Sunny: [100, 90, 80, 70] });
  assert.equal(reading.maxPoints, 10);
});

test("rgbw_color bytes read as percent levels, and unusable values are rejected", () => {
  assert.deepEqual(levelsFromRgbw([255, 0, 128, 51]), [100, 0, 50, 20]);
  assert.equal(levelsFromRgbw(null), null);
  assert.equal(levelsFromRgbw([1, 2, 3]), null);
  assert.equal(levelsFromRgbw([1, 2, 3, "x"]), null);
});

// ---- programs and scenes ----

test("program options are recognised by slug or display name, and manual is not a program", () => {
  assert.equal(programFromOption("dutch_style")?.index, 1);
  assert.equal(programFromOption("Dutch style")?.index, 1);
  assert.equal(programFromOption("DIY 3")?.slug, "diy_3");
  assert.equal(programFromOption("manual"), null);
  assert.equal(programFromOption(null), null);
});

test("activation uses the select's own option value, falling back to the contract slug", () => {
  const diy2 = PAWFLY_PROGRAMS[4]!;
  assert.equal(optionForProgram(diy2, ["manual", "DIY 2"]), "DIY 2");
  assert.equal(optionForProgram(diy2, ["manual", "diy_2"]), "diy_2");
  assert.equal(optionForProgram(PAWFLY_PROGRAMS[0]!, undefined), "japanese_style");
});

test("programs are grouped into presets and the user's own", () => {
  const list = scheduleProgramsFor(programInfos(undefined));
  assert.deepEqual(list.map((p) => [p.id, p.group, p.editable]), [
    ["japanese_style", "Presets", false],
    ["dutch_style", "Presets", false],
    ["jungle_style", "Presets", false],
    ["diy_1", "Your programs", true],
    ["diy_2", "Your programs", true],
    ["diy_3", "Your programs", true],
  ]);
  assert.equal(programInfos([{ program: "x" }]).length, 6, "an unusable attribute falls back to the table");
});

test("the effect list splits into eight scenes in device order plus Demo", () => {
  const catalogue = effectCatalogue(EFFECTS);
  assert.equal(catalogue.scenes.length, 8);
  assert.equal(catalogue.demo, "Demo");
  assert.deepEqual(effectCatalogue(["Demo", "One", "Two"]), { demo: "Demo", scenes: ["One", "Two"] });
  assert.deepEqual(effectCatalogue([]), { scenes: [], demo: null });
});

test("scene tiles carry the app's icons, mirror colours and the two animated scenes", () => {
  const tiles = sceneEffects(effectCatalogue(EFFECTS).scenes, null);
  assert.equal(tiles[0]!.icon, "weatherPartlyCloudy");
  assert.deepEqual(tiles[2]!.glow, { levels: [100, 100, 100, 100] });
  assert.deepEqual([tiles[1]!.motion, tiles[7]!.motion, tiles[0]!.motion], ["storm", "cycle", undefined]);
  assert.equal(tiles[7]!.art, "cycle");
  const override = sceneEffects(["Sunny"], { Sunny: [1, 2, 3, 4] });
  assert.deepEqual(override[0]!.glow, { levels: [1, 2, 3, 4] });
});

// ---- status wording ----

const reading = (over: Partial<NonNullable<ReturnType<typeof readPawflyState>>> = {}) => ({
  ...readPawflyState(states(state("light.tank", "on", { brightness: 204, rgbw_color: [25, 51, 76, 102], mode: "manual", effect_list: EFFECTS }), state("binary_sensor.tank_connected", "on")), entities)!,
  ...over,
});

test("a connected manual light reads as connected plus manual colour", () => {
  const status = describePawflyStatus(reading());
  assert.deepEqual(status.chips, [{ label: "Connected", kind: "positive", icon: "bluetooth" }]);
  assert.equal(status.mode, "Manual colour");
  assert.match(status.summary, /80% brightness/);
  assert.match(status.summary, /red 10%/);
});

test("scene and schedule modes name what is running, in plain words", () => {
  assert.equal(describePawflyStatus(reading({ mode: "scene", scene: 2, effect: "Sunny" })).mode, "Sunny scene");
  assert.equal(describePawflyStatus(reading({ mode: "scene", scene: 1, effect: null })).mode, "Thunderstorm scene");
  assert.equal(describePawflyStatus(reading({ mode: "program", program: PAWFLY_PROGRAMS[4]! })).mode, "DIY 2 schedule");
  assert.equal(describePawflyStatus(reading({ mode: "program", program: null })).mode, "Schedule");
});

test("off keeps the link state; unavailable says why through the link sensor; loading says connecting", () => {
  assert.equal(describePawflyStatus(reading({ phase: "off", brightness: null, mix: null })).mode, "Off");
  const down = describePawflyStatus(reading({ phase: "unavailable", connected: false, mode: null }));
  assert.deepEqual(down.chips, [{ label: "Disconnected", kind: "warning", icon: "bluetoothOff" }]);
  assert.match(down.summary, /Bluetooth link/);
  assert.equal(describePawflyStatus(reading({ phase: "unavailable", connected: null, mode: null })).chips[0]!.label, "Unavailable");
  assert.equal(describePawflyStatus(null).chips[0]!.label, "Connecting");
});

// ---- services ----

function recorder(reply: (message: Record<string, unknown>) => unknown) {
  const messages: Array<Record<string, unknown>> = [];
  const callWS = (async (message: Record<string, unknown>) => {
    messages.push(message);
    return reply(message);
  }) as CallWS;
  return { messages, callWS };
}

test("service rows are read tolerantly: bad rows dropped, levels clamped, sorted, duplicates collapsed", () => {
  const points = fromServiceRows([
    { time: "12:00", red: 100, green: 100, blue: 100, white: 100 },
    { time: "06:30", red: -4, green: 50.4, blue: "20", white: 999 },
    { time: "12:00", red: 1, green: 1, blue: 1, white: 1 },
    { time: "25:00", red: 1, green: 1, blue: 1, white: 1 },
    { red: 1 },
    null,
  ]);
  assert.deepEqual(points, [
    { minutes: 390, levels: [0, 50, 20, 100] },
    { minutes: 720, levels: [100, 100, 100, 100] },
  ]);
  assert.deepEqual(fromServiceRows("nope"), []);
});

test("points serialise sorted in the backend's shape", () => {
  assert.deepEqual(toServiceRows([{ minutes: 1080, levels: [30, 30, 30, 30] }, { minutes: 375, levels: [1, 2, 3, 4] }]), [
    { time: "06:15", red: 1, green: 2, blue: 3, white: 4 },
    { time: "18:00", red: 30, green: 30, blue: 30, white: 30 },
  ]);
});

test("get_program goes through call_service with return_response and becomes generic program data", async () => {
  const { messages, callWS } = recorder(() => ({
    context: {},
    response: { program: 3, name: "DIY 1", source: "device", editable: true, points: [{ time: "18:00", red: 10, green: 20, blue: 30, white: 40 }, { time: "06:00", red: 0, green: 0, blue: 0, white: 0 }] },
  }));
  const data = await fetchProgram(callWS, "dev1", PAWFLY_PROGRAMS[3]!);
  assert.deepEqual(messages[0], { type: "call_service", domain: "pawfly", service: "get_program", service_data: { device_id: "dev1", program: 3 }, return_response: true });
  assert.deepEqual([data.id, data.editable, data.source], ["diy_1", true, "device"]);
  assert.deepEqual(data.points, [{ minutes: 360, levels: [0, 0, 0, 0] }, { minutes: 1080, levels: [10, 20, 30, 40] }]);
});

test("presets carry an honest note, and the Dutch one says the light is dimmer than the table", async () => {
  const preset = recorder(() => ({ context: {}, response: { program: 1, source: "preset", editable: false, points: [] } }));
  const dutch = await fetchProgram(preset.callWS, "dev1", PAWFLY_PROGRAMS[1]!);
  assert.match(dutch.note ?? "", /Shown as in the vendor app\..*dimmer between 08:00 and 11:00/);
  const jungle = await fetchProgram(preset.callWS, "dev1", PAWFLY_PROGRAMS[2]!);
  assert.equal(jungle.note, "Shown as in the vendor app.");
  const device = recorder(() => ({ context: {}, response: { program: 3, source: "device", editable: true, points: [] } }));
  assert.equal((await fetchProgram(device.callWS, "dev1", PAWFLY_PROGRAMS[3]!)).note, undefined);
});

test("a response missing metadata falls back to the program table, and a missing payload is an error", async () => {
  const bare = recorder(() => ({ context: {}, response: { program: 0, points: [] } }));
  const data = await fetchProgram(bare.callWS, "dev1", PAWFLY_PROGRAMS[0]!);
  assert.deepEqual([data.name, data.editable, data.source], ["Japanese style", false, null]);
  const empty = recorder(() => ({ context: {} }));
  await assert.rejects(fetchProgram(empty.callWS, "dev1", PAWFLY_PROGRAMS[0]!), /no data/);
});

test("saving uploads sorted service rows and reports the read-back the light returned", async () => {
  const { messages, callWS } = recorder(() => ({ context: {}, response: { program: 4, verified: true, points: [{ time: "06:15", red: 1, green: 2, blue: 3, white: 4 }] } }));
  const saved = await saveProgram(callWS, "dev1", PAWFLY_PROGRAMS[4]!, [{ minutes: 1080, levels: [9, 9, 9, 9] }, { minutes: 375, levels: [1, 2, 3, 4] }]);
  assert.deepEqual(messages[0]!.service_data, {
    device_id: "dev1",
    program: 4,
    points: [
      { time: "06:15", red: 1, green: 2, blue: 3, white: 4 },
      { time: "18:00", red: 9, green: 9, blue: 9, white: 9 },
    ],
  });
  assert.equal(saved.verified, true);
  assert.deepEqual(saved.points, [{ minutes: 375, levels: [1, 2, 3, 4] }]);
});

test("a save answer without a read-back is never reported as verified", async () => {
  const { callWS } = recorder(() => ({ context: {}, response: { program: 3, verified: true } }));
  const sent = [{ minutes: 60, levels: [1, 1, 1, 1] }];
  const saved = await saveProgram(callWS, "dev1", PAWFLY_PROGRAMS[3]!, sent);
  assert.equal(saved.verified, false);
  assert.deepEqual(saved.points, sent);
});

test("preview and set_channel calls carry percent levels, or the end flag, or only the given channels", async () => {
  const { messages, callWS } = recorder(() => ({ context: {} }));
  await showPreview(callWS, "dev1", [1, 2, 3, 4]);
  await endPreview(callWS, "dev1");
  await setChannels(callWS, "dev1", { 3: 55, 0: 250 });
  assert.deepEqual(messages[0], { type: "call_service", domain: "pawfly", service: "preview", service_data: { device_id: "dev1", red: 1, green: 2, blue: 3, white: 4 } });
  assert.deepEqual(messages[1]!.service_data, { device_id: "dev1", end: true });
  assert.deepEqual(messages[2]!.service_data, { device_id: "dev1", white: 55, red: 100 });
  assert.equal(PAWFLY_CHANNELS.length, 4);
});

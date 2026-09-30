import { test } from "node:test";
import assert from "node:assert/strict";
import { bindLight, findSupportedLights } from "../src/adapters/index.ts";
import { pawflyAdapter } from "../src/adapters/pawfly.ts";
import type { HassRef } from "../src/adapters/types.ts";
import type { EntityRegistryEntry, HassEntityState, HomeAssistant } from "../src/types.ts";

const EFFECTS = ["Cloudy", "Thunderstorm", "Sunny", "Moonlight", "Warm White", "Bright White", "Day", "RGB Cycle", "Demo"];
const entry = (entity_id: string, extra: Partial<EntityRegistryEntry> = {}): EntityRegistryEntry => ({ entity_id, device_id: "dev1", platform: "pawfly", ...extra });
const state = (entity_id: string, value: string, attributes: Record<string, unknown> = {}): HassEntityState => ({ entity_id, state: value, attributes, last_changed: "", last_updated: "" });

interface Fixture {
  ref: HassRef;
  services: Array<{ domain: string; service: string; data: unknown; target: unknown }>;
  ws: Array<Record<string, unknown>>;
  setLight(state: string, attributes: Record<string, unknown>): void;
}

function fixture(lightState = "on", attributes: Record<string, unknown> = {}, reply: (message: Record<string, unknown>) => unknown = () => ({ context: {} })): Fixture {
  const services: Fixture["services"] = [];
  const ws: Fixture["ws"] = [];
  const hass = {
    states: {
      "light.tank": state("light.tank", lightState, { brightness: 255, rgbw_color: [255, 0, 0, 0], effect_list: EFFECTS, mode: "manual", friendly_name: "Tank", ...attributes }),
      "select.tank_program": state("select.tank_program", "manual", { options: ["manual", "japanese_style", "dutch_style", "jungle_style", "diy_1", "diy_2", "diy_3"] }),
      "binary_sensor.tank_connected": state("binary_sensor.tank_connected", "on"),
    } as Record<string, HassEntityState>,
    entities: {
      "light.tank": entry("light.tank"),
      "select.tank_program": entry("select.tank_program", { translation_key: "program" }),
      "binary_sensor.tank_connected": entry("binary_sensor.tank_connected", { translation_key: "connected" }),
      "light.kitchen": entry("light.kitchen", { platform: "hue", device_id: "dev9" }),
    },
    devices: {},
    callService: async (domain: string, service: string, data?: Record<string, unknown>, target?: Record<string, unknown>) => {
      services.push({ domain, service, data, target });
    },
    callWS: async (message: Record<string, unknown>) => {
      ws.push(message);
      return reply(message);
    },
  } as unknown as HomeAssistant;
  const ref: HassRef = { current: hass };
  return {
    ref,
    services,
    ws,
    setLight(next, attrs) {
      hass.states["light.tank"] = state("light.tank", next, attrs);
    },
  };
}

const bind = (f: Fixture) => pawflyAdapter.bind(f.ref, "light.tank")!;

test("only pawfly lights are bound, and the registry decides the adapter", () => {
  const f = fixture();
  assert.equal(pawflyAdapter.bind(f.ref, "light.tank")?.platform, "pawfly");
  assert.equal(pawflyAdapter.bind(f.ref, "switch.tank"), null);
  assert.equal(bindLight(f.ref, "light.tank")?.platform, "pawfly");
  assert.equal(bindLight(f.ref, "light.kitchen"), null, "no adapter claims a Hue light");
  assert.deepEqual(findSupportedLights(f.ref.current), ["light.tank"]);
});

test("a manual light becomes a model with channels, levels, swatches, scenes and schedule programs", () => {
  const f = fixture();
  const binding = bind(f);
  const model = binding.read()!;
  assert.deepEqual([model.phase, model.hasBrightness, model.brightness, model.levels], ["on", true, 100, [100, 0, 0, 0]]);
  assert.deepEqual(model.channels.map((c) => c.id), ["red", "green", "blue", "white"]);
  assert.deepEqual(model.running, { kind: "manual" });
  assert.equal(model.swatches.length, 8);
  assert.equal(model.effects?.effects.length, 8);
  assert.equal(model.effects?.demo?.available, false, "no schedule is running, so the Demo has nothing to replay");
  assert.equal(model.schedule?.programs.length, 6);
  assert.equal(model.schedule?.runningId, null);
  assert.equal(model.schedule?.maxPoints, 12);
  assert.equal(model.lightingPrograms, undefined, "lighting programs belong to the Fluval only");
  assert.deepEqual(binding.watch, ["light.tank", "select.tank_program", "binary_sensor.tank_connected"]);
  assert.equal(binding.deviceId, "dev1");
  assert.equal(model.status.mode, "Manual colour");
});

test("no light state yet reads as null", () => {
  const f = fixture();
  delete f.ref.current.states["light.tank"];
  assert.equal(bind(f).read(), null);
});

test("scene mode draws the tank from the scene's own colours, not the status colour", () => {
  const f = fixture("on", { mode: "scene", scenario: 2, effect: "Sunny", rgbw_color: [255, 0, 0, 0] });
  const model = bind(f).read()!;
  assert.deepEqual(model.running, { kind: "effect", effectId: "Sunny" });
  assert.equal(model.effects?.runningId, "Sunny");
  assert.deepEqual(model.live(null, 600), { levels: [100, 100, 100, 100] });
});

test("schedule mode draws the tank from the running program's curve at the current minute", () => {
  const f = fixture("on", { mode: "program", program: 1 });
  const model = bind(f).read()!;
  assert.deepEqual(model.running, { kind: "schedule", scheduleId: "dutch_style" });
  assert.equal(model.schedule?.runningId, "dutch_style");
  assert.equal(model.effects?.demo?.available, true);
  const program = { id: "dutch_style", name: "Dutch style", editable: false, source: "preset" as const, points: [{ minutes: 0, levels: [0, 0, 0, 0] }, { minutes: 600, levels: [100, 50, 0, 20] }] };
  assert.deepEqual(model.live(program, 300), { levels: [50, 25, 0, 10] });
  assert.equal(model.live(null, 300), null, "until the program is loaded there is nothing to draw");
  assert.deepEqual(model.live({ ...program, points: [] }, 300), { levels: [0, 0, 0, 0] }, "an empty program is dark");
  assert.equal(bind(fixture("on", { mode: "manual" })).read()!.live(null, 0), null);
});

test("off and unavailable lights carry no live colour", () => {
  assert.equal(bind(fixture("off", { brightness: undefined, rgbw_color: undefined })).read()!.phase, "off");
  const unavailable = bind(fixture("unavailable", {})).read()!;
  assert.equal(unavailable.phase, "unavailable");
  assert.equal(unavailable.live(null, 0), null);
});

test("commands go to the integration's own services", async () => {
  const f = fixture("on", { mode: "manual" });
  const { commands } = bind(f);
  await commands.setPower(false);
  await commands.setBrightness(100);
  await commands.selectEffect("Sunny");
  await commands.setChannels({ 0: 40, 3: 5 });
  assert.deepEqual(f.services.map((s) => [s.domain, s.service, s.data, s.target]), [
    ["light", "turn_off", {}, { entity_id: "light.tank" }],
    ["light", "turn_on", { brightness: 255 }, { entity_id: "light.tank" }],
    ["light", "turn_on", { effect: "Sunny" }, { entity_id: "light.tank" }],
  ]);
  assert.deepEqual(f.ws[0], { type: "call_service", domain: "pawfly", service: "set_channel", service_data: { device_id: "dev1", red: 40, white: 5 } });
});

test("the Demo uses the light's own Demo effect; activating a program uses the select's option", async () => {
  const f = fixture("on", { mode: "program", program: 1 });
  const { commands } = bind(f);
  await commands.playDemo();
  await commands.activateSchedule("diy_2");
  assert.deepEqual(f.services[0], { domain: "light", service: "turn_on", data: { effect: "Demo" }, target: { entity_id: "light.tank" } });
  assert.deepEqual(f.services[1], { domain: "select", service: "select_option", data: { option: "diy_2" }, target: { entity_id: "select.tank_program" } });
  await assert.rejects(commands.activateSchedule("nope"), /no program called nope/);
});

test("a light with no device cannot be sent channel writes, and says why", async () => {
  const f = fixture();
  f.ref.current.entities["light.tank"] = entry("light.tank", { device_id: null });
  await assert.rejects(bind(f).commands.setChannels({ 0: 1 }), /not linked to a Home Assistant device/);
});

test("schedule load, save and preview call the pawfly services with the device id", async () => {
  const f = fixture("on", { mode: "manual" }, (message) => {
    const data = message.service_data as Record<string, unknown>;
    if (message.service === "get_program") return { context: {}, response: { program: data.program, editable: true, source: "device", points: [{ time: "08:00", red: 1, green: 2, blue: 3, white: 4 }] } };
    if (message.service === "set_program") return { context: {}, response: { verified: true, points: data.points } };
    return { context: {} };
  });
  const schedule = bind(f).read()!.schedule!;
  const loaded = await schedule.load("diy_3");
  assert.deepEqual([loaded.id, loaded.editable], ["diy_3", true]);
  assert.deepEqual(loaded.points, [{ minutes: 480, levels: [1, 2, 3, 4] }]);
  const saved = await schedule.save!("diy_3", [{ minutes: 480, levels: [1, 2, 3, 4] }]);
  assert.equal(saved.verified, true);
  await schedule.preview!.show([9, 8, 7, 6]);
  await schedule.preview!.end();
  assert.deepEqual(f.ws.map((m) => [m.service, (m.service_data as Record<string, unknown>).program ?? (m.service_data as Record<string, unknown>).end ?? (m.service_data as Record<string, unknown>).red]), [
    ["get_program", 5],
    ["set_program", 5],
    ["preview", 9],
    ["preview", true],
  ]);
  await assert.rejects(schedule.load("bogus"), /no program called bogus/);
  assert.equal(schedule.newProgramPoints().length, 6);
});

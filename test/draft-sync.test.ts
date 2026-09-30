import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftSync } from "../src/lib/draft-sync.ts";
import { cleanEquipmentConfig, formFromEquipmentConfig, type EquipmentFormData } from "../src/lib/equipment-config.ts";
import { cleanLightConfig, formFromLightConfig, usableProgram, type LightFormData } from "../src/lib/light-config.ts";
import type { AquariumCardConfig, EquipmentCardConfig } from "../src/types.ts";

const EQUIPMENT: EquipmentCardConfig = { type: "custom:aquarium-equipment-card" };
const equipment = (initial: EquipmentCardConfig = EQUIPMENT) => new DraftSync<EquipmentFormData, EquipmentCardConfig>(formFromEquipmentConfig, cleanEquipmentConfig, initial);

// ---- the draft ----

test("a field entered before the one it needs is still there when the other arrives", () => {
  const sync = equipment();
  // The person picks the program helper first: the card cannot use that yet, so the configuration
  // has no program block - but the form must keep what was picked.
  const first = sync.edit({ ...sync.draft, program: { select: "input_select.p" } }, EQUIPMENT);
  assert.equal(first.program, undefined);
  assert.deepEqual(sync.draft.program, { select: "input_select.p" });

  // Home Assistant hands the configuration back: that is the echo of the change, not new input.
  assert.equal(sync.receive(first), false);
  assert.deepEqual(sync.draft.program, { select: "input_select.p" }, "the echo did not wipe the half-filled field");

  const second = sync.edit({ ...sync.draft, program: { ...sync.draft.program, automation: "automation.a" } }, first);
  assert.deepEqual(second.program, { select: "input_select.p", automation: "automation.a" });
  assert.equal(sync.receive(second), false);
});

test("an outlet with no switch yet stays in the form", () => {
  const sync = equipment();
  const config = sync.edit({ outlets: [{ switch: "switch.a", role: "filter" }, { switch: "" }] }, EQUIPMENT);
  assert.deepEqual(config.outlets, [{ switch: "switch.a", role: "filter" }]);
  sync.receive(config);
  assert.equal(sync.draft.outlets?.length, 2);
});

test("a configuration that is not the echo replaces the form", () => {
  const sync = equipment();
  const mine = sync.edit({ name: "From the form" }, EQUIPMENT);
  assert.equal(sync.receive({ ...mine, name: "Changed in YAML" }), true);
  assert.equal(sync.draft.name, "Changed in YAML");
});

test("only the very next configuration can be the echo", () => {
  const sync = equipment();
  const mine = sync.edit({ name: "One" }, EQUIPMENT);
  assert.equal(sync.receive(mine), false);
  assert.equal(sync.receive(mine), true, "the same configuration arriving later is new input, so the form follows it");
});

test("a different card opened in the same editor starts from its own configuration", () => {
  const sync = equipment();
  sync.edit({ name: "Half done", program: { select: "input_select.p" } }, EQUIPMENT);
  const other: EquipmentCardConfig = { type: EQUIPMENT.type, name: "Other", outlets: [{ switch: "switch.z" }] };
  assert.equal(sync.receive(other), true);
  assert.deepEqual(sync.draft, { name: "Other", temperature: {}, outlets: [{ switch: "switch.z" }], program: {} });
});

test("the echo is recognised whatever order the keys arrive in", () => {
  const sync = equipment();
  const mine = sync.edit({ temperature: { entity: "sensor.t", min: 70, max: 80 }, name: "Tank" }, EQUIPMENT);
  const reordered = JSON.parse(JSON.stringify({ outlets: mine.outlets, name: mine.name, temperature: { max: 80, entity: "sensor.t", min: 70 }, type: mine.type })) as EquipmentCardConfig;
  assert.equal(sync.receive(reordered), false);
});

// ---- the light card's form ----

const LIGHT: AquariumCardConfig = { type: "custom:aquarium-light-card", entity: "light.plant" };
const light = (initial: AquariumCardConfig = LIGHT) => new DraftSync<LightFormData, AquariumCardConfig>(formFromLightConfig, cleanLightConfig, initial);

test("the light card's form starts from its configuration, with the tab following the light by default", () => {
  assert.deepEqual(light().draft, { entity: "light.plant", name: undefined, tab: "auto", program: {} });
  assert.equal(light({ ...LIGHT, tab: "program" }).draft.tab, "program");
});

test("empty fields are left out of the light card's configuration and unknown settings are kept", () => {
  const base = { ...LIGHT, name: "Old", tab: "colour", grid_options: { columns: 12 } } as AquariumCardConfig;
  const sync = light(base);
  const clean = sync.edit({ entity: "light.plant", name: "", tab: "auto", program: { select: "", automation: "" } }, base);
  assert.deepEqual(clean, { type: LIGHT.type, entity: "light.plant", grid_options: { columns: 12 } });
});

test("program settings are kept as typed, even half filled, and the card uses them only when both are named", () => {
  const sync = light();
  const half = sync.edit({ ...sync.draft, program: { select: "input_select.p", started: "input_datetime.s" } }, LIGHT);
  assert.deepEqual(half.program, { select: "input_select.p", started: "input_datetime.s" });
  assert.equal(usableProgram(half.program), undefined, "no automation yet: no Program tab");
  const full = sync.edit({ ...sync.draft, program: { ...half.program, automation: "automation.a", reapply: "input_button.r" } }, half);
  assert.deepEqual(usableProgram(full.program), { select: "input_select.p", automation: "automation.a", started: "input_datetime.s", reapply: "input_button.r" });
  assert.equal(usableProgram(undefined), undefined);
  assert.equal(usableProgram({ select: "", automation: "automation.a" }), undefined);
});

test("the light card configuration is written in reading order too", () => {
  const base = { grid_options: { columns: 12 }, tab: "colour", name: "Old", entity: "light.plant", type: LIGHT.type } as AquariumCardConfig;
  const clean = cleanLightConfig({ entity: "light.plant", name: "New", tab: "effects", program: { select: "input_select.p", automation: "automation.a" } }, base);
  assert.deepEqual(Object.keys(clean), ["type", "entity", "name", "tab", "program", "grid_options"]);
});

test("choosing the Program tab is kept, and switching back to following the light removes the key", () => {
  const sync = light();
  assert.equal(sync.edit({ ...sync.draft, tab: "program" }, LIGHT).tab, "program");
  assert.equal("tab" in sync.edit({ ...sync.draft, tab: "auto" }, LIGHT), false);
});

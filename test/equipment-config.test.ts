import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEquipmentConfig, equipmentConfigError, formFromEquipmentConfig } from "../src/lib/equipment-config.ts";
import type { EquipmentCardConfig } from "../src/types.ts";

const BASE: EquipmentCardConfig = { type: "custom:aquarium-equipment-card" };

test("a card with a thermometer, outlets and programs is usable", () => {
  assert.equal(equipmentConfigError({ type: "x", temperature: { entity: "sensor.t", min: 74, max: 80 }, outlets: [{ switch: "switch.filter", critical: true }], program: { select: "input_select.p", automation: "automation.a" } }), null);
  assert.equal(equipmentConfigError({ type: "x" }), null, "an empty card shows a hint instead of failing, so the editor's preview works");
  assert.equal(equipmentConfigError({ type: "x", outlets: [] }), null);
});

test("the mistakes people make are named in words they can act on", () => {
  assert.match(equipmentConfigError(undefined) ?? "", /missing/);
  assert.match(equipmentConfigError({ type: "x", outlets: "switch.filter" }) ?? "", /outlets must be a list/);
  assert.match(equipmentConfigError({ type: "x", outlets: [{ switch: "switch.a" }, { power: "sensor.p" }] }) ?? "", /outlet 2 needs a switch/);
  assert.match(equipmentConfigError({ type: "x", outlets: [{ switch: "light.lamp" }] }) ?? "", /outlet 1 needs a switch/);
  assert.match(equipmentConfigError({ type: "x", outlets: [null] }) ?? "", /outlet 1/);
  assert.match(equipmentConfigError({ type: "x", temperature: {} }) ?? "", /temperature needs an entity/);
  assert.match(equipmentConfigError({ type: "x", temperature: "sensor.t" }) ?? "", /temperature needs an entity/);
});

test("the form's values become a clean configuration, leaving empty fields out", () => {
  const clean = cleanEquipmentConfig(
    {
      name: "Plant room tank",
      temperature: { entity: "sensor.t", min: 74, max: 80, battery: "" },
      outlets: [
        { switch: "switch.filter", power: "sensor.filter_power", role: "filter", critical: true },
        { switch: "switch.co2", power: "", role: "co2", guard: "program", critical: false },
      ],
      program: { select: "input_select.p", automation: "automation.a", started: "" },
    },
    BASE,
  );
  assert.deepEqual(clean, {
    type: "custom:aquarium-equipment-card",
    name: "Plant room tank",
    temperature: { entity: "sensor.t", min: 74, max: 80 },
    outlets: [
      { switch: "switch.filter", power: "sensor.filter_power", role: "filter", critical: true },
      { switch: "switch.co2", role: "co2", guard: "program" },
    ],
    program: { select: "input_select.p", automation: "automation.a" },
  });
});

test("blocks that cannot work yet are left out of the card's configuration while the form is being filled in", () => {
  const clean = cleanEquipmentConfig(
    {
      temperature: { min: 74, max: 80 },
      outlets: [{ switch: "" } as never, { switch: "switch.spare", role: "toaster" as never, guard: "other" as never }],
      program: { select: "input_select.p" },
    },
    BASE,
  );
  assert.equal(clean.temperature, undefined, "a range without a sensor means nothing");
  assert.deepEqual(clean.outlets, [{ switch: "switch.spare" }], "an outlet without a switch is dropped; an unknown role or guard is not kept");
  assert.equal(clean.program, undefined, "programs need both the helper and the automation");
  assert.equal(equipmentConfigError(clean), null, "whatever the form holds, the card can still be shown");
});

test("numbers that are not numbers are not kept", () => {
  const clean = cleanEquipmentConfig({ temperature: { entity: "sensor.t", min: Number.NaN, max: "80" as never } }, BASE);
  assert.deepEqual(clean.temperature, { entity: "sensor.t" });
});

test("settings the form knows nothing about survive an edit, and a cleared name goes", () => {
  const base = { ...BASE, name: "Old", grid_options: { columns: 12 }, visibility: [{ condition: "user" }], outlets: [{ switch: "switch.a" }] } as EquipmentCardConfig;
  const clean = cleanEquipmentConfig({ name: "", outlets: [{ switch: "switch.a" }] }, base);
  assert.deepEqual(clean, { type: BASE.type, grid_options: { columns: 12 }, visibility: [{ condition: "user" }], outlets: [{ switch: "switch.a" }] });
});

test("the configuration is written in reading order, with the other settings kept after it", () => {
  const base = { visibility: [{ condition: "user" }], outlets: [{ switch: "switch.a" }], type: BASE.type, name: "Old" } as EquipmentCardConfig;
  const clean = cleanEquipmentConfig({ name: "New", temperature: { entity: "sensor.t" }, outlets: [{ switch: "switch.a" }], program: { select: "input_select.p", automation: "automation.a" } }, base);
  assert.deepEqual(Object.keys(clean), ["type", "name", "temperature", "outlets", "program", "visibility"]);
});

test("no outlets at all is a valid, empty list", () => {
  assert.deepEqual(cleanEquipmentConfig({}, BASE).outlets, []);
});

test("the form of a configuration is a copy: editing it never edits the card's configuration", () => {
  const config: EquipmentCardConfig = { ...BASE, temperature: { entity: "sensor.t", min: 70, max: 80 }, outlets: [{ switch: "switch.a", critical: true }], program: { select: "input_select.p", automation: "automation.a" } };
  const form = formFromEquipmentConfig(config);
  form.temperature!.min = 1;
  form.outlets![0]!.critical = false;
  form.program!.select = "changed";
  assert.deepEqual(config.temperature, { entity: "sensor.t", min: 70, max: 80 });
  assert.equal(config.outlets![0]!.critical, true);
  assert.equal(config.program!.select, "input_select.p");
  assert.deepEqual(formFromEquipmentConfig(BASE), { name: undefined, temperature: {}, outlets: [], program: {} });
});

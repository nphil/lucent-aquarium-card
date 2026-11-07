import { test } from "node:test";
import assert from "node:assert/strict";
import { entityDisplayName } from "../src/lib/entity-name.ts";
import type { HassEntityState } from "../src/types.ts";

const state = (id: string, attributes: Record<string, unknown>): HassEntityState => ({ entity_id: id, state: "on", attributes, last_changed: "", last_updated: "" });

test("Home Assistant's own name formatter wins when it exists", () => {
  const hass = {
    states: { "switch.a": state("switch.a", { friendly_name: "Old Name" }) },
    entities: {},
    formatEntityName: (_state: HassEntityState, config?: unknown, options?: { separator?: string }) => (config ? `Device${options?.separator}Entity` : "wrong"),
  };
  assert.equal(entityDisplayName(hass, "switch.a"), "Device Entity");
});

test("without the formatter (Home Assistant before 2026.4) friendly_name is used", () => {
  const hass = { states: { "switch.a": state("switch.a", { friendly_name: "Tank Filter" }) }, entities: {} };
  assert.equal(entityDisplayName(hass, "switch.a"), "Tank Filter");
});

test("a formatter that throws or answers nothing falls back to friendly_name, then the registry name", () => {
  const states = { "switch.a": state("switch.a", { friendly_name: "Tank Filter" }), "switch.b": state("switch.b", {}) };
  const entities = { "switch.b": { entity_id: "switch.b", name: "Heater" } };
  assert.equal(entityDisplayName({ states, entities, formatEntityName: () => { throw new Error("boom"); } }, "switch.a"), "Tank Filter");
  assert.equal(entityDisplayName({ states, entities, formatEntityName: () => undefined }, "switch.b"), "Heater");
  assert.equal(entityDisplayName({ states, entities }, "switch.missing"), undefined);
  assert.equal(entityDisplayName({ states, entities }, undefined), undefined);
});

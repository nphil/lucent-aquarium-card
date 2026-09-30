/** Dev harness bootstrap: mounts one `aquarium-light-card` against the stateful fake hass.
 * Query: theme=dark|light|glass-dark|glass-light, width=<px>, state=on|off|unavailable|scene|program,
 * tab=colour|effects|schedule, latency=<ms>.
 */
import "./ha-card-shim.ts";
import type { AquariumCardConfig, HomeAssistant } from "../src/types.ts";
import { createFluvalMock, FLUVAL_LIGHT } from "./mock-fluval.ts";
import { createMockHass, LIGHT, type MockController, type Scenario } from "./mock-hass.ts";
import { applyTheme } from "./themes.ts";

interface CardElement extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: AquariumCardConfig): void;
}

declare global {
  interface Window {
    __mock?: { controller: MockController; card: CardElement; hass: () => HomeAssistant };
  }
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const width = Number(q.get("width")) || 375;
  const state = (["on", "off", "unavailable", "scene", "program"].includes(q.get("state") ?? "") ? q.get("state") : "on") as Scenario;
  const tabParam = q.get("tab");
  const tab = tabParam === "colour" || tabParam === "effects" || tabParam === "schedule" ? tabParam : null;
  const latency = q.get("latency");

  const themeName = q.get("theme") ?? "dark";
  applyTheme(themeName);

  const wrap = document.getElementById("wrap");
  if (!wrap) throw new Error("harness: #wrap missing");
  wrap.style.cssText = `width:${width}px;max-width:100%`;

  const fluval = q.get("light") === "fluval";
  const mock = fluval
    ? createFluvalMock({ state: q.get("state") ?? "on", mode: q.get("mode") ?? "automatic", ...(latency ? { latency: Number(latency) } : {}) })
    : createMockHass({ scenario: state, ...(latency !== null && latency !== "" ? { latency: Number(latency) } : {}) });
  const card = document.createElement("aquarium-light-card") as CardElement;
  wrap.append(card);
  window.__mock = { controller: mock.controller as MockController, card, hass: mock.current };

  await customElements.whenDefined("aquarium-light-card");
  card.setConfig({ type: "custom:aquarium-light-card", entity: fluval ? FLUVAL_LIGHT : LIGHT, ...(tab ? { tab } : {}) });
  const hassFor = (h: HomeAssistant): HomeAssistant => ({ ...h, themes: { ...h.themes, darkMode: themeName.endsWith("dark") || themeName === "dark" } });
  card.hass = hassFor(mock.hass);
  mock.subscribe((h) => { card.hass = hassFor(h); });
}

void main();

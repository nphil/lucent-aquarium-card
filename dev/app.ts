/** Dev harness bootstrap: mounts one `aquarium-light-card` (or, with card=equipment, one
 * `aquarium-equipment-card`) against the stateful fake hass.
 * Query: theme=dark|light|glass-dark|glass-light, width=<px>, state=on|off|unavailable|scene|program,
 * tab=colour|effects|schedule|program, latency=<ms>, light=fluval|pawfly.
 * Fluval only: mode=manual|automatic|professional, programs=0 (leave out the program settings),
 * admin=0 (a user who is not an administrator; add readable=1 if Home Assistant lets them read the
 * automation), program=<name> (the running program), pstart=<hours
 * ago it started>, reload=<ms Home Assistant takes to reload the automation after a save>,
 * fail=read|save.
 * Equipment card (card=equipment): temp=<°F>, tempstate=unavailable, stale=<hours since the thermometer
 * reported>, battery=<%>, admin=0, program=<name>, programs=0 (leave out the program settings),
 * unavailable=<roles, comma separated>, on=<roles that start on>, fail=history|switch.
 * Any card: at=HH:MM makes the page believe it is that time of day in Home Assistant's zone.
 */
import "./ha-card-shim.ts";
import type { AquariumCardConfig, HomeAssistant } from "../src/types.ts";
import { createEquipmentMock, EQUIPMENT, OUTLETS } from "./mock-equipment.ts";
import { createFluvalMock, FLUVAL_LIGHT, PROGRAM_ENTITIES, type FluvalMock } from "./mock-fluval.ts";
import { createMockHass, LIGHT, type MockController, type Scenario } from "./mock-hass.ts";
import { applyTheme } from "./themes.ts";

interface CardElement extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: AquariumCardConfig): void;
}

declare global {
  interface Window {
    __mock?: { controller: MockController; card: CardElement; hass: () => HomeAssistant; fluval?: FluvalMock };
  }
}

/** Make the page believe it is `at` (HH:MM) in Home Assistant's zone, by shifting `Date`. */
function setClock(at: string, timeZone: string): void {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!match) return;
  const RealDate = Date;
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(new RealDate());
  const now = Number(parts.find((part) => part.type === "hour")?.value) * 60 + Number(parts.find((part) => part.type === "minute")?.value);
  const offset = (Number(match[1]) * 60 + Number(match[2]) - now) * 60_000;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const clock = q.get("at");
  if (clock) setClock(clock, "Europe/London");
  const width = Number(q.get("width")) || 375;
  const state = (["on", "off", "unavailable", "scene", "program"].includes(q.get("state") ?? "") ? q.get("state") : "on") as Scenario;
  const tabParam = q.get("tab");
  const tab = tabParam === "colour" || tabParam === "effects" || tabParam === "schedule" || tabParam === "program" ? tabParam : null;
  const latency = q.get("latency");

  const themeName = q.get("theme") ?? "dark";
  applyTheme(themeName);

  const wrap = document.getElementById("wrap");
  if (!wrap) throw new Error("harness: #wrap missing");
  wrap.style.cssText = `width:${width}px;max-width:100%`;

  const numberOf = (name: string): number | undefined => {
    const raw = q.get(name);
    return raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  };

  if (q.get("card") === "equipment") {
    const failParam = q.get("fail");
    const list = (name: string): string[] | undefined => (q.get(name) ? (q.get(name) as string).split(",") : undefined);
    const mock = createEquipmentMock({
      admin: q.get("admin") !== "0",
      readable: q.get("readable") === "1",
      fail: failParam === "history" || failParam === "switch" ? failParam : "none",
      ...(numberOf("temp") !== undefined ? { temp: numberOf("temp") as number } : {}),
      ...(q.get("tempstate") ? { tempState: q.get("tempstate") as string } : {}),
      ...(numberOf("stale") !== undefined ? { staleHours: numberOf("stale") as number } : {}),
      ...(numberOf("battery") !== undefined ? { battery: numberOf("battery") as number } : {}),
      ...(numberOf("latency") !== undefined ? { latency: numberOf("latency") as number } : {}),
      ...(q.get("program") ? { program: q.get("program") as string } : {}),
      ...(list("unavailable") ? { unavailable: list("unavailable") as string[] } : {}),
      ...(list("on") ? { on: list("on") as string[] } : {}),
    });
    const card = document.createElement("aquarium-equipment-card") as CardElement;
    wrap.append(card);
    window.__mock = { controller: mock.controller as unknown as MockController, card, hass: mock.current };
    await customElements.whenDefined("aquarium-equipment-card");
    const critical = new Set(["filter", "heater"]);
    (card as unknown as { setConfig(config: unknown): void }).setConfig({
      type: "custom:aquarium-equipment-card",
      ...(q.get("name") ? { name: q.get("name") } : {}),
      temperature: { entity: EQUIPMENT.temperature, min: 74, max: 80, battery: EQUIPMENT.battery },
      outlets: OUTLETS.map((outlet) => ({ switch: outlet.switch, power: outlet.power, role: outlet.role, ...(critical.has(outlet.role) ? { critical: true } : {}), ...(outlet.role === "co2" ? { guard: "program" } : {}) })),
      ...(q.get("programs") !== "0" ? { program: { ...EQUIPMENT.program } } : {}),
    });
    const equipmentHass = (h: HomeAssistant): HomeAssistant => ({ ...h, themes: { ...h.themes, darkMode: themeName.endsWith("dark") || themeName === "dark" } });
    card.hass = equipmentHass(mock.hass);
    mock.subscribe((h) => { card.hass = equipmentHass(h); });
    return;
  }

  const fluval = q.get("light") === "fluval";
  const failParam = q.get("fail");
  const numberParam = numberOf;
  const fluvalMock = fluval
    ? createFluvalMock({
        state: q.get("state") ?? "on",
        mode: q.get("mode") ?? "automatic",
        admin: q.get("admin") !== "0",
        readable: q.get("readable") === "1",
        fail: failParam === "read" || failParam === "save" ? failParam : "none",
        ...(latency ? { latency: Number(latency) } : {}),
        ...(q.get("program") ? { program: q.get("program") as string } : {}),
        ...(numberParam("pstart") !== undefined ? { startedHoursAgo: numberParam("pstart") as number } : {}),
        ...(numberParam("reload") !== undefined ? { reloadMs: numberParam("reload") as number } : {}),
      })
    : null;
  const mock = fluvalMock ?? createMockHass({ scenario: state, ...(latency !== null && latency !== "" ? { latency: Number(latency) } : {}) });
  const card = document.createElement("aquarium-light-card") as CardElement;
  wrap.append(card);
  window.__mock = { controller: mock.controller as MockController, card, hass: mock.current, ...(fluvalMock ? { fluval: fluvalMock } : {}) };

  await customElements.whenDefined("aquarium-light-card");
  const programs = q.get("programs") !== "0" ? { program: { ...PROGRAM_ENTITIES } } : {};
  card.setConfig({ type: "custom:aquarium-light-card", entity: fluval ? FLUVAL_LIGHT : LIGHT, ...(tab ? { tab } : {}), ...(fluval || q.get("programs") === "1" ? programs : {}) });
  const hassFor = (h: HomeAssistant): HomeAssistant => ({ ...h, themes: { ...h.themes, darkMode: themeName.endsWith("dark") || themeName === "dark" } });
  card.hass = hassFor(mock.hass);
  mock.subscribe((h) => { card.hass = hassFor(h); });
}

void main();

/** Fake `hass` for the equipment card: a Matter power strip (a switch and a power sensor per
 * outlet), a YoLink-style thermometer in °F with its battery and 24 hours of history, the
 * lighting-program helpers and the automation that owns the programs (`automation/config`). The
 * switches follow the commands, and so do the power sensors, a moment later. */
import type { HassEntityState, HomeAssistant } from "../src/types.ts";
import { liveConfig } from "./program-fixture.ts";

export const EQUIPMENT = {
  temperature: "sensor.aquarium_temperature_sensor_temperature",
  battery: "sensor.aquarium_temperature_sensor_battery",
  program: { select: "input_select.aquarium_lighting_program", automation: "automation.plant_room_aquarium_co2_lights", started: "input_datetime.aquarium_program_started" },
} as const;

interface OutletDef {
  role: string;
  switch: string;
  power: string;
  name: string;
  /** Watts drawn when the outlet is on. */
  draw: number;
  /** Watts drawn when the outlet is off. */
  standby: number;
  on: boolean;
}

export const OUTLETS: readonly OutletDef[] = [
  { role: "filter", switch: "switch.aquarium_canister_filter", power: "sensor.aquarium_canister_filter_power", name: "Aquarium Canister Filter", draw: 6.8, standby: 0, on: true },
  { role: "heater", switch: "switch.aquarium_water_heater", power: "sensor.aquarium_water_heater_power", name: "Aquarium Water Heater", draw: 0.8, standby: 0, on: true },
  { role: "co2", switch: "switch.aquarium_co2", power: "sensor.aquarium_co2_power", name: "Aquarium CO2", draw: 2.9, standby: 0, on: false },
  { role: "uv", switch: "switch.aquarium_uv_lamp", power: "sensor.aquarium_uv_lamp_power", name: "Aquarium UV Lamp", draw: 0, standby: 0, on: true },
  { role: "light", switch: "switch.aquarium_light_outlet", power: "sensor.aquarium_light_outlet_power", name: "Aquarium Light Outlet", draw: 23.4, standby: 0.2, on: true },
  { role: "spare", switch: "switch.aquarium_spare_outlet", power: "sensor.aquarium_spare_outlet_power", name: "Aquarium Spare Outlet", draw: 0, standby: 0, on: false },
];

export interface EquipmentMockOptions {
  /** The water temperature (default 77.4). */
  temp?: number;
  /** "unavailable" to make the thermometer unreachable. */
  tempState?: string;
  /** How many hours ago the thermometer last reported (default a minute). */
  staleHours?: number;
  battery?: number;
  admin?: boolean;
  /** Home Assistant lets a user who is not an administrator read the automation (default false). */
  readable?: boolean;
  program?: string;
  latency?: number;
  /** Roles whose switches are unavailable. */
  unavailable?: string[];
  /** Roles that start on, overriding the defaults. */
  on?: string[];
  /** Make the history or the next switch command fail. */
  fail?: "history" | "switch" | "none";
}

export interface EquipmentMock {
  hass: HomeAssistant;
  controller: { calls: Array<{ kind: string; domain?: string; service?: string; data?: unknown; target?: unknown; message?: unknown }> };
  current(): HomeAssistant;
  subscribe(fn: (hass: HomeAssistant) => void): () => void;
}

const PROGRAMS = ["Normal", "Algae Reset", "Blackout"];

export function createEquipmentMock(options: EquipmentMockOptions = {}): EquipmentMock {
  const latency = options.latency ?? 120;
  const admin = options.admin !== false;
  const calls: EquipmentMock["controller"]["calls"] = [];
  const listeners = new Set<(hass: HomeAssistant) => void>();
  const unavailable = new Set(options.unavailable ?? []);
  const on = new Map(OUTLETS.map((outlet) => [outlet.switch, options.on ? options.on.includes(outlet.role) : outlet.on]));
  const reportedAt = Date.now() - (options.staleHours ?? 0) * 3_600_000 - 60_000;
  const program = { active: options.program ?? "Algae Reset", started: Date.now() - (5 * 24 + 3) * 3_600_000 };
  const temperature = options.temp ?? 77.4;

  const iso = (ms: number): string => new Date(ms).toISOString();
  const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}, at = Date.now()): HassEntityState => ({ entity_id, state, attributes, last_changed: iso(at), last_updated: iso(at), last_reported: iso(at) });
  const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, latency));

  const build = (): Record<string, HassEntityState> => {
    const states: Record<string, HassEntityState> = {};
    for (const outlet of OUTLETS) {
      const down = unavailable.has(outlet.role);
      const isOn = on.get(outlet.switch) === true;
      states[outlet.switch] = st(outlet.switch, down ? "unavailable" : isOn ? "on" : "off", { friendly_name: outlet.name });
      states[outlet.power] = st(outlet.power, down ? "unavailable" : String(isOn ? outlet.draw : outlet.standby), { unit_of_measurement: "W", device_class: "power", friendly_name: `${outlet.name} Power` });
    }
    states[EQUIPMENT.temperature] = st(EQUIPMENT.temperature, options.tempState === "unavailable" ? "unavailable" : String(temperature), { unit_of_measurement: "°F", device_class: "temperature", friendly_name: "Aquarium Temperature Sensor Temperature" }, reportedAt);
    states[EQUIPMENT.battery] = st(EQUIPMENT.battery, String(options.battery ?? 87), { unit_of_measurement: "%", device_class: "battery" });
    states[EQUIPMENT.program.select] = st(EQUIPMENT.program.select, program.active, { options: PROGRAMS });
    states[EQUIPMENT.program.started] = st(EQUIPMENT.program.started, "2026-01-01 00:00:00", { has_date: true, has_time: true, timestamp: Math.floor(program.started / 1000) });
    states[EQUIPMENT.program.automation] = st(EQUIPMENT.program.automation, "on", { id: "plant_room_aquarium_co2_lights" });
    return states;
  };

  /** 24 hours of readings every 10 minutes: a gentle daily swing ending at the current value. */
  const history = (): unknown => {
    const now = Date.now();
    const rows: Array<{ s: string; lu: number }> = [];
    for (let t = now - 24 * 3_600_000; t <= now; t += 10 * 60_000) {
      const hours = (t - (now - 24 * 3_600_000)) / 3_600_000;
      const wobble = Math.sin(hours / 24 * Math.PI * 2 - 1) * 0.9 + Math.sin(hours * 2.3) * 0.15;
      rows.push({ s: (temperature - 0.4 + wobble * 0.6).toFixed(1), lu: t / 1000 });
    }
    return { [EQUIPMENT.temperature]: rows };
  };

  let hass = {
    states: build(),
    entities: Object.fromEntries(OUTLETS.flatMap((outlet) => [[outlet.switch, { entity_id: outlet.switch, platform: "matter" }], [outlet.power, { entity_id: outlet.power, platform: "matter" }]])),
    devices: {},
    themes: { darkMode: true },
    language: "en",
    locale: { language: "en" },
    config: { time_zone: "Europe/London" },
    user: { id: "user_1", name: "Nitin", is_admin: admin },
    callService: async (domain: string, service: string, data?: Record<string, unknown>, target?: Record<string, unknown>) => {
      calls.push({ kind: "service", domain, service, data, target });
      await delay();
      if (domain === "switch" && options.fail === "switch") throw { code: "home_assistant_error", message: "The Matter server did not answer." };
      const id = typeof target?.entity_id === "string" ? target.entity_id : "";
      if (domain === "switch" && (service === "turn_on" || service === "turn_off") && on.has(id)) on.set(id, service === "turn_on");
      hass = { ...hass, states: build() };
      listeners.forEach((fn) => fn(hass));
    },
    callWS: async (message: Record<string, unknown>) => {
      calls.push({ kind: "ws", message });
      await delay();
      if (message.type === "history/history_during_period") {
        if (options.fail === "history") throw { code: "home_assistant_error", message: "The recorder is busy." };
        return history();
      }
      if (message.type === "automation/config") {
        if (!admin && !options.readable) throw { code: "unauthorized", message: "Unauthorized" };
        return { config: liveConfig() };
      }
      throw { code: "unknown_command", message: "Unknown command." };
    },
  } as unknown as HomeAssistant;

  return {
    get hass() {
      return hass;
    },
    controller: { calls },
    current: () => hass,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

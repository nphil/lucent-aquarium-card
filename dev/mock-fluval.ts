/** Small stateful fake `hass` for a Fluval Plant light (`fluvalble` platform): light, mode select,
 * buttons, link/problem sensors, the `fluvalble.set_channels` service and the
 * `fluvalble/get_schedule` websocket command, plus the lighting-programs helpers (an input_select
 * of programs, a start-time helper, a re-apply button) and the automation that owns the programs
 * (`automation/config` to read it, `POST config/automation/config/<id>` to save it, reloading a
 * moment later like the real one). Enough to render and drive the card. */
import type { HassEntityState, HomeAssistant } from "../src/types.ts";
import type { JsonObject } from "../src/lib/json.ts";
import { liveConfig } from "./program-fixture.ts";

export const FLUVAL_LIGHT = "light.aquarium_plant_light";
export const PROGRAM_ENTITIES = {
  select: "input_select.aquarium_lighting_program",
  automation: "automation.plant_room_aquarium_co2_lights",
  started: "input_datetime.aquarium_program_started",
  reapply: "input_button.aquarium_re_apply_program",
} as const;
const DEVICE = "dev_fluval_1";
const EFFECTS = ["off", "Thunderstorm", "Lightning", "Sun and lightning", "Colour cycle", "Mostly sunny", "Partly sunny", "Partly cloudy", "Mostly cloudy", "Full moon", "Half moon", "Crescent moon"];
const TIME_ZONE = "Europe/London";
const PROGRAMS = ["Normal", "Algae Reset", "Blackout"];

export interface FluvalMockCall {
  kind: string;
  domain?: string;
  service?: string;
  data?: unknown;
  message?: unknown;
  method?: string;
  path?: string;
}

export interface FluvalMockOptions {
  state?: string;
  mode?: string;
  latency?: number;
  /** Whether the user is an administrator (default true). */
  admin?: boolean;
  /** Home Assistant lets a user who is not an administrator read the automation (default false). */
  readable?: boolean;
  /** The running program (default Algae Reset). */
  program?: string;
  /** How long ago it started, in hours (default 5 days 3 h). */
  startedHoursAgo?: number;
  /** How long Home Assistant takes to reload the automation after a save (default 900 ms). */
  reloadMs?: number;
  /** Make reading the automation or saving it fail. */
  fail?: "read" | "save" | "none";
}

export interface FluvalMock {
  hass: HomeAssistant;
  controller: { calls: FluvalMockCall[] };
  current(): HomeAssistant;
  subscribe(fn: (hass: HomeAssistant) => void): () => void;
  /** The automation as the running (reloaded) Home Assistant holds it. */
  automation(): JsonObject;
}

const SCHEDULE = {
  entry_id: "entry_fluval_1",
  points: null,
  mode: "native",
  fixture: {
    available: true,
    mode: "automatic",
    channels: ["Pink", "Blue", "Cold White", "White", "Warm White"],
    auto: { sunrise: "08:00", sunrise_ramp: 60, sunset: "20:00", sunset_ramp: 90, sleep: "23:00", day_levels: [70, 60, 90, 80, 50], night_levels: [0, 8, 0, 0, 0] },
    professional: [
      { time: "07:00", channel_1: 0, channel_2: 5, channel_3: 0, channel_4: 0, channel_5: 0 },
      { time: "10:00", channel_1: 40, channel_2: 60, channel_3: 70, channel_4: 50, channel_5: 30 },
      { time: "14:00", channel_1: 70, channel_2: 70, channel_3: 100, channel_4: 90, channel_5: 60 },
      { time: "19:00", channel_1: 30, channel_2: 20, channel_3: 20, channel_4: 30, channel_5: 70 },
      { time: "22:00", channel_1: 0, channel_2: 0, channel_3: 0, channel_4: 0, channel_5: 0 },
    ],
    effect_options: EFFECTS.slice(1),
    effect_readback_complete: true,
    spectrum_profile: "plant_current",
    protocol: "plant_pro",
    read_at: null,
  },
  refresh_ok: null,
};

/** "2026-09-27 08:30:12" in the harness's zone, the way a date-time helper prints its state. */
function printed(epochMs: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(epochMs));
}

export function createFluvalMock(options: FluvalMockOptions = {}): FluvalMock {
  const latency = options.latency ?? 120;
  const admin = options.admin !== false;
  const view = { on: options.state !== "off", unavailable: options.state === "unavailable", brightness: 200, mode: options.mode ?? "automatic", effect: options.state === "effect" ? "Thunderstorm" : "off", override: false };
  const program = { active: options.program ?? "Algae Reset", started: Date.now() - (options.startedHoursAgo ?? 5 * 24 + 3) * 3_600_000 };
  // The automation: `written` is the file after a save; `running` is what the reloaded automation shows.
  const automation: { running: JsonObject; written: JsonObject | null; reloadAt: number } = { running: liveConfig(), written: null, reloadAt: 0 };
  const calls: FluvalMockCall[] = [];
  const listeners = new Set<(hass: HomeAssistant) => void>();
  const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HassEntityState => ({ entity_id, state, attributes, last_changed: "", last_updated: "" });
  const reg = (entity_id: string, translation_key: string | null): [string, Record<string, unknown>] => [entity_id, { entity_id, device_id: DEVICE, platform: "fluvalble", translation_key }];
  const helper = (entity_id: string): [string, Record<string, unknown>] => [entity_id, { entity_id, device_id: null, platform: entity_id.slice(0, entity_id.indexOf(".")), translation_key: null }];
  const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, latency));

  const build = (): Record<string, HassEntityState> => {
    const un = view.unavailable;
    const scheduleMode = view.mode !== "manual";
    const attrs = { friendly_name: "Aquarium Plant Light", effect_list: EFFECTS, supported_color_modes: ["rgb"] };
    const light = un
      ? st(FLUVAL_LIGHT, "unavailable", attrs)
      : !view.on
        ? st(FLUVAL_LIGHT, "off", attrs)
        : st(FLUVAL_LIGHT, "on", { ...attrs, brightness: view.brightness, rgb_color: view.effect === "off" ? [255, 190, 130] : null, effect: view.effect, level_source: scheduleMode ? "schedule" : "reported", ...(scheduleMode ? { scheduled_levels: [55, 45, 80, 60, 40] } : {}) });
    return {
      [FLUVAL_LIGHT]: light,
      "select.aquarium_plant_light_mode": st("select.aquarium_plant_light_mode", un ? "unavailable" : view.mode, { options: ["manual", "automatic", "professional"], override_active: view.override }),
      "binary_sensor.aquarium_plant_light_connection": st("binary_sensor.aquarium_plant_light_connection", un ? "off" : "on"),
      "binary_sensor.aquarium_plant_light_schedule_problem": st("binary_sensor.aquarium_plant_light_schedule_problem", "off"),
      "button.aquarium_plant_light_sync_clock": st("button.aquarium_plant_light_sync_clock", "unknown"),
      "button.aquarium_plant_light_return_to_schedule": st("button.aquarium_plant_light_return_to_schedule", "unknown"),
      [PROGRAM_ENTITIES.select]: st(PROGRAM_ENTITIES.select, program.active, { options: PROGRAMS, friendly_name: "Aquarium lighting program" }),
      [PROGRAM_ENTITIES.started]: st(PROGRAM_ENTITIES.started, printed(program.started), { has_date: true, has_time: true, timestamp: Math.floor(program.started / 1000), friendly_name: "Aquarium program started" }),
      [PROGRAM_ENTITIES.reapply]: st(PROGRAM_ENTITIES.reapply, "unknown", { friendly_name: "Aquarium Re-apply Program" }),
      [PROGRAM_ENTITIES.automation]: st(PROGRAM_ENTITIES.automation, "on", { friendly_name: "Plant Room Aquarium - CO2 & Lights", id: "plant_room_aquarium_co2_lights" }),
    };
  };

  let hass = {
    states: build(),
    entities: Object.fromEntries([
      reg(FLUVAL_LIGHT, "light"),
      reg("select.aquarium_plant_light_mode", "mode"),
      reg("binary_sensor.aquarium_plant_light_connection", "connection"),
      reg("binary_sensor.aquarium_plant_light_schedule_problem", "schedule_problem"),
      reg("button.aquarium_plant_light_sync_clock", "sync_clock"),
      reg("button.aquarium_plant_light_return_to_schedule", "return_to_schedule"),
      helper(PROGRAM_ENTITIES.select),
      helper(PROGRAM_ENTITIES.started),
      helper(PROGRAM_ENTITIES.reapply),
      helper(PROGRAM_ENTITIES.automation),
    ]),
    devices: { [DEVICE]: { id: DEVICE, name: "Aquarium Plant Light", manufacturer: "Fluval", config_entries: ["entry_fluval_1"] } },
    themes: { darkMode: true },
    language: "en",
    locale: { language: "en" },
    config: { time_zone: TIME_ZONE },
    user: { id: "user_1", name: "Nitin", is_admin: admin },
    callService: async (domain: string, service: string, data?: Record<string, unknown>) => {
      calls.push({ kind: "service", domain, service, data });
      await delay();
      if (domain === "light" && service === "turn_off") view.on = false;
      if (domain === "light" && service === "turn_on") {
        view.on = true;
        if (typeof data?.brightness === "number") view.brightness = data.brightness;
        if (typeof data?.effect === "string") view.effect = data.effect;
      }
      if (domain === "select" && service === "select_option" && typeof data?.option === "string") {
        view.mode = data.option;
        view.effect = "off";
      }
      if (domain === "input_select" && service === "select_option" && typeof data?.option === "string" && PROGRAMS.includes(data.option)) {
        // The automation stamps the start time when the program changes.
        program.active = data.option;
        program.started = Date.now();
      }
      if (domain === "fluvalble" && service === "set_channels") {
        view.mode = "manual";
        view.override = true;
        view.effect = "off";
      }
      if (domain === "button" && data === undefined) view.override = false;
      hass = { ...hass, states: build() };
      listeners.forEach((fn) => fn(hass));
    },
    callWS: async (message: Record<string, unknown>) => {
      calls.push({ kind: "ws", message });
      await delay();
      if (message.type === "fluvalble/get_schedule") return SCHEDULE;
      if (message.type === "automation/config") {
        if (!admin && !options.readable) throw { code: "unauthorized", message: "Unauthorized" };
        if (options.fail === "read") throw { code: "home_assistant_error", message: "Home Assistant could not read the automation." };
        if (automation.written && Date.now() >= automation.reloadAt) {
          automation.running = automation.written;
          automation.written = null;
        }
        return { config: structuredClone(automation.running) };
      }
      throw { code: "unknown_command", message: "Unknown command." };
    },
    callApi: async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ kind: "api", method, path, data: body });
      await delay();
      if (!admin) throw { status_code: 401, body: { message: "Unauthorized" } };
      if (method === "POST" && path === "config/automation/config/plant_room_aquarium_co2_lights") {
        if (options.fail === "save") throw { status_code: 400, body: { message: "Message malformed: extra keys not allowed @ data['variables']" } };
        automation.written = structuredClone(body) as JsonObject;
        automation.reloadAt = Date.now() + (options.reloadMs ?? 900);
        return { result: "ok" };
      }
      throw { status_code: 404, body: { message: "Not found" } };
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
    automation: () => structuredClone(automation.written && Date.now() >= automation.reloadAt ? automation.written : automation.running),
  };
}

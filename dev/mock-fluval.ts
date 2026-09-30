/** Small stateful fake `hass` for a Fluval Plant light (`fluvalble` platform): light, mode select,
 * buttons, link/problem sensors, the `fluvalble.set_channels` service and the
 * `fluvalble/get_schedule` websocket command. Enough to render and drive the card. */
import type { HassEntityState, HomeAssistant } from "../src/types.ts";

export const FLUVAL_LIGHT = "light.aquarium_plant_light";
const DEVICE = "dev_fluval_1";
const EFFECTS = ["off", "Thunderstorm", "Lightning", "Sun and lightning", "Colour cycle", "Mostly sunny", "Partly sunny", "Partly cloudy", "Mostly cloudy", "Full moon", "Half moon", "Crescent moon"];

export interface FluvalMock {
  hass: HomeAssistant;
  controller: { calls: Array<{ kind: string; domain?: string; service?: string; data?: unknown; message?: unknown }> };
  current(): HomeAssistant;
  subscribe(fn: (hass: HomeAssistant) => void): () => void;
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

export function createFluvalMock(options: { state?: string; mode?: string; latency?: number } = {}): FluvalMock {
  const latency = options.latency ?? 120;
  const view = { on: options.state !== "off", unavailable: options.state === "unavailable", brightness: 200, mode: options.mode ?? "automatic", effect: options.state === "effect" ? "Thunderstorm" : "off", override: false };
  const calls: FluvalMock["controller"]["calls"] = [];
  const listeners = new Set<(hass: HomeAssistant) => void>();
  const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HassEntityState => ({ entity_id, state, attributes, last_changed: "", last_updated: "" });
  const reg = (entity_id: string, translation_key: string | null): [string, Record<string, unknown>] => [entity_id, { entity_id, device_id: DEVICE, platform: "fluvalble", translation_key }];

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
    ]),
    devices: { [DEVICE]: { id: DEVICE, name: "Aquarium Plant Light", manufacturer: "Fluval", config_entries: ["entry_fluval_1"] } },
    themes: { darkMode: true },
    language: "en",
    locale: { language: "en" },
    config: { time_zone: "Europe/London" },
    callService: async (domain: string, service: string, data?: Record<string, unknown>) => {
      calls.push({ kind: "service", domain, service, data });
      await new Promise((resolve) => setTimeout(resolve, latency));
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
      await new Promise((resolve) => setTimeout(resolve, latency));
      if (message.type === "fluvalble/get_schedule") return SCHEDULE;
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

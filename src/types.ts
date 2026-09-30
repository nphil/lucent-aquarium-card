/** Minimal Home Assistant frontend types this card actually uses. Hand-rolled instead of
 * depending on `home-assistant-js-websocket`/`custom-card-helpers`: the card reads a handful of
 * fields, and a hand-rolled surface keeps the bundle self-contained.
 */

export interface HassEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  /** When the entity last reported, even with nothing changed (a steady reading keeps this fresh). */
  last_reported?: string;
}

/** One `hass.entities` row (the frontend's entity-registry *display* entries). */
export interface EntityRegistryEntry {
  entity_id: string;
  device_id?: string | null;
  platform?: string;
  translation_key?: string | null;
  name?: string | null;
  hidden?: boolean;
  entity_category?: string | null;
}

export interface DeviceRegistryEntry {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  area_id?: string | null;
  config_entries?: string[];
}

export type CallWS = <T = unknown>(message: Record<string, unknown>) => Promise<T>;

/** Home Assistant's REST helper: `path` is relative to `/api/`. */
export type CallApi = <T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, parameters?: Record<string, unknown>) => Promise<T>;

export interface HomeAssistantUser {
  id: string;
  name: string;
  is_admin: boolean;
}

export interface HomeAssistant {
  states: Record<string, HassEntityState>;
  entities: Record<string, EntityRegistryEntry>;
  devices: Record<string, DeviceRegistryEntry>;
  themes?: { darkMode?: boolean; [key: string]: unknown };
  language?: string;
  locale?: { language?: string; time_zone?: string; [key: string]: unknown };
  config?: { time_zone?: string; [key: string]: unknown };
  /** `notifyOnError` false: the card shows its own honest error state instead of HA's toast. */
  callService: (
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
    notifyOnError?: boolean,
  ) => Promise<unknown>;
  callWS: CallWS;
  /** REST calls (the automation editor's save endpoint lives here). */
  callApi?: CallApi;
  /** Who is looking. Program editing needs an administrator. */
  user?: HomeAssistantUser;
}

/** The entities of a lighting-programs setup: a helper that names the running program, and the
 * automation whose `variables.programs` holds each program's light schedule and CO2 window. */
export interface ProgramConfig {
  /** `input_select` whose options are the programs and whose state is the running one. */
  select: string;
  /** `automation` that owns the programs (read and edited through its configuration). */
  automation: string;
  /** `input_datetime` stamped when the program changed (for "running N days"). */
  started?: string;
  /** `input_button` that makes the automation write the running program to the light again. */
  reapply?: string;
}

/** Lovelace configuration of `aquarium-light-card`: the light to control, found through its
 * integration's adapter. */
export interface AquariumCardConfig {
  type: string;
  /** The light entity (its registry platform picks the adapter). */
  entity?: string;
  name?: string;
  /** Tab shown first. Default: the tab matching what the light is doing. */
  tab?: CardTab;
  /** Fluval lighting programs: adds a Program tab when the light supports them. */
  program?: ProgramConfig;
}

export type CardTab = "colour" | "effects" | "schedule" | "program";

export type OutletRole = "filter" | "heater" | "co2" | "uv" | "light" | "spare";

/** One switched outlet of the equipment card, with the sensor that measures what it draws. */
export interface EquipmentOutletConfig {
  switch: string;
  /** Power sensor of the same outlet (W). */
  power?: string;
  /** What is plugged in: picks the icon, the wording and the rules. */
  role?: OutletRole;
  /** Title override; defaults to the switch's name. */
  name?: string;
  /** Switching it off can harm the fish: a hold is needed to confirm. */
  critical?: boolean;
  /** `program`: the lighting-program automation decides when this runs, and the tile says so. */
  guard?: "program";
}

export interface EquipmentTemperatureConfig {
  entity: string;
  /** The comfortable band, in the sensor's own unit. Outside it the reading warns. */
  min?: number;
  max?: number;
  /** Battery level sensor (%) of the thermometer. */
  battery?: string;
}

/** Lovelace configuration of `aquarium-equipment-card`. */
export interface EquipmentCardConfig {
  type: string;
  name?: string;
  temperature?: EquipmentTemperatureConfig;
  outlets?: EquipmentOutletConfig[];
  /** Same block as the light card's: lets the CO2 tile show the running program's window. */
  program?: ProgramConfig;
}

declare global {
  interface Window {
    customCards?: Array<{ type: string; name: string; description?: string; preview?: boolean; documentationURL?: string }>;
  }
}

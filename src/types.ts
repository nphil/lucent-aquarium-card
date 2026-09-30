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
}

/** Lovelace card configuration: the light to control, found through its integration's adapter. */
export interface AquariumCardConfig {
  type: string;
  /** The light entity (its registry platform picks the adapter). */
  entity?: string;
  name?: string;
  /** Tab shown first. Default: the tab matching what the light is doing. */
  tab?: CardTab;
}

export type CardTab = "colour" | "effects" | "schedule";

declare global {
  interface Window {
    customCards?: Array<{ type: string; name: string; description?: string; preview?: boolean; documentationURL?: string }>;
  }
}

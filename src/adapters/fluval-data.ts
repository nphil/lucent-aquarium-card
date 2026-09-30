/** Everything specific to the Fluval BLE (`fluvalble`) integration that needs no Home Assistant
 * runtime: entity resolution, state parsing, channel and effect tables, the schedule readback
 * (`fluvalble/get_schedule`) turned into chart points, status wording. Pure and unit-tested;
 * `fluval.ts` wires it to a live `hass`.
 *
 * What the integration exposes (and what it does not): one `light` entity (brightness, an
 * approximate `rgb_color`, `effect`/`effect_list`, and `scheduled_levels` while a schedule runs),
 * a `mode` select (manual / automatic / professional), buttons (sync clock, return to schedule)
 * and link/problem binary sensors. Channel LEVELS are not reported in manual mode, and the
 * fixture schedules (Automatic sunrise/sunset ramps, Professional timed points) are read through
 * a websocket command. The card therefore shows the schedules read-only.
 */

import { brightnessToPercent, clampPercent, type ChannelDef, type Levels } from "../lib/channels.ts";
import type { IconName } from "../lib/icons.ts";
import { parseTime, sortPoints, type SchedulePoint } from "../lib/points.ts";
import type { EntityRegistryEntry, HassEntityState } from "../types.ts";
import type { EffectDef, EffectMotion, ProgramData, Status, StatusChip, TankColour } from "./types.ts";

export const FLUVAL_PLATFORM = "fluvalble";
/** Home Assistant's "no effect" sentinel for this integration: selecting it restores the mix. */
export const EFFECT_NONE = "off";
export const FLUVAL_MAX_POINTS = 12;
export const READ_ONLY_NOTE = "Editing Fluval schedules from this card isn't supported yet. Use the schedule editor cards from the Fluval BLE integration to change them.";

// ---- channels ----

interface ChannelStyle {
  colour: string;
  light: readonly [number, number, number];
}

const CHANNEL_STYLES: Record<string, ChannelStyle> = {
  red: { colour: "#f2545b", light: [1, 0, 0] },
  green: { colour: "#2fc77a", light: [0, 1, 0] },
  blue: { colour: "#4b8bf5", light: [0, 0.15, 1] },
  white: { colour: "#f6f3ea", light: [0.95, 0.95, 0.9] },
  violet: { colour: "#9b6bff", light: [0.55, 0.2, 1] },
  pink: { colour: "#ff6fae", light: [1, 0.35, 0.6] },
  cyan: { colour: "#29d1e8", light: [0, 0.85, 0.95] },
  purple: { colour: "#a35cff", light: [0.6, 0.2, 1] },
  "cold white": { colour: "#dbe7ff", light: [0.8, 0.9, 1] },
  "warm white": { colour: "#ffc98a", light: [1, 0.78, 0.5] },
};
const FALLBACK_STYLES: readonly ChannelStyle[] = [
  { colour: "#f2545b", light: [1, 0.3, 0.3] },
  { colour: "#2fc77a", light: [0.3, 1, 0.5] },
  { colour: "#4b8bf5", light: [0.3, 0.5, 1] },
  { colour: "#f6f3ea", light: [0.9, 0.9, 0.85] },
  { colour: "#9b6bff", light: [0.6, 0.4, 1] },
];

/** Channel definitions from the names the integration reports (`Pink`, `Cold White`, ...). */
export function channelDefs(names: readonly string[]): ChannelDef[] {
  return names.map((name, index) => {
    const style = CHANNEL_STYLES[name.trim().toLowerCase()] ?? FALLBACK_STYLES[index % FALLBACK_STYLES.length]!;
    const short = name.split(/\s+/).map((word) => word[0]?.toUpperCase() ?? "").join("").slice(0, 2) || String(index + 1);
    return { id: `channel_${index + 1}`, name, short, ...style };
  });
}

/** `fluvalble.set_channels` takes its five channels under these keys, in channel order. */
export const SET_CHANNEL_KEYS = ["red", "green", "blue", "white", "channel_5"] as const;

// ---- effects ----

interface EffectStyle {
  icon: IconName;
  art: string | "cycle";
  motion?: EffectMotion;
  rgb: readonly [number, number, number];
}

const EFFECT_STYLES: Record<string, EffectStyle> = {
  Thunderstorm: { icon: "weatherLightning", art: "rgb(150, 170, 255)", motion: "storm", rgb: [140, 160, 255] },
  Lightning: { icon: "flash", art: "rgb(190, 200, 255)", motion: "storm", rgb: [190, 200, 255] },
  "Sun and lightning": { icon: "weatherLightning", art: "rgb(255, 220, 150)", motion: "storm", rgb: [255, 220, 160] },
  "Colour cycle": { icon: "paletteSwatch", art: "cycle", motion: "cycle", rgb: [255, 60, 60] },
  "Mostly sunny": { icon: "weatherSunny", art: "rgb(255, 214, 120)", rgb: [255, 220, 150] },
  "Partly sunny": { icon: "weatherPartlyCloudy", art: "rgb(255, 214, 150)", rgb: [255, 225, 175] },
  "Partly cloudy": { icon: "weatherPartlyCloudy", art: "rgb(200, 215, 235)", rgb: [205, 220, 240] },
  "Mostly cloudy": { icon: "weatherCloudy", art: "rgb(170, 185, 205)", rgb: [175, 190, 210] },
  "Full moon": { icon: "moonFull", art: "rgb(200, 210, 255)", rgb: [190, 205, 255] },
  "Half moon": { icon: "moonFirstQuarter", art: "rgb(170, 185, 255)", rgb: [160, 180, 255] },
  "Crescent moon": { icon: "weatherNight", art: "rgb(140, 160, 255)", rgb: [130, 155, 255] },
};

/** Effect tiles for the light's `effect_list` (the `off` entry is not a tile: it becomes "Stop effect"). */
export function effectDefs(effectList: readonly string[]): EffectDef[] {
  return effectList
    .filter((name) => name !== EFFECT_NONE)
    .map((name) => {
      const style = EFFECT_STYLES[name];
      const tank: TankColour | undefined = style ? { rgb: style.rgb } : undefined;
      return {
        id: name,
        name,
        icon: style?.icon ?? "effects",
        art: style?.art ?? null,
        ...(tank ? { glow: tank } : {}),
        ...(style?.motion && tank ? { motion: style.motion, motionTank: tank } : {}),
      };
    });
}

// ---- entities ----

export interface FluvalEntities {
  deviceId: string;
  light: string;
  /** `select.*_mode` */
  mode?: string;
  syncClock?: string;
  returnToSchedule?: string;
  /** `binary_sensor.*_connection` (Reachable) */
  connection?: string;
  scheduleProblem?: string;
}

type Role = "mode" | "syncClock" | "returnToSchedule" | "connection" | "scheduleProblem";

const SIBLINGS: Record<Role, { domain: string; key: string }> = {
  mode: { domain: "select", key: "mode" },
  syncClock: { domain: "button", key: "sync_clock" },
  returnToSchedule: { domain: "button", key: "return_to_schedule" },
  connection: { domain: "binary_sensor", key: "connection" },
  scheduleProblem: { domain: "binary_sensor", key: "schedule_problem" },
};

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf("."));
}

export function resolveFluvalEntities(registry: Record<string, EntityRegistryEntry>, entityId: string): FluvalEntities | null {
  if (domainOf(entityId) !== "light") return null;
  const deviceId = registry[entityId]?.device_id ?? "";
  const result: FluvalEntities = { deviceId, light: entityId };
  if (!deviceId) return result;
  for (const entry of Object.values(registry)) {
    if (entry.device_id !== deviceId) continue;
    for (const role of Object.keys(SIBLINGS) as Role[]) {
      const rule = SIBLINGS[role];
      if (result[role] || domainOf(entry.entity_id) !== rule.domain) continue;
      if (entry.translation_key === rule.key || entry.entity_id.endsWith(`_${rule.key}`)) result[role] = entry.entity_id;
    }
  }
  return result;
}

// ---- state ----

export type FluvalMode = "manual" | "automatic" | "professional";

export interface FluvalReading {
  phase: "on" | "off" | "unavailable";
  name: string;
  brightness: number | null;
  /** The light's approximate `rgb_color`, or null (off, effect running, brightness-only fixtures). */
  rgb: [number, number, number] | null;
  effect: string | null;
  effectList: string[];
  mode: FluvalMode | null;
  modeOptions: string[];
  /** Live channel levels while a schedule runs (`level_source: schedule`). */
  scheduledLevels: Levels | null;
  connected: boolean | null;
  problem: boolean;
  overrideActive: boolean;
  overrideUntil: string | null;
}

const MODES: readonly string[] = ["manual", "automatic", "professional"];

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function rgbFrom(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const parts = value.slice(0, 3).map(Number);
  return parts.every((n) => Number.isFinite(n)) ? (parts.map((n) => Math.max(0, Math.min(255, Math.round(n)))) as [number, number, number]) : null;
}

export function readFluvalState(states: Record<string, HassEntityState | undefined>, entities: FluvalEntities): FluvalReading | null {
  const light = states[entities.light];
  if (!light) return null;
  const attrs = light.attributes;
  const select = entities.mode ? states[entities.mode] : undefined;
  const connection = entities.connection ? states[entities.connection] : undefined;
  const problem = entities.scheduleProblem ? states[entities.scheduleProblem] : undefined;
  const phase: FluvalReading["phase"] = light.state === "on" ? "on" : light.state === "off" ? "off" : light.state === "unavailable" || light.state === "unknown" ? "unavailable" : "off";
  const effect = typeof attrs.effect === "string" && attrs.effect && attrs.effect !== EFFECT_NONE ? attrs.effect : null;
  const scheduled = attrs.level_source === "schedule" && Array.isArray(attrs.scheduled_levels) ? attrs.scheduled_levels.map(Number) : null;
  return {
    phase,
    name: typeof attrs.friendly_name === "string" ? attrs.friendly_name : "",
    brightness: phase === "on" && typeof attrs.brightness === "number" ? brightnessToPercent(attrs.brightness) : null,
    rgb: phase === "on" ? rgbFrom(attrs.rgb_color) : null,
    effect,
    effectList: stringList(attrs.effect_list),
    mode: select && MODES.includes(select.state) ? (select.state as FluvalMode) : null,
    modeOptions: select ? stringList(select.attributes.options) : [],
    scheduledLevels: scheduled && scheduled.every((n) => Number.isFinite(n)) ? scheduled.map(clampPercent) : null,
    connected: connection ? (connection.state === "on" ? true : connection.state === "off" ? false : null) : null,
    problem: problem?.state === "on",
    overrideActive: select?.attributes.override_active === true,
    overrideUntil: typeof select?.attributes.override_until === "string" ? select.attributes.override_until : null,
  };
}

const MODE_LABEL: Record<FluvalMode, string> = { manual: "Manual colour", automatic: "Automatic schedule", professional: "Professional schedule" };

export function describeFluvalStatus(reading: FluvalReading | null): Status {
  if (!reading) return { chips: [{ label: "Connecting", kind: "neutral", icon: "bluetooth" }], mode: null, summary: "Waiting for the light's state." };
  if (reading.phase === "unavailable") {
    return { chips: [{ label: reading.connected === false ? "Disconnected" : "Unavailable", kind: "warning", icon: "bluetoothOff" }], mode: null, summary: "Home Assistant reports the light as unavailable." };
  }
  const chips: StatusChip[] = [reading.connected === false ? { label: "Disconnected", kind: "warning", icon: "bluetoothOff" } : { label: "Connected", kind: "positive", icon: "bluetooth" }];
  if (reading.problem) chips.push({ label: "Schedule problem", kind: "warning", icon: "alert" });
  if (reading.overrideActive) chips.push({ label: "Manual override", kind: "warning", icon: "calendarSync" });
  if (reading.phase === "off") return { chips, mode: "Off", summary: "The light is off." };
  const percent = reading.brightness !== null ? ` at ${reading.brightness}% brightness` : "";
  if (reading.effect) return { chips, mode: `${reading.effect} effect`, summary: `Playing the ${reading.effect} effect${percent}.` };
  const label = reading.mode ? MODE_LABEL[reading.mode] : "On";
  return { chips, mode: label, summary: `${label}${percent}.` };
}

// ---- schedule readback ----

export interface AutoSchedule {
  sunrise: string;
  sunriseRamp: number;
  sunset: string;
  sunsetRamp: number;
  sleep: string | null;
  dayLevels: number[];
  nightLevels: number[];
}

export interface SchedulePayload {
  channels: string[];
  auto: AutoSchedule | null;
  professional: SchedulePoint[] | null;
  /** Whether the light answered when it was asked to read its schedules again: false when it did
   * not (the rest is then what the integration last read), null when nobody asked. */
  refreshOk: boolean | null;
}

function levelList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 4 || value.length > 5) return null;
  const parts = value.map(Number);
  return parts.every((n) => Number.isFinite(n)) ? parts.map(clampPercent) : null;
}

/** `fluvalble/get_schedule` answer -> what the card needs; null when it is not usable. */
export function parseSchedulePayload(raw: unknown): SchedulePayload | null {
  if (!raw || typeof raw !== "object" || !("fixture" in raw)) return null;
  const fixture = raw.fixture;
  if (!fixture || typeof fixture !== "object") return null;
  const channels = "channels" in fixture ? stringList(fixture.channels) : [];

  let auto: AutoSchedule | null = null;
  if ("auto" in fixture && fixture.auto && typeof fixture.auto === "object") {
    const a = fixture.auto as Record<string, unknown>;
    const day = levelList(a.day_levels);
    const night = levelList(a.night_levels);
    if (typeof a.sunrise === "string" && typeof a.sunset === "string" && day && night) {
      auto = {
        sunrise: a.sunrise,
        sunriseRamp: Number(a.sunrise_ramp) || 0,
        sunset: a.sunset,
        sunsetRamp: Number(a.sunset_ramp) || 0,
        sleep: typeof a.sleep === "string" ? a.sleep : null,
        dayLevels: day,
        nightLevels: night,
      };
    }
  }

  // Kept as the light has them, equal times included: the light sorts them (stably) and fades
  // between neighbours, so a repeated time is a step, and dropping one would draw another curve.
  let professional: SchedulePoint[] | null = null;
  if ("professional" in fixture && Array.isArray(fixture.professional)) {
    const points: SchedulePoint[] = [];
    for (const row of fixture.professional) {
      if (!row || typeof row !== "object" || !("time" in row) || typeof row.time !== "string") continue;
      const minutes = parseTime(row.time);
      if (minutes === null) continue;
      const record = row as Record<string, unknown>;
      const count = channels.length || 5;
      points.push({ minutes, levels: Array.from({ length: count }, (_, i) => clampPercent(Number(record[`channel_${i + 1}`] ?? 0))) });
    }
    professional = points.length > 0 ? sortPoints(points) : null;
  }
  const refreshOk = "refresh_ok" in raw && typeof raw.refresh_ok === "boolean" ? raw.refresh_ok : null;
  return { channels, auto, professional, refreshOk };
}

const DAY_MINUTES = 1440;
/** The light accepts ramps of 0-240 minutes. */
export const RAMP_MAX = 240;

const wrapDay = (minutes: number): number => ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
const clampRamp = (ramp: number): number => (Number.isFinite(ramp) ? Math.max(0, Math.min(RAMP_MAX, Math.trunc(ramp))) : 0);

/** The Automatic schedule as the points the light itself fades between: an exact mirror of the
 * integration's `_classic_auto_preview_points`, which mirrors FluvalConnect.
 *
 * - Sunrise is where the ramp UP starts; the day levels are reached `sunrise ramp` minutes later.
 * - Sunset is where the ramp DOWN ENDS: it starts `sunset ramp` minutes earlier and reaches the
 *   night levels at the sunset time.
 * - With a sleep time set, the sunrise point is all zeros (the light is off before sunrise), the
 *   night levels hold from sunset until the sleep minute, and two points share that minute (night,
 *   then off) so the light switches off at once and stays off until sunrise. Without a sleep time
 *   the night levels hold until sunrise.
 * - A ramp of 0 puts two points on the same minute: a step, not a ramp. Equal minutes are kept
 *   in this order (the sort is stable, like the light's own), so the chart draws the step.
 * - Times wrap around midnight. */
export function autoSchedulePoints(auto: AutoSchedule, channelCount: number): SchedulePoint[] {
  const sunrise = parseTime(auto.sunrise);
  const sunset = parseTime(auto.sunset);
  if (sunrise === null || sunset === null) throw new Error("The light reported an unusable sunrise or sunset time.");
  if (auto.dayLevels.length < channelCount || auto.nightLevels.length < channelCount) throw new Error("The light has not reported a complete Automatic schedule yet.");
  const day = auto.dayLevels.slice(0, channelCount).map(clampPercent);
  const night = auto.nightLevels.slice(0, channelCount).map(clampPercent);
  const off = new Array<number>(channelCount).fill(0);
  const sleep = auto.sleep === null ? null : parseTime(auto.sleep);
  const sunriseRamp = clampRamp(auto.sunriseRamp);
  const sunsetRamp = clampRamp(auto.sunsetRamp);
  const at = (minutes: number, levels: readonly number[]): SchedulePoint => ({ minutes: wrapDay(minutes), levels: [...levels] });

  const points = [at(sunrise, sleep !== null ? off : night), at(sunrise + sunriseRamp, day), at(sunset - sunsetRamp, day), at(sunset, night)];
  if (sleep !== null) points.push(at(sleep, night), at(sleep, off));
  return sortPoints(points);
}

export function autoNote(auto: AutoSchedule): string {
  const sunriseRamp = clampRamp(auto.sunriseRamp);
  const sunsetRamp = clampRamp(auto.sunsetRamp);
  const sunrise = sunriseRamp > 0 ? `Sunrise starts at ${auto.sunrise} and takes ${sunriseRamp} min` : `Sunrise switches at ${auto.sunrise}`;
  const sunset = sunsetRamp > 0 ? `sunset ends at ${auto.sunset} after a ${sunsetRamp} min ramp down` : `sunset switches at ${auto.sunset}`;
  const overnight = auto.sleep ? `Off from ${auto.sleep} until sunrise.` : "Night levels until sunrise.";
  return `Drawn from the light's own settings. ${sunrise}; ${sunset}. ${overnight}`;
}

export type FluvalProgramId = "automatic" | "professional";

/** One programme out of a payload (`programme id` = the mode that runs it). */
export function programFromPayload(id: string, payload: SchedulePayload): ProgramData {
  const count = payload.channels.length || 5;
  if (id === "automatic") {
    if (!payload.auto) throw new Error("The light has not reported its Automatic schedule yet.");
    return { id, name: "Automatic", points: autoSchedulePoints(payload.auto, count), editable: false, source: "device", note: autoNote(payload.auto) };
  }
  if (id === "professional") {
    if (!payload.professional) throw new Error("The light has not reported its Professional schedule yet.");
    return { id, name: "Professional", points: payload.professional, editable: false, source: "device" };
  }
  throw new Error(`This light has no schedule called ${id}.`);
}

/** Everything specific to the Pawfly (PinYing PY4C) integration that needs no Home Assistant
 * runtime: channel and programme tables, entity resolution, state parsing, service payloads.
 * Pure, so it is unit-tested directly; `pawfly.ts` wires it to a live `hass`.
 *
 * Contract source: the `pawfly` integration (services `get_program`, `set_program`, `preview`,
 * `set_channel`; light attributes `mode`, `program`, `scenario`, `programs`, `scene_colors`,
 * `max_program_points`) and the vendor app (scene mirror colours, programme names).
 */

import { byteToPercent, brightnessToPercent, clampPercent, levelsLabel, type ChannelDef, type Levels } from "../lib/channels.ts";
import type { IconName } from "../lib/icons.ts";
import { formatTime, parseTime, sortPoints, type SchedulePoint } from "../lib/points.ts";
import type { EffectDef, EffectMotion, ProgramData, ScheduleProgram, Status, StatusChip } from "./types.ts";
import type { CallWS, EntityRegistryEntry, HassEntityState } from "../types.ts";

export const PAWFLY_PLATFORM = "pawfly";

/** Red, green, blue and white LEDs. The white LED is drawn as a neutral white on screen. */
export const PAWFLY_CHANNELS: readonly ChannelDef[] = [
  { id: "red", name: "Red", short: "R", colour: "#f2545b", light: [1, 0, 0] },
  { id: "green", name: "Green", short: "G", colour: "#2fc77a", light: [0, 1, 0] },
  { id: "blue", name: "Blue", short: "B", colour: "#4b8bf5", light: [0, 0, 1] },
  { id: "white", name: "White", short: "W", colour: "#f6f3ea", light: [0.85, 0.85, 0.85] },
];

/** The four channel keys of the pawfly services, in `PAWFLY_CHANNELS` order. */
const SERVICE_CHANNEL_KEYS = ["red", "green", "blue", "white"] as const;

export const DEFAULT_MAX_POINTS = 12;
/** Programmes 0-2 are the firmware presets (read-only); 3-5 are the user's DIY 1-3. */
export const FIRST_DIY_PROGRAM = 3;

export interface PawflyProgramInfo {
  index: number;
  slug: string;
  name: string;
  editable: boolean;
}

export const PAWFLY_PROGRAMS: readonly PawflyProgramInfo[] = [
  { index: 0, slug: "japanese_style", name: "Japanese style", editable: false },
  { index: 1, slug: "dutch_style", name: "Dutch style", editable: false },
  { index: 2, slug: "jungle_style", name: "Jungle style", editable: false },
  { index: 3, slug: "diy_1", name: "DIY 1", editable: true },
  { index: 4, slug: "diy_2", name: "DIY 2", editable: true },
  { index: 5, slug: "diy_3", name: "DIY 3", editable: true },
];

export function programBySlug(slug: string | null | undefined): PawflyProgramInfo | undefined {
  return slug ? PAWFLY_PROGRAMS.find((program) => program.slug === slug) : undefined;
}

/** Programme for a select option ("dutch_style"), a display name ("Dutch style"), or null;
 * `manual`, `unknown` and `unavailable` are not programmes. */
export function programFromOption(option: string | null | undefined): PawflyProgramInfo | null {
  if (!option) return null;
  const key = option.trim().toLowerCase().replace(/\s+/g, "_");
  return PAWFLY_PROGRAMS.find((program) => program.slug === key) ?? null;
}

/** The select option that activates `program`: the entity's own option list wins (slug or display
 * name), falling back to the slug from the integration contract. */
export function optionForProgram(program: PawflyProgramInfo, options: readonly string[] | undefined): string {
  return options?.find((option) => programFromOption(option)?.index === program.index) ?? program.slug;
}

// ---- scenes ----

export const SCENE_COUNT = 8;
const CYCLE_SCENE = 7;

interface SceneMeta {
  icon: IconName;
  /** Vendor app mirror colours (R, G, B, W percent), used when the light does not send `scene_colors`. */
  mirror: Levels;
  art?: string;
  motion?: EffectMotion;
  /** Tank colour when the mirror is not what the light looks like (the storm mirrors "all off"). */
  glow?: Levels;
}

/** Scene order is the device's (0-7). Icons follow the vendor app's tiles (cloud+sun, storm, sun,
 * moon, then its four text tiles). */
const SCENES: readonly SceneMeta[] = [
  { icon: "weatherPartlyCloudy", mirror: [30, 30, 30, 30] },
  { icon: "weatherLightning", mirror: [0, 0, 0, 0], art: "rgb(150, 170, 255)", motion: "storm", glow: [45, 60, 100, 25] },
  { icon: "weatherSunny", mirror: [100, 100, 100, 100] },
  { icon: "weatherNight", mirror: [0, 10, 100, 0] },
  { icon: "whiteBalanceIncandescent", mirror: [100, 0, 0, 100] },
  { icon: "lightbulbOn", mirror: [0, 0, 100, 100] },
  { icon: "whiteBalanceSunny", mirror: [0, 0, 0, 100] },
  { icon: "paletteSwatch", mirror: [100, 100, 100, 0], motion: "cycle", glow: [100, 0, 0, 0] },
];

export interface EffectCatalogue {
  /** Scene names in device order. */
  scenes: string[];
  /** The `Demo` effect name when the light offers it. */
  demo: string | null;
}

/** Split a light's `effect_list` into the 8 scenes (device order) and the Demo effect. */
export function effectCatalogue(effectList: readonly string[]): EffectCatalogue {
  const list = effectList.filter((name) => typeof name === "string" && name.length > 0);
  const demoAt = list.findIndex((name) => name.trim().toLowerCase() === "demo");
  return { demo: demoAt >= 0 ? list[demoAt]! : null, scenes: list.filter((_, index) => index !== demoAt).slice(0, SCENE_COUNT) };
}

/** Scene tiles for the Effects tab. `sceneColours` (the light's `scene_colors`) overrides the
 * built-in mirror table for the glow of scenes that have no motion. */
export function sceneEffects(scenes: readonly string[], sceneColours: Readonly<Record<string, Levels>> | null): EffectDef[] {
  return scenes.map((name, index) => {
    const meta = SCENES[index]!;
    const mirror = sceneColours?.[name] ?? meta.mirror;
    return {
      id: name,
      name,
      icon: meta.icon,
      art: index === CYCLE_SCENE ? "cycle" : (meta.art ?? null),
      glow: { levels: mirror },
      ...(meta.motion && meta.glow ? { motion: meta.motion, motionTank: { levels: meta.glow } } : {}),
    };
  });
}

// ---- colour presets ----

export const PAWFLY_SWATCHES: ReadonlyArray<{ id: string; name: string; levels: Levels }> = [
  { id: "daylight", name: "Daylight", levels: [70, 85, 100, 100] },
  { id: "neutral", name: "Neutral white", levels: [0, 0, 0, 100] },
  { id: "warm", name: "Warm white", levels: [100, 25, 0, 100] },
  { id: "sunrise", name: "Sunrise", levels: [100, 50, 10, 10] },
  { id: "sunset", name: "Sunset", levels: [100, 50, 15, 0] },
  { id: "moonlight", name: "Moonlight", levels: [0, 10, 100, 0] },
  { id: "reef", name: "Reef blue", levels: [0, 50, 100, 0] },
  { id: "growth", name: "Plant growth", levels: [100, 0, 100, 0] },
];

/** Points a fresh DIY programme starts from: a gentle day with a dark night. */
export function defaultDiyPoints(): Array<{ minutes: number; levels: number[] }> {
  return [
    { minutes: 7 * 60, levels: [0, 0, 0, 0] },
    { minutes: 8 * 60, levels: [20, 10, 25, 30] },
    { minutes: 12 * 60, levels: [70, 70, 90, 100] },
    { minutes: 18 * 60, levels: [50, 30, 30, 40] },
    { minutes: 21 * 60, levels: [0, 0, 20, 0] },
    { minutes: 22 * 60, levels: [0, 0, 0, 0] },
  ];
}

// ---- entities ----

export interface PawflyEntities {
  /** HA device id: what the `pawfly.*` services take. Empty when the light has no device. */
  deviceId: string;
  light: string;
  /** `select.*_program` */
  program?: string;
  /** `sensor.*_mode` */
  mode?: string;
  /** `binary_sensor.*_connected` */
  connected?: string;
}

type SiblingRole = "program" | "mode" | "connected";

const SIBLINGS: Record<SiblingRole, { domain: string; translationKey: string; suffix: string }> = {
  program: { domain: "select", translationKey: "program", suffix: "_program" },
  mode: { domain: "sensor", translationKey: "mode", suffix: "_mode" },
  connected: { domain: "binary_sensor", translationKey: "connected", suffix: "_connected" },
};

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf("."));
}

/** Siblings are matched on the registry's `translation_key` first (stable, name-independent) and
 * fall back to an entity-id suffix, so the card keeps working against a registry that omits
 * translation keys. null when `entityId` is not a light. */
export function resolvePawflyEntities(registry: Record<string, EntityRegistryEntry>, entityId: string): PawflyEntities | null {
  if (domainOf(entityId) !== "light") return null;
  const deviceId = registry[entityId]?.device_id ?? "";
  const result: PawflyEntities = { deviceId, light: entityId };
  if (!deviceId) return result;
  for (const entry of Object.values(registry)) {
    if (entry.device_id !== deviceId) continue;
    for (const role of Object.keys(SIBLINGS) as SiblingRole[]) {
      const rule = SIBLINGS[role];
      if (result[role] || domainOf(entry.entity_id) !== rule.domain) continue;
      if (entry.translation_key === rule.translationKey || entry.entity_id.endsWith(rule.suffix)) result[role] = entry.entity_id;
    }
  }
  return result;
}

// ---- state ----

export type PawflyMode = "manual" | "scene" | "program";

export interface PawflyReading {
  phase: "on" | "off" | "unavailable";
  name: string;
  /** Master brightness percent 1-100; null while off/unavailable (HA does not report it then). */
  brightness: number | null;
  /** [r, g, b, w] percent; null while off/unavailable. */
  mix: Levels | null;
  mode: PawflyMode | null;
  /** Running scene index 0-7 (scene mode). */
  scene: number | null;
  /** Running programme (program mode). */
  program: PawflyProgramInfo | null;
  /** The programmes this light offers (its static `programs` attribute, else the built-in table). */
  programs: PawflyProgramInfo[];
  effect: string | null;
  effectList: string[];
  /** The light's `scene_colors` attribute: scene name -> [r, g, b, w] percent. */
  sceneColours: Record<string, Levels> | null;
  /** The BLE link, from `binary_sensor.*_connected`; null when that entity is missing. */
  connected: boolean | null;
  /** Options of the programme select, when present. */
  programOptions: string[] | undefined;
  maxPoints: number;
}

const MODES: readonly string[] = ["manual", "scene", "program"];

function asMode(value: unknown): PawflyMode | null {
  return typeof value === "string" && MODES.includes(value) ? (value as PawflyMode) : null;
}

function asIndex(value: unknown, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `rgbw_color` attribute ([r,g,b,w] bytes) -> percent levels, or null when unusable. */
export function levelsFromRgbw(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const parts = value.slice(0, 4).map(Number);
  return parts.every((n) => Number.isFinite(n)) ? parts.map(byteToPercent) : null;
}

function sceneColoursFrom(value: unknown): Record<string, Levels> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, Levels> = {};
  for (const [name, colour] of Object.entries(value)) {
    if (!Array.isArray(colour) || colour.length < 4) continue;
    const parts = colour.slice(0, 4).map(Number);
    if (parts.every((n) => Number.isFinite(n))) result[name] = parts.map(clampPercent);
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** `null` until Home Assistant has the light's state at all. */
export function readPawflyState(states: Record<string, HassEntityState | undefined>, entities: PawflyEntities): PawflyReading | null {
  const light = states[entities.light];
  if (!light) return null;
  const attrs = light.attributes;
  const sensor = entities.mode ? states[entities.mode] : undefined;
  const select = entities.program ? states[entities.program] : undefined;
  const connected = entities.connected ? states[entities.connected] : undefined;

  const phase: PawflyReading["phase"] = light.state === "on" ? "on" : light.state === "off" ? "off" : light.state === "unavailable" || light.state === "unknown" ? "unavailable" : "off";
  const effectList = stringList(attrs.effect_list);
  const effect = typeof attrs.effect === "string" && attrs.effect ? attrs.effect : null;

  let scene = asIndex(attrs.scenario, SCENE_COUNT - 1);
  if (scene === null && effect) {
    const at = effectCatalogue(effectList).scenes.indexOf(effect);
    if (at >= 0) scene = at;
  }
  const programs = programInfos(attrs.programs);
  const runningIndex = asIndex(attrs.program, 63);
  let program: PawflyProgramInfo | null = programs.find((info) => info.index === runningIndex) ?? null;
  if (!program) program = programFromOption(typeof attrs.program_name === "string" ? attrs.program_name : null);
  if (!program && select && select.state !== "unknown" && select.state !== "unavailable") program = programFromOption(select.state);

  let mode = asMode(attrs.mode) ?? asMode(sensor?.state);
  if (mode === null && phase === "on") mode = program ? "program" : scene !== null || effect ? "scene" : "manual";

  const maxPoints = asIndex(attrs.max_program_points, 64) ?? DEFAULT_MAX_POINTS;
  return {
    phase,
    name: typeof attrs.friendly_name === "string" ? attrs.friendly_name : "",
    brightness: phase === "on" && typeof attrs.brightness === "number" ? brightnessToPercent(attrs.brightness) : null,
    mix: phase === "on" ? levelsFromRgbw(attrs.rgbw_color) : null,
    mode,
    scene: mode === "scene" ? scene : null,
    program: mode === "program" ? program : null,
    programs,
    effect: mode === "scene" ? effect : null,
    effectList,
    sceneColours: sceneColoursFrom(attrs.scene_colors),
    connected: connected ? (connected.state === "on" ? true : connected.state === "off" ? false : null) : null,
    programOptions: select ? stringList(select.attributes.options) : undefined,
    maxPoints: maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS,
  };
}

/** The programmes this light offers: its static `programs` attribute when it sends one, else the
 * built-in table. */
export function programInfos(attribute: unknown): PawflyProgramInfo[] {
  const fromLight: PawflyProgramInfo[] = [];
  if (Array.isArray(attribute)) {
    for (const row of attribute) {
      if (!row || typeof row !== "object" || !("program" in row) || !("slug" in row) || !("name" in row)) continue;
      const index = asIndex(row.program, 63);
      if (index === null || typeof row.slug !== "string" || typeof row.name !== "string") continue;
      fromLight.push({ index, slug: row.slug, name: row.name, editable: "editable" in row ? row.editable === true : index >= FIRST_DIY_PROGRAM });
    }
  }
  return fromLight.length > 0 ? fromLight : [...PAWFLY_PROGRAMS];
}

/** Entries for the Schedule tab's programme picker. */
export function scheduleProgramsFor(programs: readonly PawflyProgramInfo[]): ScheduleProgram[] {
  return programs.map((program) => ({ id: program.slug, name: program.name, group: program.editable ? "Your programs" : "Presets", editable: program.editable }));
}

// ---- status wording ----

/** Words for the hero's chips and its accessible summary. Chips pair an icon with text, so state
 * never rests on colour alone. Sentence case, no separators: two facts are a phrase. */
export function describePawflyStatus(reading: PawflyReading | null): Status {
  if (!reading) {
    return { chips: [{ label: "Connecting", kind: "neutral", icon: "bluetooth" }], mode: null, summary: "Waiting for the light's state." };
  }
  if (reading.phase === "unavailable") {
    const down = reading.connected === false;
    return {
      chips: [{ label: down ? "Disconnected" : "Unavailable", kind: "warning", icon: "bluetoothOff" }],
      mode: null,
      summary: down ? "The Bluetooth link to the light is down." : "Home Assistant reports the light as unavailable.",
    };
  }
  const link: StatusChip = reading.connected === false ? { label: "Disconnected", kind: "warning", icon: "bluetoothOff" } : { label: "Connected", kind: "positive", icon: "bluetooth" };
  if (reading.phase === "off") return { chips: [link], mode: "Off", summary: "The light is off." };

  const percent = reading.brightness !== null ? ` at ${reading.brightness}% brightness` : "";
  const colours = reading.mix ? `, ${levelsLabel(reading.mix, PAWFLY_CHANNELS)}` : "";
  if (reading.mode === "scene") {
    const name = reading.effect ?? (reading.scene !== null ? effectCatalogue(reading.effectList).scenes[reading.scene] : undefined);
    return { chips: [link], mode: name ? `${name} scene` : "Scene", summary: `Playing the ${name ?? "built-in"} scene${percent}.` };
  }
  if (reading.mode === "program") {
    const name = reading.program?.name;
    return { chips: [link], mode: name ? `${name} schedule` : "Schedule", summary: `Following the ${name ?? "selected"} schedule${percent}.` };
  }
  return { chips: [link], mode: reading.mode === "manual" ? "Manual colour" : "On", summary: `On${percent}${colours}.` };
}

// ---- services ----

const DOMAIN = "pawfly";

/** Tolerant read of a `get_program` / `set_program` `points` array (`{time, red, green, blue,
 * white}` rows): bad rows are dropped, levels clamped to whole percent, the rest sorted by time
 * with duplicate times collapsed. */
export function fromServiceRows(raw: unknown): SchedulePoint[] {
  if (!Array.isArray(raw)) return [];
  const points: SchedulePoint[] = [];
  const seen = new Set<number>();
  for (const row of raw) {
    if (!row || typeof row !== "object" || !("time" in row) || typeof row.time !== "string") continue;
    const minutes = parseTime(row.time);
    if (minutes === null || seen.has(minutes)) continue;
    seen.add(minutes);
    const levels = SERVICE_CHANNEL_KEYS.map((key) => clampPercent(key in row ? Number(row[key as keyof typeof row]) : 0));
    points.push({ minutes, levels });
  }
  return sortPoints(points);
}

export function toServiceRows(points: readonly SchedulePoint[]): Array<Record<string, string | number>> {
  return sortPoints(points).map((point) => {
    const row: Record<string, string | number> = { time: formatTime(point.minutes) };
    SERVICE_CHANNEL_KEYS.forEach((key, index) => (row[key] = point.levels[index] ?? 0));
    return row;
  });
}

interface ServiceResult<T> {
  context?: unknown;
  response?: T;
}

async function callForResponse<T>(callWS: CallWS, service: string, data: Record<string, unknown>): Promise<T> {
  const result = await callWS<ServiceResult<T>>({ type: "call_service", domain: DOMAIN, service, service_data: data, return_response: true });
  if (!result || result.response === undefined || result.response === null) throw new Error("The light returned no data.");
  return result.response;
}

async function callForEffect(callWS: CallWS, service: string, data: Record<string, unknown>): Promise<void> {
  await callWS({ type: "call_service", domain: DOMAIN, service, service_data: data });
}

/** Presets are the vendor app's tables; on the real light the Dutch style is slightly dimmer than
 * its table between 08:00 and 11:00 (checked with a camera), so it is not presented as exact. */
export function presetNote(slug: string): string {
  const base = "Shown as in the vendor app.";
  return slug === "dutch_style" ? `${base} On the light itself the Dutch style is a little dimmer between 08:00 and 11:00 than this chart.` : base;
}

interface ProgramResponse {
  program?: number;
  name?: string;
  source?: string;
  editable?: boolean;
  points?: unknown;
}

export async function fetchProgram(callWS: CallWS, deviceId: string, program: PawflyProgramInfo): Promise<ProgramData> {
  const raw = await callForResponse<ProgramResponse>(callWS, "get_program", { device_id: deviceId, program: program.index });
  const source = raw.source === "device" || raw.source === "preset" ? raw.source : null;
  return {
    id: program.slug,
    name: typeof raw.name === "string" && raw.name ? raw.name : program.name,
    points: fromServiceRows(raw.points),
    editable: typeof raw.editable === "boolean" ? raw.editable : program.editable,
    source,
    ...(source === "preset" ? { note: presetNote(program.slug) } : {}),
  };
}

interface SaveResponse {
  points?: unknown;
  verified?: boolean;
}

export interface SavedProgram {
  points: ProgramData["points"];
  verified: boolean;
}

export async function saveProgram(callWS: CallWS, deviceId: string, program: PawflyProgramInfo, points: readonly SchedulePoint[]): Promise<SavedProgram> {
  const raw = await callForResponse<SaveResponse>(callWS, "set_program", { device_id: deviceId, program: program.index, points: toServiceRows(points) });
  const readBack = raw.points === undefined ? null : fromServiceRows(raw.points);
  return { points: readBack ?? [...points], verified: raw.verified === true && readBack !== null };
}

export function showPreview(callWS: CallWS, deviceId: string, levels: Levels): Promise<void> {
  const data: Record<string, unknown> = { device_id: deviceId };
  SERVICE_CHANNEL_KEYS.forEach((key, index) => (data[key] = clampPercent(levels[index] ?? 0)));
  return callForEffect(callWS, "preview", data);
}

export function endPreview(callWS: CallWS, deviceId: string): Promise<void> {
  return callForEffect(callWS, "preview", { device_id: deviceId, end: true });
}

/** Write ONLY the given channels (index -> percent) through `pawfly.set_channel`. */
export function setChannels(callWS: CallWS, deviceId: string, changes: Readonly<Record<number, number>>): Promise<void> {
  const data: Record<string, unknown> = { device_id: deviceId };
  for (const [index, value] of Object.entries(changes)) {
    const key = SERVICE_CHANNEL_KEYS[Number(index)];
    if (key) data[key] = clampPercent(value);
  }
  return callForEffect(callWS, "set_channel", data);
}

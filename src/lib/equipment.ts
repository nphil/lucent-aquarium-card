/** The rules behind the equipment card, pure: what an outlet is doing (from its switch and how much
 * power it draws), whether the water is comfortable, how old a reading is, what turning something
 * off would cost, what the CO2 outlet is allowed to do, and the shape of the temperature history.
 * Nothing here knows about Home Assistant's runtime or the DOM. */

import type { HassEntityState, OutletRole } from "../types.ts";
import type { IconName } from "./icons.ts";
import { formatTime } from "./points.ts";

// ---- roles ----

export const OUTLET_ROLES: readonly OutletRole[] = ["filter", "heater", "co2", "uv", "light", "spare"];

interface RoleInfo {
  icon: IconName;
  /** Name used when neither the config nor Home Assistant gives one. */
  title: string;
}

export const ROLE_INFO: Readonly<Record<OutletRole, RoleInfo>> = {
  filter: { icon: "waterPump", title: "Filter" },
  heater: { icon: "heatingCoil", title: "Heater" },
  co2: { icon: "moleculeCo2", title: "CO2" },
  uv: { icon: "lightbulbTube", title: "UV lamp" },
  light: { icon: "lightbulb", title: "Light" },
  spare: { icon: "powerSocket", title: "Spare outlet" },
};

/** A role from the configuration; anything unknown or missing is a plain outlet. */
export function normaliseRole(value: unknown): OutletRole {
  return OUTLET_ROLES.find((role) => role === value) ?? "spare";
}

// ---- what an outlet is doing ----

/** Below this a powered outlet draws (almost) nothing: a heater idling at 0.8 W is idle, a filter
 * at 6.8 W is running. */
export const RUNNING_WATTS = 1.5;
/** The light outlet feeds the Fluval, which draws far less than this when its lamp is off; the
 * lighting automation also counts the lamp as on from 8 W. */
export const LAMP_WATTS = 8;

export type StatusTone = "positive" | "neutral" | "warning" | "danger";

export interface OutletStatus {
  label: string;
  tone: StatusTone;
  /** A second, plainer line, when the label alone could mislead. */
  detail?: string;
}

export interface OutletFacts {
  role: OutletRole;
  critical: boolean;
  /** The switch's state as Home Assistant reports it (undefined: it has none at all). */
  state: string | undefined;
  /** What the outlet draws now; null when there is no power sensor or it has no reading. */
  watts: number | null;
}

/** Running / Idle / On, no draw / Off / Unavailable, worded for what is plugged in. A critical
 * outlet that is off or unreachable is worth attention; a spare one is not. */
export function outletStatus({ role, critical, state, watts }: OutletFacts): OutletStatus {
  if (state === undefined || state === "unavailable" || state === "unknown") {
    return { label: "Unavailable", tone: critical ? "danger" : "warning", detail: "Home Assistant can't reach this outlet." };
  }
  if (state === "off") {
    // Switched off but still drawing power: a stuck relay, or a solenoid that has not closed.
    if (watts !== null && watts >= RUNNING_WATTS) return { label: "Off, still drawing", tone: critical || role === "co2" ? "danger" : "warning", detail: "Switched off, but it is still drawing power." };
    return { label: "Off", tone: critical ? "warning" : "neutral" };
  }
  if (state !== "on") return { label: "Unavailable", tone: critical ? "danger" : "warning", detail: "Home Assistant can't reach this outlet." };
  if (watts === null) return { label: "On", tone: "neutral" };
  if (role === "light") return watts >= LAMP_WATTS ? { label: "Lamp on", tone: "positive" } : { label: "Lamp off", tone: "neutral", detail: "Powered, but the lamp is not drawing." };
  if (role === "heater") return watts >= RUNNING_WATTS ? { label: "Heating", tone: "positive" } : { label: "Idle", tone: "neutral", detail: "On, waiting for the water to cool." };
  if (watts >= RUNNING_WATTS) return { label: "Running", tone: "positive" };
  return { label: "On, no draw", tone: role === "spare" ? "neutral" : "warning", detail: "On, drawing no power." };
}

/** What an outlet draws when it is off and still reads a little: standby noise, not worth a number. */
export const STANDBY_NOISE_WATTS = 0.5;

/** The draw worth putting on a tile: the reading while the outlet is on (even a heater idling at
 * 0.8 W), and while it is off only a draw that means something is wrong. */
export function wattsToShow(on: boolean, watts: number | null): number | null {
  if (watts === null) return null;
  return on || watts >= STANDBY_NOISE_WATTS ? watts : null;
}

/** A power sensor's reading in watts; null when it has none. */
export function readWatts(state: HassEntityState | undefined): number | null {
  if (!state || state.state.trim() === "") return null;
  const value = Number(state.state);
  if (!Number.isFinite(value)) return null;
  const unit = state.attributes.unit_of_measurement;
  return unit === "kW" ? value * 1000 : unit === "mW" ? value / 1000 : value;
}

export function formatWatts(watts: number): string {
  if (watts >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return watts < 10 ? `${watts.toFixed(1)} W` : `${Math.round(watts)} W`;
}

/** The sum of the known readings; null when nothing is known. */
export function totalWatts(readings: ReadonlyArray<number | null>): number | null {
  const known = readings.filter((reading): reading is number => reading !== null);
  return known.length === 0 ? null : known.reduce((sum, reading) => sum + reading, 0);
}

/** The words every name starts with ("Aquarium canister filter", "Aquarium heater") left off: the
 * card is about one aquarium already. Names are kept whole unless that would leave one empty. */
export function shortNames(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const first = names[0]!.split(/\s+/)[0]!.toLowerCase();
  const shared = first !== "" && names.every((name) => name.toLowerCase().startsWith(`${first} `));
  if (!shared) return [...names];
  const trimmed = names.map((name) => name.slice(first.length).trim());
  if (trimmed.some((name) => name === "")) return [...names];
  return trimmed.map((name) => name.charAt(0).toUpperCase() + name.slice(1));
}

// ---- turning something off ----

export interface OffCost {
  /** What switching it off means, in one line. */
  text: string;
  tone: "danger" | "neutral";
}

/** What a hold has to say before an outlet is switched off; null when it may just be switched. A
 * critical outlet (the fish depend on it) asks in the danger tone; the light outlet asks too,
 * without alarm, because it takes the Fluval's power away. */
export function offCost(role: OutletRole, critical: boolean): OffCost | null {
  if (critical) {
    const text: Record<OutletRole, string> = {
      filter: "Fish need the filter running. Turn it back on as soon as you're done.",
      heater: "The water stops being heated and will cool down. Turn it back on as soon as you're done.",
      co2: "Switching CO2 off is safe for the fish, but the plants lose it until it is back.",
      uv: "The UV lamp stops clearing the water until it is back on.",
      light: "The Fluval loses power and the tank goes dark.",
      spare: "Whatever is plugged in loses power.",
    };
    return { text: text[role], tone: "danger" };
  }
  return role === "light" ? { text: "The Fluval loses power and the tank goes dark.", tone: "neutral" } : null;
}

// ---- the CO2 outlet ----

export interface Co2Window {
  enabled: boolean;
  /** Minutes of the day. */
  start: number;
  end: number;
}

export interface Co2Note {
  text: string;
  tone: "neutral" | "warning";
}

/** The automation also wants proof that the lamp is lit before CO2 runs, from `checkFrom` (the
 * program's `light_check`) until the window ends: the light outlet must draw `LAMP_WATTS` or more. A
 * light outlet with no reading proves nothing either way. */
export interface LightProof {
  checkFrom: number | null;
  /** What the light outlet draws; null when it has no reading. */
  watts: number | null;
}

/** What the CO2 tile says about the guard: the automation only lets CO2 run inside the running
 * program's window (and, later in the morning, while the lamp is drawing power), and turns it off
 * when it finds it on outside that. `window` is null when the program's settings are not known
 * (not an administrator, not loaded yet). */
export function co2Note(input: { window: Co2Window | null; programName: string | null; nowMinutes: number; on: boolean; light?: LightProof }): Co2Note {
  const { window, programName, nowMinutes, on, light } = input;
  if (!window) {
    return { text: programName ? `Runs only inside the CO2 window of ${programName}.` : "Runs only inside the lighting program's CO2 window.", tone: "neutral" };
  }
  const name = programName ?? "this program";
  if (!window.enabled) {
    return on ? { text: `CO2 is off in ${name}, so Home Assistant switches it off again.`, tone: "warning" } : { text: `CO2 is off in ${name}.`, tone: "neutral" };
  }
  const span = `${formatTime(window.start)}–${formatTime(window.end)}`;
  const inside = window.start < window.end && nowMinutes >= window.start && nowMinutes < window.end;
  if (inside) {
    const dark = light !== undefined && light.checkFrom !== null && nowMinutes >= light.checkFrom && light.watts !== null && light.watts < LAMP_WATTS;
    if (dark) return on ? { text: "The lamp isn't drawing power: Home Assistant switches CO2 off.", tone: "warning" } : { text: "Held off: waiting for the lamp to draw power.", tone: "warning" };
    return on ? { text: `Running until ${formatTime(window.end)}`, tone: "neutral" } : { text: `In its window until ${formatTime(window.end)}, not running`, tone: "neutral" };
  }
  if (on) return { text: "Outside its window: Home Assistant switches it off again.", tone: "warning" };
  return { text: nowMinutes >= window.end ? `Next: ${span} tomorrow` : `Next: ${span}`, tone: "neutral" };
}

// ---- the water ----

export interface Temperature {
  value: number;
  /** As the sensor reports it ("°F"); empty when it says nothing. */
  unit: string;
  /** When Home Assistant last heard from the sensor (ms since the epoch); null when unknown. */
  updatedMs: number | null;
}

export function readTemperature(state: HassEntityState | undefined): Temperature | null {
  if (!state || state.state.trim() === "") return null;
  const value = Number(state.state);
  if (!Number.isFinite(value)) return null;
  const unit = state.attributes.unit_of_measurement;
  // A steady reading changes neither its state nor its attributes, but the sensor still reports.
  const heard = [state.last_updated, state.last_reported].map((text) => (typeof text === "string" ? Date.parse(text) : Number.NaN)).filter((ms) => Number.isFinite(ms));
  return { value, unit: typeof unit === "string" ? unit : "", updatedMs: heard.length > 0 ? Math.max(...heard) : null };
}

export interface Band {
  min: number;
  max: number;
}

/** The comfortable band from the configuration; null unless both ends are numbers in order. */
export function readBand(min: unknown, max: unknown): Band | null {
  return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}

export interface Verdict {
  position: "in" | "low" | "high";
  tone: "positive" | "warning" | "danger";
  /** How far outside the band it is (0 inside). */
  away: number;
}

/** Inside the band is fine; outside it warns, and further out than half the band's width it is
 * dangerous. */
export function judgeTemperature(value: number, band: Band): Verdict {
  if (value < band.min) {
    const away = band.min - value;
    return { position: "low", tone: away > (band.max - band.min) / 2 ? "danger" : "warning", away };
  }
  if (value > band.max) {
    const away = value - band.max;
    return { position: "high", tone: away > (band.max - band.min) / 2 ? "danger" : "warning", away };
  }
  return { position: "in", tone: "positive", away: 0 };
}

export function describeVerdict(verdict: Verdict, band: Band, unit: string): string {
  const degrees = (amount: number): string => `${Math.round(amount * 10) / 10}${unit.startsWith("°") ? "°" : ` ${unit}`.trimEnd()}`;
  if (verdict.position === "in") return `In the comfortable range, ${band.min}–${band.max}${unit}`;
  return `${degrees(verdict.away)} ${verdict.position === "low" ? "below" : "above"} the comfortable range`;
}

export interface BandTrack {
  /** Where the comfortable band starts and ends along the track, 0-1. */
  from: number;
  to: number;
  /** Where the reading sits, 0-1; null without a reading. */
  marker: number | null;
}

/** The band indicator: a track wider than the band by three quarters of its width on each side,
 * so the band sits in the middle and a reading can leave it on either end. The marker stops at
 * the track's ends rather than leaving it. */
export function bandTrack(value: number | null, band: Band): BandTrack {
  const pad = (band.max - band.min) * 0.75;
  const low = band.min - pad;
  const span = band.max - band.min + 2 * pad;
  const at = (amount: number): number => Math.min(1, Math.max(0, (amount - low) / span));
  return { from: at(band.min), to: at(band.max), marker: value === null ? null : at(value) };
}

/** A reading more than this old is worth a warning: a heater failing at night is exactly when a
 * silent sensor would hide it. */
export const STALE_READING_MS = 2 * 3_600_000;

export function describeAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** A battery level (percent) from its sensor; null when it has none. */
export function readBattery(state: HassEntityState | undefined): number | null {
  if (!state || state.state.trim() === "") return null;
  const value = Number(state.state);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null;
}

export function batteryTone(percent: number): "neutral" | "warning" | "danger" {
  return percent <= 10 ? "danger" : percent <= 20 ? "warning" : "neutral";
}

// ---- the history ----

export interface HistoryPoint {
  /** ms since the epoch. */
  t: number;
  v: number;
}

const timeOf = (item: Record<string, unknown>): number | null => {
  for (const key of ["lu", "lc"]) {
    const seconds = item[key];
    if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds * 1000;
  }
  for (const key of ["last_updated", "last_changed"]) {
    const text = item[key];
    const parsed = typeof text === "string" ? Date.parse(text) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/** The numeric history of one entity out of `history/history_during_period`'s compact answer
 * (`{entity_id: [{s: state, lu: seconds}, ...]}`; the long form with `state` and `last_updated`
 * is read too). Readings that are not numbers are left out; the result is in time order. */
export function parseHistory(answer: unknown, entityId: string): HistoryPoint[] {
  if (!answer || typeof answer !== "object" || !(entityId in answer)) return [];
  const rows = (answer as Record<string, unknown>)[entityId];
  if (!Array.isArray(rows)) return [];
  const points: HistoryPoint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const raw = item.s ?? item.state;
    const t = timeOf(item);
    const v = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
    if (t !== null && Number.isFinite(v)) points.push({ t, v });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** At most `buckets` points: each bucket of time is replaced by the average of what fell in it,
 * so a sensor that reports every few seconds does not become a thousand-point path. */
export function downsample(points: readonly HistoryPoint[], start: number, end: number, buckets: number): HistoryPoint[] {
  if (points.length <= buckets || end <= start) return [...points];
  const width = (end - start) / buckets;
  const sums = new Array<{ t: number; v: number; n: number }>(buckets);
  for (const point of points) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((point.t - start) / width)));
    const bucket = (sums[index] ??= { t: 0, v: 0, n: 0 });
    bucket.t += point.t;
    bucket.v += point.v;
    bucket.n += 1;
  }
  return sums.filter((bucket): bucket is { t: number; v: number; n: number } => bucket !== undefined).map((bucket) => ({ t: bucket.t / bucket.n, v: bucket.v / bucket.n }));
}

export interface SparklineBox {
  width: number;
  height: number;
  /** Room left inside the box for the line's ends and the end dot. */
  pad: number;
}

export interface Sparkline {
  /** SVG path data of the line. */
  path: string;
  /** The last point, for the end dot. */
  last: { x: number; y: number } | null;
  /** Where the comfortable band lies, as y coordinates (top first); null without a band. */
  band: { top: number; bottom: number } | null;
  low: number;
  high: number;
}

/** The line of `points` across [start, end] in `box`. The vertical scale always includes the
 * comfortable band when there is one, so a steady reading is seen to be inside it. */
export function sparkline(points: readonly HistoryPoint[], start: number, end: number, box: SparklineBox, band: Band | null): Sparkline | null {
  if (points.length === 0 || end <= start) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const point of points) {
    low = Math.min(low, point.v);
    high = Math.max(high, point.v);
  }
  const dataLow = low;
  const dataHigh = high;
  if (band) {
    low = Math.min(low, band.min);
    high = Math.max(high, band.max);
  }
  const margin = Math.max((high - low) * 0.1, 0.5);
  low -= margin;
  high += margin;
  const x = (t: number): number => box.pad + Math.min(1, Math.max(0, (t - start) / (end - start))) * (box.width - 2 * box.pad);
  const y = (v: number): number => box.pad + (1 - (v - low) / (high - low)) * (box.height - 2 * box.pad);
  const round = (n: number): number => Math.round(n * 10) / 10;
  const path = points.map((point, i) => `${i === 0 ? "M" : "L"}${round(x(point.t))} ${round(y(point.v))}`).join(" ");
  const tail = points[points.length - 1]!;
  return {
    path,
    last: { x: round(x(tail.t)), y: round(y(tail.v)) },
    band: band ? { top: round(y(band.max)), bottom: round(y(band.min)) } : null,
    low: dataLow,
    high: dataHigh,
  };
}

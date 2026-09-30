/** Fluval "lighting programs": named plans, each a light schedule plus a CO2 window, that the
 * aquarium automation keeps in its top-level `variables.programs`. A helper (`input_select`)
 * names the running program, and the automation writes that program's `schedule` to the light
 * with `fluvalble.set_native_auto_schedule` and lets CO2 follow its window. This module is the
 * pure part: reading the automation's configuration, the editable draft and its rules, patching
 * ONE program back into the configuration, and the time arithmetic ("running 5 days", "ends in
 * 62 h"). It needs no Home Assistant runtime. See `fluval-program-plan.ts` for the calls.
 *
 * A program looks like this (times are "HH:MM"; the light takes exactly these five channels):
 *
 *   Algae Reset:
 *     co2_enabled: true, co2_start: "07:30", co2_end: "14:00", light_check: "09:15"
 *     review_every_days: 7, max_days: 0, summary: "..."
 *     schedule: { sunrise, sunrise_ramp, sunset, sunset_ramp, sleep,
 *                 day: { channel_1 .. channel_5 }, night: { channel_1 .. channel_5 } }
 */

import { zonedTimeToEpochMs } from "../lib/clock.ts";
import { isJsonObject, sameJson, type JsonObject } from "../lib/json.ts";
import { formatTime, parseTime, type SchedulePoint } from "../lib/points.ts";
import type { HassEntityState, ProgramConfig } from "../types.ts";
import { autoSchedulePoints, RAMP_MAX, type AutoSchedule } from "./fluval-data.ts";


/** The light takes all five channels whatever it has fitted, so a program stores five. */
export const STORED_CHANNEL_KEYS = ["channel_1", "channel_2", "channel_3", "channel_4", "channel_5"] as const;

const DAY_MINUTES = 1440;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A sane ceiling for the day counts. */
export const DAYS_MAX = 365;

// ---- the automation's configuration ----

export interface StoredSchedule {
  /** Minutes of the day. */
  sunrise: number;
  sunriseRamp: number;
  sunset: number;
  sunsetRamp: number;
  sleep: number | null;
  /** All five stored channels, in channel order, percent. */
  day: number[];
  night: number[];
}

export interface LightingProgram {
  name: string;
  summary: string;
  co2Enabled: boolean;
  /** Minutes of the day. */
  co2Start: number;
  co2End: number;
  /** From this time of day CO2 also needs the lamp to be drawing power (the automation's
   * `light_check`); null when the program names none. */
  lightCheck: number | null;
  /** A reminder every N days while the program runs; 0 = never. */
  reviewEveryDays: number;
  /** The program ends by itself after N days; 0 = never. */
  maxDays: number;
  schedule: StoredSchedule;
}

/** One entry of `variables.programs`: readable, or kept in the list with the reason it is not. */
export type LightingEntry = { ok: true; program: LightingProgram; raw: JsonObject } | { ok: false; name: string; reason: string };

export interface AutomationPrograms {
  /** The automation's own id: the save endpoint is addressed with it. */
  id: string;
  entries: ReadonlyMap<string, LightingEntry>;
  /** A clock time the automation stops CO2 at whatever the programs say (its `co2_window_end`
   * trigger), so a later end time in a program cannot take effect. null when there is none. */
  co2FixedStop: number | null;
}

const STRICT_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function readTime(value: unknown): number | null {
  return typeof value === "string" && STRICT_TIME.test(value) ? parseTime(value) : null;
}

const isCount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

function readLevels(value: unknown, label: string): number[] | string {
  if (!isJsonObject(value)) return `${label} levels are missing`;
  const levels: number[] = [];
  for (const key of STORED_CHANNEL_KEYS) {
    const level = value[key];
    if (!isCount(level, 100)) return `${label}.${key} must be a whole number from 0 to 100`;
    levels.push(level);
  }
  return levels;
}

function readProgram(name: string, raw: unknown): LightingEntry {
  const fail = (reason: string): LightingEntry => ({ ok: false, name, reason });
  if (!isJsonObject(raw)) return fail("it has no settings");
  const stored = raw.schedule;
  if (!isJsonObject(stored)) return fail("it has no light schedule");

  const sunrise = readTime(stored.sunrise);
  const sunset = readTime(stored.sunset);
  if (sunrise === null) return fail("its sunrise isn't a time like 08:30");
  if (sunset === null) return fail("its sunset isn't a time like 15:30");
  const sunriseRamp = stored.sunrise_ramp;
  const sunsetRamp = stored.sunset_ramp;
  if (!isCount(sunriseRamp, RAMP_MAX)) return fail(`its sunrise ramp must be a whole number of minutes from 0 to ${RAMP_MAX}`);
  if (!isCount(sunsetRamp, RAMP_MAX)) return fail(`its sunset ramp must be a whole number of minutes from 0 to ${RAMP_MAX}`);
  let sleep: number | null = null;
  if (stored.sleep !== undefined && stored.sleep !== null && stored.sleep !== "") {
    sleep = readTime(stored.sleep);
    if (sleep === null) return fail("its sleep time isn't a time like 22:00");
  }
  const day = readLevels(stored.day, "day");
  if (typeof day === "string") return fail(day);
  const night = readLevels(stored.night, "night");
  if (typeof night === "string") return fail(night);

  const enabled = raw.co2_enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") return fail("co2_enabled must be true or false");
  const co2Enabled = enabled === true;
  let co2Start = 0;
  let co2End = 0;
  if (co2Enabled) {
    const start = readTime(raw.co2_start);
    const end = readTime(raw.co2_end);
    if (start === null || end === null) return fail("its CO2 window needs a start and an end time like 08:00");
    co2Start = start;
    co2End = end;
  } else {
    co2Start = readTime(raw.co2_start) ?? 0;
    co2End = readTime(raw.co2_end) ?? 0;
  }
  const review = raw.review_every_days ?? 0;
  const max = raw.max_days ?? 0;
  if (!isCount(review, DAYS_MAX)) return fail("review_every_days must be a whole number of days");
  if (!isCount(max, DAYS_MAX)) return fail("max_days must be a whole number of days");

  const program: LightingProgram = {
    name,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    co2Enabled,
    co2Start,
    co2End,
    lightCheck: readTime(raw.light_check),
    reviewEveryDays: review,
    maxDays: max,
    schedule: { sunrise, sunriseRamp, sunset, sunsetRamp, sleep, day, night },
  };
  return { ok: true, program, raw };
}

/** The latest fixed CO2 stop among the automation's time triggers named `co2_window_end`. */
function fixedCo2Stop(config: JsonObject): number | null {
  const triggers = config.triggers ?? config.trigger;
  if (!Array.isArray(triggers)) return null;
  let latest: number | null = null;
  for (const trigger of triggers) {
    if (!isJsonObject(trigger) || trigger.id !== "co2_window_end") continue;
    if ((trigger.trigger ?? trigger.platform) !== "time") continue;
    const at = typeof trigger.at === "string" ? parseTime(trigger.at) : null;
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** The programs out of the automation's configuration (`automation/config` answers with it).
 * Throws an Error whose message is written for people when the automation cannot be used. */
export function readAutomationPrograms(config: unknown): AutomationPrograms {
  if (!isJsonObject(config)) throw new Error("Home Assistant didn't return a configuration for the automation.");
  const id = config.id;
  if (typeof id !== "string" || id === "") throw new Error("This automation has no id, so Home Assistant can't save changes to it from a card (it is probably defined in YAML).");
  const variables = config.variables;
  const programs = isJsonObject(variables) ? variables.programs : undefined;
  if (!isJsonObject(programs)) throw new Error("The automation has no programs. They belong in its variables, under programs.");
  const entries = new Map<string, LightingEntry>();
  for (const [name, raw] of Object.entries(programs)) entries.set(name, readProgram(name, raw));
  return { id, entries, co2FixedStop: fixedCo2Stop(config) };
}

// ---- the editable draft ----

/** What the editor changes. Times are minutes of the day. Levels cover the channels the light
 * really has; the others stay as stored. */
export interface ProgramDraft {
  summary: string;
  co2Enabled: boolean;
  co2Start: number;
  co2End: number;
  reviewEveryDays: number;
  maxDays: number;
  sunrise: number;
  sunriseRamp: number;
  sunset: number;
  sunsetRamp: number;
  sleepOn: boolean;
  sleep: number;
  day: number[];
  night: number[];
}

/** A sleep time for a program that has none yet: 22:00, or an hour after sunset if that is later. */
export function defaultSleep(sunset: number): number {
  return Math.min(DAY_MINUTES - 1, Math.max(22 * 60, sunset + 60));
}

export function draftFromProgram(program: LightingProgram, channelCount: number): ProgramDraft {
  const { schedule } = program;
  const count = Math.max(0, Math.min(STORED_CHANNEL_KEYS.length, channelCount));
  return {
    summary: program.summary,
    co2Enabled: program.co2Enabled,
    co2Start: program.co2Start,
    co2End: program.co2End,
    reviewEveryDays: program.reviewEveryDays,
    maxDays: program.maxDays,
    sunrise: schedule.sunrise,
    sunriseRamp: schedule.sunriseRamp,
    sunset: schedule.sunset,
    sunsetRamp: schedule.sunsetRamp,
    sleepOn: schedule.sleep !== null,
    sleep: schedule.sleep ?? defaultSleep(schedule.sunset),
    day: schedule.day.slice(0, count),
    night: schedule.night.slice(0, count),
  };
}

export function draftsEqual(a: ProgramDraft, b: ProgramDraft): boolean {
  return (
    a.summary === b.summary &&
    a.co2Enabled === b.co2Enabled &&
    a.co2Start === b.co2Start &&
    a.co2End === b.co2End &&
    a.reviewEveryDays === b.reviewEveryDays &&
    a.maxDays === b.maxDays &&
    a.sunrise === b.sunrise &&
    a.sunriseRamp === b.sunriseRamp &&
    a.sunset === b.sunset &&
    a.sunsetRamp === b.sunsetRamp &&
    a.sleepOn === b.sleepOn &&
    (!a.sleepOn || a.sleep === b.sleep) &&
    a.day.length === b.day.length &&
    a.day.every((level, i) => level === b.day[i]) &&
    a.night.length === b.night.length &&
    a.night.every((level, i) => level === b.night[i])
  );
}

export type DraftField = "sunrise" | "sunriseRamp" | "sunset" | "sunsetRamp" | "sleep" | "day" | "night" | "co2Start" | "co2End" | "reviewEveryDays" | "maxDays";

export interface DraftIssue {
  field: DraftField;
  message: string;
}

const isMinute = (value: number): boolean => Number.isInteger(value) && value >= 0 && value < DAY_MINUTES;
const clock = (minutes: number): string => formatTime(((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES);

/** Why this draft cannot be saved. Empty when it can. */
export function validateDraft(draft: ProgramDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (field: DraftField, message: string): void => void issues.push({ field, message });

  if (!isMinute(draft.sunrise)) add("sunrise", "Sunrise needs a time between 00:00 and 23:59.");
  if (!isMinute(draft.sunset)) add("sunset", "Sunset needs a time between 00:00 and 23:59.");
  if (!Number.isInteger(draft.sunriseRamp) || draft.sunriseRamp < 0 || draft.sunriseRamp > RAMP_MAX) add("sunriseRamp", `The sunrise ramp runs from 0 to ${RAMP_MAX} minutes.`);
  if (!Number.isInteger(draft.sunsetRamp) || draft.sunsetRamp < 0 || draft.sunsetRamp > RAMP_MAX) add("sunsetRamp", `The sunset ramp runs from 0 to ${RAMP_MAX} minutes.`);

  const timesOk = isMinute(draft.sunrise) && isMinute(draft.sunset) && issues.length === 0;
  if (timesOk) {
    const risen = draft.sunrise + draft.sunriseRamp;
    const setting = draft.sunset - draft.sunsetRamp;
    if (risen >= setting) add("sunset", `Sunrise is at full light at ${clock(risen)}, but sunset starts to dim at ${clock(setting)}. Shorten a ramp or move a time.`);
  }

  if (draft.sleepOn) {
    if (!isMinute(draft.sleep)) add("sleep", "Sleep needs a time between 00:00 and 23:59.");
    else if (isMinute(draft.sunrise) && isMinute(draft.sunset) && draft.sleep >= draft.sunrise && draft.sleep < draft.sunset) add("sleep", `Sleep should come after sunset (${clock(draft.sunset)}) or before sunrise (${clock(draft.sunrise)}).`);
  }

  const badLevel = (levels: readonly number[]): boolean => levels.some((level) => !Number.isInteger(level) || level < 0 || level > 100);
  if (badLevel(draft.day)) add("day", "Levels run from 0 to 100%.");
  if (badLevel(draft.night)) add("night", "Levels run from 0 to 100%.");

  if (draft.co2Enabled) {
    if (!isMinute(draft.co2Start)) add("co2Start", "CO2 needs a start time.");
    if (!isMinute(draft.co2End)) add("co2End", "CO2 needs an end time.");
    if (isMinute(draft.co2Start) && isMinute(draft.co2End) && draft.co2Start >= draft.co2End) add("co2End", `CO2 must start before it stops (it starts at ${clock(draft.co2Start)} and stops at ${clock(draft.co2End)}).`);
  }
  if (!isCount(draft.reviewEveryDays, DAYS_MAX)) add("reviewEveryDays", `The reminder interval runs from 0 to ${DAYS_MAX} days.`);
  if (!isCount(draft.maxDays, DAYS_MAX)) add("maxDays", `The limit runs from 0 to ${DAYS_MAX} days.`);
  return issues;
}

/** Things worth knowing that do not stop a save. */
export function draftCautions(draft: ProgramDraft, automation: Pick<AutomationPrograms, "co2FixedStop">): string[] {
  const cautions: string[] = [];
  const stop = automation.co2FixedStop;
  if (draft.co2Enabled && stop !== null && isMinute(draft.co2End) && draft.co2End > stop) {
    cautions.push(`The automation stops CO2 at ${clock(stop)} whatever a program says, so CO2 will not run until ${clock(draft.co2End)}.`);
  }
  return cautions;
}

// ---- writing one program back ----

/** The whole automation configuration with ONE program changed to the draft: nothing else is
 * touched (other programs, triggers, actions, other variables), keys keep their order, and a
 * value the card does not edit inside the program (its `light_check`, the channels the light does
 * not have, anything added later) stays as it was. Programs are never added or removed here.
 * Throws when the program does not exist or cannot be edited. */
export function patchProgram(config: JsonObject, name: string, draft: ProgramDraft): JsonObject {
  const next = structuredClone(config);
  const variables = next.variables;
  const programs = isJsonObject(variables) ? variables.programs : undefined;
  const program = isJsonObject(programs) && Object.hasOwn(programs, name) ? programs[name] : undefined;
  if (!isJsonObject(program) || !isJsonObject(program.schedule)) throw new Error(`The automation has no program called ${name} that can be changed.`);
  const schedule = program.schedule;

  program.summary = draft.summary.trim();
  program.co2_enabled = draft.co2Enabled;
  program.co2_start = formatTime(draft.co2Start);
  program.co2_end = formatTime(draft.co2End);
  program.review_every_days = draft.reviewEveryDays;
  program.max_days = draft.maxDays;

  schedule.sunrise = formatTime(draft.sunrise);
  schedule.sunrise_ramp = draft.sunriseRamp;
  schedule.sunset = formatTime(draft.sunset);
  schedule.sunset_ramp = draft.sunsetRamp;
  if (draft.sleepOn) schedule.sleep = formatTime(draft.sleep);
  else if (Object.hasOwn(schedule, "sleep")) schedule.sleep = null;

  for (const [part, levels] of [["day", draft.day], ["night", draft.night]] as const) {
    const stored = schedule[part];
    if (!isJsonObject(stored)) throw new Error(`The ${part} levels of ${name} are missing.`);
    levels.forEach((level, index) => {
      const key = STORED_CHANNEL_KEYS[index];
      if (key) stored[key] = level;
    });
  }
  return next;
}

// ---- the curve ----

/** The stored schedule as the Automatic schedule the light will run (`channelCount` channels). */
export function storedAutoSchedule(schedule: StoredSchedule, channelCount: number): AutoSchedule {
  return {
    sunrise: formatTime(schedule.sunrise),
    sunriseRamp: schedule.sunriseRamp,
    sunset: formatTime(schedule.sunset),
    sunsetRamp: schedule.sunsetRamp,
    sleep: schedule.sleep === null ? null : formatTime(schedule.sleep),
    dayLevels: schedule.day.slice(0, channelCount),
    nightLevels: schedule.night.slice(0, channelCount),
  };
}

/** The 24 h curve of a stored program. */
export function programPoints(program: LightingProgram, channelCount: number): SchedulePoint[] {
  return autoSchedulePoints(storedAutoSchedule(program.schedule, channelCount), channelCount);
}

/** The 24 h curve of a draft as it stands; null while its times or levels cannot be drawn. */
export function draftPoints(draft: ProgramDraft, channelCount: number): SchedulePoint[] | null {
  if (!isMinute(draft.sunrise) || !isMinute(draft.sunset) || (draft.sleepOn && !isMinute(draft.sleep))) return null;
  if (draft.day.length < channelCount || draft.night.length < channelCount) return null;
  const auto: AutoSchedule = {
    sunrise: formatTime(draft.sunrise),
    sunriseRamp: draft.sunriseRamp,
    sunset: formatTime(draft.sunset),
    sunsetRamp: draft.sunsetRamp,
    sleep: draft.sleepOn ? formatTime(draft.sleep) : null,
    dayLevels: draft.day,
    nightLevels: draft.night,
  };
  try {
    return autoSchedulePoints(auto, channelCount);
  } catch {
    return null;
  }
}

/** "CO2 07:30–14:00", or "CO2 off" for a program that does not run it. */
export function co2Label(program: Pick<LightingProgram, "co2Enabled" | "co2Start" | "co2End">): string {
  return program.co2Enabled ? `CO2 ${formatTime(program.co2Start)}–${formatTime(program.co2End)}` : "CO2 off";
}

// ---- the running program ----

export interface ProgramState {
  /** The programs the helper offers, in its order. */
  options: string[];
  /** The running program; null while the helper is unavailable or reports nothing useful. */
  active: string | null;
  /** Home Assistant has no state for the helper at all. */
  missing: boolean;
  unavailable: boolean;
  /** When the running program began (ms since the epoch); null when unknown. */
  startedMs: number | null;
  reapply: "ready" | "unavailable" | "missing" | "none";
}

const UNUSABLE = new Set(["unknown", "unavailable", ""]);

/** When a date-time helper says it was set. Its `timestamp` attribute is the exact instant for a
 * helper that holds a date and a time; otherwise the printed state is read in Home Assistant's
 * zone. A time-only helper says nothing about which day, so it gives null. */
export function startedFromState(state: HassEntityState | undefined, timeZone?: string): number | null {
  if (!state || UNUSABLE.has(state.state)) return null;
  const { has_date: hasDate, has_time: hasTime, timestamp } = state.attributes;
  if (hasDate === false) return null;
  if (hasTime !== false && typeof timestamp === "number" && timestamp > 946_684_800) return timestamp * 1000;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(state.state);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return zonedTimeToEpochMs({ year: Number(year), month: Number(month), day: Number(day), hour: Number(hour ?? 0), minute: Number(minute ?? 0), second: Number(second ?? 0) }, timeZone);
}

export function readProgramState(states: Readonly<Record<string, HassEntityState | undefined>>, config: ProgramConfig, timeZone?: string): ProgramState {
  const select = states[config.select];
  const options = Array.isArray(select?.attributes.options) ? select.attributes.options.filter((option): option is string => typeof option === "string") : [];
  const unavailable = select?.state === "unavailable";
  const active = select && !UNUSABLE.has(select.state) ? select.state : null;
  let reapply: ProgramState["reapply"] = "none";
  if (config.reapply) {
    const button = states[config.reapply];
    reapply = !button ? "missing" : button.state === "unavailable" ? "unavailable" : "ready";
  }
  return {
    options,
    active,
    missing: select === undefined,
    unavailable,
    startedMs: config.started ? startedFromState(states[config.started], timeZone) : null,
    reapply,
  };
}

/** "Running 5 days" / "Started 3 h ago". Under a day it counts hours, because the automation
 * counts whole days and a fresh program is on day 0. */
export function describeRunning(startedMs: number | null, nowMs: number): string | null {
  if (startedMs === null) return null;
  const elapsed = nowMs - startedMs;
  if (elapsed < -300_000) return null; // a start in the future: the clocks disagree, say nothing
  const minutes = Math.floor(Math.max(0, elapsed) / 60_000);
  if (minutes < 1) return "Just started";
  if (minutes < 60) return `Started ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Started ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Running ${days} ${days === 1 ? "day" : "days"}`;
}

/** "Ends in 62 h" for a program with a time limit. The automation checks on the hour, so once the
 * limit has passed it ends within the hour. */
export function describeEnds(startedMs: number | null, maxDays: number, nowMs: number): string | null {
  if (startedMs === null || !(maxDays > 0)) return null;
  const remaining = startedMs + maxDays * DAY_MS - nowMs;
  if (remaining <= 0) return "Ends within the hour";
  if (remaining < HOUR_MS) return "Ends in under an hour";
  const hours = Math.ceil(remaining / HOUR_MS);
  if (hours < 96) return `Ends in ${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours - days * 24;
  return rest > 0 ? `Ends in ${days} days ${rest} h` : `Ends in ${days} days`;
}

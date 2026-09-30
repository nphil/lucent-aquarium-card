import { test } from "node:test";
import assert from "node:assert/strict";
import {
  co2Label,
  defaultSleep,
  describeEnds,
  describeRunning,
  draftCautions,
  draftFromProgram,
  draftPoints,
  draftsEqual,
  patchProgram,
  programPoints,
  readAutomationPrograms,
  readProgramState,
  startedFromState,
  validateDraft,
  type AutomationPrograms,
  type LightingProgram,
  type ProgramDraft,
} from "../src/adapters/fluval-programs.ts";
import { valueAt } from "../src/lib/curve.ts";
import { sameJson, type JsonObject } from "../src/lib/json.ts";
import type { HassEntityState } from "../src/types.ts";
import { liveConfig } from "../dev/program-fixture.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function program(parsed: AutomationPrograms, name: string): LightingProgram {
  const entry = parsed.entries.get(name);
  assert.ok(entry?.ok, `${name} should be readable`);
  return entry.program;
}

const live = (): AutomationPrograms => readAutomationPrograms(liveConfig());
const draftOf = (name: string, channels = 4): ProgramDraft => draftFromProgram(program(live(), name), channels);

/** The live config with `mutate` applied to the named program. */
function withProgram(name: string, mutate: (raw: JsonObject, schedule: JsonObject) => void): JsonObject {
  const config = liveConfig();
  const raw = (config.variables as JsonObject).programs as JsonObject;
  const stored = raw[name] as JsonObject;
  mutate(stored, stored.schedule as JsonObject);
  return config;
}

const reasonOf = (config: JsonObject, name: string): string | null => {
  const entry = readAutomationPrograms(config).entries.get(name);
  return entry && !entry.ok ? entry.reason : null;
};

// ---- reading the automation ----

test("the three real programs are read with their light schedule, CO2 window and limits", () => {
  const parsed = live();
  assert.equal(parsed.id, "plant_room_aquarium_co2_lights");
  assert.deepEqual([...parsed.entries.keys()], ["Normal", "Algae Reset", "Blackout"]);

  const normal = program(parsed, "Normal");
  assert.deepEqual([normal.co2Enabled, normal.co2Start, normal.co2End, normal.reviewEveryDays, normal.maxDays], [true, 8 * 60, 14 * 60, 0, 0]);
  assert.equal(normal.lightCheck, 9 * 60 + 15, "the lamp must be proven on from 09:15");
  assert.deepEqual(normal.schedule, { sunrise: 510, sunriseRamp: 30, sunset: 930, sunsetRamp: 30, sleep: 1320, day: [68, 100, 100, 90, 0], night: [0, 0, 5, 0, 0] });

  const algae = program(parsed, "Algae Reset");
  assert.deepEqual([algae.co2Start, algae.reviewEveryDays, algae.schedule.day], [7 * 60 + 30, 7, [40, 60, 60, 54, 0]]);

  const blackout = program(parsed, "Blackout");
  assert.deepEqual([blackout.co2Enabled, blackout.maxDays, blackout.schedule.day], [false, 3, [0, 0, 0, 0, 0]]);
});

test("the fixed CO2 stop comes from the automation's own co2_window_end trigger, not from the starts", () => {
  assert.equal(live().co2FixedStop, 14 * 60);
  const config = liveConfig();
  (config.triggers as JsonObject[]).push({ trigger: "time", at: "15:30:00", id: "co2_window_end" });
  assert.equal(readAutomationPrograms(config).co2FixedStop, 15 * 60 + 30, "the latest one wins");
  const bare = liveConfig();
  bare.triggers = [{ trigger: "time", at: "07:30:00", id: "co2_window_start" }];
  assert.equal(readAutomationPrograms(bare).co2FixedStop, null);
  delete bare.triggers;
  assert.equal(readAutomationPrograms(bare).co2FixedStop, null);
});

test("an automation the card cannot save to, or that has no programs, is refused with the reason", () => {
  assert.throws(() => readAutomationPrograms(null), /didn't return a configuration/);
  const noId = liveConfig();
  delete noId.id;
  assert.throws(() => readAutomationPrograms(noId), /no id/);
  const noPrograms = liveConfig();
  noPrograms.variables = { other: 1 };
  assert.throws(() => readAutomationPrograms(noPrograms), /no programs/);
});

test("a program the card cannot use stays in the list with the reason instead of vanishing", () => {
  const missingChannel = withProgram("Normal", (_, schedule) => delete (schedule.night as JsonObject).channel_5);
  assert.match(reasonOf(missingChannel, "Normal") ?? "", /night\.channel_5/);
  assert.match(reasonOf(withProgram("Normal", (_, s) => (s.sunrise_ramp = 30.5)), "Normal") ?? "", /sunrise ramp/);
  assert.match(reasonOf(withProgram("Normal", (_, s) => (s.sunset_ramp = 241)), "Normal") ?? "", /sunset ramp/);
  assert.match(reasonOf(withProgram("Normal", (_, s) => (s.sunrise = "8:30")), "Normal") ?? "", /sunrise/, "the light wants two digits");
  assert.match(reasonOf(withProgram("Normal", (_, s) => (s.sleep = "late")), "Normal") ?? "", /sleep/);
  assert.match(reasonOf(withProgram("Normal", (raw) => delete raw.co2_start), "Normal") ?? "", /CO2 window/);
  assert.match(reasonOf(withProgram("Normal", (raw) => (raw.max_days = -1)), "Normal") ?? "", /max_days/);
  assert.match(reasonOf(withProgram("Normal", (raw) => (raw.co2_enabled = "yes")), "Normal") ?? "", /co2_enabled/);
  assert.match(reasonOf(withProgram("Normal", (raw) => delete raw.schedule), "Normal") ?? "", /light schedule/);
  const notAnObject = liveConfig();
  (((notAnObject.variables as JsonObject).programs) as JsonObject).Normal = "oops";
  assert.match(reasonOf(notAnObject, "Normal") ?? "", /no settings/);
  // The others are still fine.
  assert.ok(readAutomationPrograms(missingChannel).entries.get("Blackout")?.ok);
});

test("missing optional values fall back: no sleep time, no summary, a disabled CO2 window without times", () => {
  const noSleep = withProgram("Normal", (_, schedule) => delete schedule.sleep);
  assert.equal(program(readAutomationPrograms(noSleep), "Normal").schedule.sleep, null);
  const nullSleep = withProgram("Normal", (_, schedule) => (schedule.sleep = null));
  assert.equal(program(readAutomationPrograms(nullSleep), "Normal").schedule.sleep, null);
  const emptySleep = withProgram("Normal", (_, schedule) => (schedule.sleep = ""));
  assert.equal(program(readAutomationPrograms(emptySleep), "Normal").schedule.sleep, null);

  const bare = withProgram("Blackout", (raw) => {
    delete raw.summary;
    delete raw.co2_start;
    delete raw.co2_end;
    delete raw.max_days;
    delete raw.review_every_days;
  });
  const blackout = program(readAutomationPrograms(bare), "Blackout");
  assert.deepEqual([blackout.summary, blackout.co2Start, blackout.co2End, blackout.maxDays, blackout.reviewEveryDays], ["", 0, 0, 0, 0]);
  const unchecked = withProgram("Normal", (raw) => delete raw.light_check);
  assert.equal(program(readAutomationPrograms(unchecked), "Normal").lightCheck, null, "no light check named: the lamp is not required");
});

// ---- the draft and its rules ----

test("a draft holds only the channels the light has, and remembers nothing it cannot show", () => {
  const four = draftOf("Algae Reset", 4);
  assert.deepEqual([four.day, four.night], [[40, 60, 60, 54], [0, 0, 5, 0]]);
  assert.equal(draftOf("Algae Reset", 5).day.length, 5);
  assert.deepEqual([four.sunrise, four.sunset, four.sleepOn, four.sleep, four.co2Start, four.co2End], [510, 930, true, 1320, 450, 840]);
  assert.ok(draftsEqual(four, draftOf("Algae Reset", 4)));
  assert.ok(!draftsEqual(four, { ...four, day: [41, 60, 60, 54] }));
  assert.ok(!draftsEqual(four, { ...four, summary: "x" }));
});

test("with no sleep time the draft offers one after sunset, and ignores it while sleep is off", () => {
  assert.equal(defaultSleep(15 * 60 + 30), 22 * 60);
  assert.equal(defaultSleep(22 * 60), 23 * 60);
  assert.equal(defaultSleep(23 * 60 + 30), 23 * 60 + 59, "never past the end of the day");
  const off = draftFromProgram(program(readAutomationPrograms(withProgram("Normal", (_, s) => delete s.sleep)), "Normal"), 4);
  assert.deepEqual([off.sleepOn, off.sleep], [false, 22 * 60]);
  assert.ok(draftsEqual(off, { ...off, sleep: 5 }), "a hidden sleep time is not a change");
});

test("every program as stored passes the rules", () => {
  for (const name of ["Normal", "Algae Reset", "Blackout"]) assert.deepEqual(validateDraft(draftOf(name, 5)), [], name);
});

test("levels run from 0 to 100 and ramps from 0 to 240", () => {
  const draft = draftOf("Normal");
  assert.deepEqual(validateDraft({ ...draft, day: [101, 0, 0, 0] }).map((issue) => issue.field), ["day"]);
  assert.deepEqual(validateDraft({ ...draft, night: [0, -1, 0, 0] }).map((issue) => issue.field), ["night"]);
  assert.deepEqual(validateDraft({ ...draft, night: [0, 0.5, 0, 0] }).map((issue) => issue.field), ["night"]);
  assert.deepEqual(validateDraft({ ...draft, day: [0, 0, 0, 100], night: [100, 0, 0, 0] }), []);
  assert.deepEqual(validateDraft({ ...draft, sunriseRamp: 241 }).map((issue) => issue.field), ["sunriseRamp"]);
  assert.deepEqual(validateDraft({ ...draft, sunsetRamp: -1 }).map((issue) => issue.field), ["sunsetRamp"]);
  assert.deepEqual(validateDraft({ ...draft, sunsetRamp: 12.5 }).map((issue) => issue.field), ["sunsetRamp"]);
  assert.deepEqual(validateDraft({ ...draft, sunriseRamp: 0, sunsetRamp: 240 }), []);
});

test("the sunrise ramp must be over before the sunset ramp starts", () => {
  const draft = draftOf("Normal"); // sunrise 08:30, sunset 15:30, ramps 30
  const tight = { ...draft, sunrise: 8 * 60, sunriseRamp: 60, sunset: 10 * 60, sunsetRamp: 60 }; // both at 09:00
  const issues = validateDraft(tight);
  assert.deepEqual(issues.map((issue) => issue.field), ["sunset"]);
  assert.match(issues[0]!.message, /09:00/, "names the times that collide");
  assert.deepEqual(validateDraft({ ...tight, sunset: 10 * 60 + 1 }), [], "a minute of full light is enough");
  assert.deepEqual(validateDraft({ ...draft, sunriseRamp: 240, sunsetRamp: 240 }).map((issue) => issue.field), ["sunset"], "08:30 + 4 h is 12:30, but 15:30 - 4 h is 11:30");
});

test("times must be real times of the day", () => {
  const draft = draftOf("Normal");
  assert.deepEqual(validateDraft({ ...draft, sunrise: 1440 }).map((issue) => issue.field), ["sunrise"]);
  assert.deepEqual(validateDraft({ ...draft, sunset: -1 }).map((issue) => issue.field), ["sunset"]);
  assert.deepEqual(validateDraft({ ...draft, sunrise: 500.5 }).map((issue) => issue.field), ["sunrise"]);
});

test("sleep has to fall outside the lit day, and only matters while it is on", () => {
  const draft = draftOf("Normal"); // sunrise 08:30, sunset 15:30
  assert.deepEqual(validateDraft({ ...draft, sleep: 12 * 60 }).map((issue) => issue.field), ["sleep"]);
  assert.deepEqual(validateDraft({ ...draft, sleep: 8 * 60 + 30 }).map((issue) => issue.field), ["sleep"], "off exactly at sunrise is nonsense too");
  assert.deepEqual(validateDraft({ ...draft, sleep: 15 * 60 + 30 }), [], "at sunset is fine");
  assert.deepEqual(validateDraft({ ...draft, sleep: 30 }), [], "half past midnight counts as after sunset");
  assert.deepEqual(validateDraft({ ...draft, sleepOn: false, sleep: 12 * 60 }), []);
  assert.deepEqual(validateDraft({ ...draft, sleep: 1440 }).map((issue) => issue.field), ["sleep"]);
});

test("CO2 must start before it stops, but only when it is on", () => {
  const draft = draftOf("Normal");
  const equal = validateDraft({ ...draft, co2Start: 8 * 60, co2End: 8 * 60 });
  assert.deepEqual(equal.map((issue) => issue.field), ["co2End"]);
  assert.match(equal[0]!.message, /08:00/);
  assert.deepEqual(validateDraft({ ...draft, co2Start: 15 * 60, co2End: 14 * 60 }).map((issue) => issue.field), ["co2End"]);
  assert.deepEqual(validateDraft({ ...draft, co2Enabled: false, co2Start: 15 * 60, co2End: 14 * 60 }), []);
  assert.deepEqual(validateDraft({ ...draft, co2Start: -5 }).map((issue) => issue.field), ["co2Start"]);
});

test("the day counts are whole numbers up to a year", () => {
  const draft = draftOf("Normal");
  assert.deepEqual(validateDraft({ ...draft, maxDays: -1 }).map((issue) => issue.field), ["maxDays"]);
  assert.deepEqual(validateDraft({ ...draft, reviewEveryDays: 366 }).map((issue) => issue.field), ["reviewEveryDays"]);
  assert.deepEqual(validateDraft({ ...draft, reviewEveryDays: 1.5 }).map((issue) => issue.field), ["reviewEveryDays"]);
  assert.deepEqual(validateDraft({ ...draft, maxDays: 365, reviewEveryDays: 0 }), []);
});

test("a CO2 end after the automation's fixed stop is a caution, not a block", () => {
  const draft = draftOf("Normal");
  const later = { ...draft, co2End: 15 * 60 };
  assert.deepEqual(validateDraft(later), []);
  const [caution] = draftCautions(later, { co2FixedStop: 14 * 60 });
  assert.match(caution ?? "", /14:00/);
  assert.match(caution ?? "", /15:00/);
  assert.deepEqual(draftCautions(draft, { co2FixedStop: 14 * 60 }), [], "ending at the stop is fine");
  assert.deepEqual(draftCautions({ ...later, co2Enabled: false }, { co2FixedStop: 14 * 60 }), []);
  assert.deepEqual(draftCautions(later, { co2FixedStop: null }), []);
});

// ---- writing one program back ----

const keysOf = (value: unknown): string[] => Object.keys(value as object);

test("saving changes one program and leaves the rest of the automation exactly as it was", () => {
  const config = liveConfig();
  const before = structuredClone(config);
  const draft = draftOf("Algae Reset");
  draft.day = [50, 61, 60, 54];
  draft.sunset = 16 * 60;
  draft.co2Start = 7 * 60;
  draft.summary = "  a new summary \n";
  draft.maxDays = 14;

  const next = patchProgram(config, "Algae Reset", draft);
  assert.deepEqual(config, before, "the configuration that was read is not modified");

  const without = (value: JsonObject): string => {
    const copy = structuredClone(value);
    delete ((copy.variables as JsonObject).programs as JsonObject)["Algae Reset"];
    return JSON.stringify(copy);
  };
  assert.equal(without(next), without(before), "everything else, key order included, is untouched");
  assert.deepEqual(keysOf((next.variables as JsonObject).programs), ["Normal", "Algae Reset", "Blackout"]);

  const edited = ((next.variables as JsonObject).programs as JsonObject)["Algae Reset"] as JsonObject;
  assert.deepEqual(edited, {
    co2_enabled: true,
    co2_start: "07:00",
    co2_end: "14:00",
    light_check: "09:15",
    review_every_days: 7,
    max_days: 14,
    schedule: {
      sunrise: "08:30",
      sunrise_ramp: 30,
      sunset: "16:00",
      sunset_ramp: 30,
      sleep: "22:00",
      day: { channel_1: 50, channel_2: 61, channel_3: 60, channel_4: 54, channel_5: 0 },
      night: { channel_1: 0, channel_2: 0, channel_3: 5, channel_4: 0, channel_5: 0 },
    },
    summary: "a new summary",
  });
  const original = ((before.variables as JsonObject).programs as JsonObject)["Algae Reset"] as JsonObject;
  assert.deepEqual(keysOf(edited), keysOf(original), "the program keeps its key order");
  assert.deepEqual(keysOf(edited.schedule), keysOf(original.schedule));
});

test("channel 5 keeps its stored value on a four-channel light, and is edited on a five-channel one", () => {
  const config = withProgram("Normal", (_, schedule) => {
    (schedule.day as JsonObject).channel_5 = 17;
    (schedule.night as JsonObject).channel_5 = 3;
  });
  const four = draftFromProgram(program(readAutomationPrograms(config), "Normal"), 4);
  four.day = [1, 2, 3, 4];
  const nextFour = patchProgram(config, "Normal", four);
  const scheduleFour = (((nextFour.variables as JsonObject).programs as JsonObject).Normal as JsonObject).schedule as JsonObject;
  assert.deepEqual(scheduleFour.day, { channel_1: 1, channel_2: 2, channel_3: 3, channel_4: 4, channel_5: 17 });
  assert.deepEqual((scheduleFour.night as JsonObject).channel_5, 3);

  const five = draftFromProgram(program(readAutomationPrograms(config), "Normal"), 5);
  five.day = [1, 2, 3, 4, 5];
  const nextFive = patchProgram(config, "Normal", five);
  const scheduleFive = (((nextFive.variables as JsonObject).programs as JsonObject).Normal as JsonObject).schedule as JsonObject;
  assert.deepEqual((scheduleFive.day as JsonObject).channel_5, 5);
});

test("turning sleep off clears it, and a program that never had one does not gain one", () => {
  const draft = draftOf("Normal");
  const off = patchProgram(liveConfig(), "Normal", { ...draft, sleepOn: false });
  const schedule = (((off.variables as JsonObject).programs as JsonObject).Normal as JsonObject).schedule as JsonObject;
  assert.equal(schedule.sleep, null, "the light reads null as no sleep time");
  assert.deepEqual(keysOf(schedule), ["sunrise", "sunrise_ramp", "sunset", "sunset_ramp", "sleep", "day", "night"]);

  const bare = withProgram("Normal", (_, s) => delete s.sleep);
  const bareDraft = draftFromProgram(program(readAutomationPrograms(bare), "Normal"), 4);
  const stays = patchProgram(bare, "Normal", bareDraft);
  assert.ok(!Object.hasOwn((((stays.variables as JsonObject).programs as JsonObject).Normal as JsonObject).schedule as JsonObject, "sleep"));
  const gains = patchProgram(bare, "Normal", { ...bareDraft, sleepOn: true, sleep: 21 * 60 });
  assert.equal(((((gains.variables as JsonObject).programs as JsonObject).Normal as JsonObject).schedule as JsonObject).sleep, "21:00");
});

test("values the card does not edit inside the program are kept where they were", () => {
  const config = withProgram("Blackout", (raw, schedule) => {
    raw.notes = "keep me";
    schedule.mystery = 7;
  });
  const draft = draftFromProgram(program(readAutomationPrograms(config), "Blackout"), 4);
  const next = patchProgram(config, "Blackout", { ...draft, maxDays: 2 });
  const edited = ((next.variables as JsonObject).programs as JsonObject).Blackout as JsonObject;
  assert.equal(edited.notes, "keep me");
  assert.equal((edited.schedule as JsonObject).mystery, 7);
  assert.equal(edited.light_check, "09:15");
  assert.equal(edited.max_days, 2);
  assert.deepEqual(keysOf(edited), ["co2_enabled", "co2_start", "co2_end", "light_check", "review_every_days", "max_days", "schedule", "summary", "notes"]);
});

test("a program that does not exist is never created", () => {
  assert.throws(() => patchProgram(liveConfig(), "Vacation", draftOf("Normal")), /Vacation/);
  const broken = withProgram("Normal", (raw) => delete raw.schedule);
  assert.throws(() => patchProgram(broken, "Normal", draftOf("Blackout")), /Normal/);
});

test("comparing two versions of a configuration ignores key order but not values or list order", () => {
  assert.ok(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
  assert.ok(!sameJson({ a: 1 }, { a: 1, b: undefined as never }), "an extra key is a difference");
  assert.ok(!sameJson({ a: [1, 2] }, { a: [2, 1] }));
  assert.ok(!sameJson({ a: null }, { a: 0 }));
  assert.ok(!sameJson([1], { 0: 1 }));
  assert.ok(sameJson(liveConfig(), liveConfig()));
});

// ---- the curve ----

test("the curve of a program is what the light will run, and a draft's curve follows the draft", () => {
  const normal = program(live(), "Normal");
  const points = programPoints(normal, 4);
  assert.equal(valueAt(points, 3 * 60, 0), 0, "off before sunrise");
  assert.equal(valueAt(points, 12 * 60, 0), 68, "full day level at noon");
  assert.equal(valueAt(points, 12 * 60, 3), 90);
  assert.equal(valueAt(points, 20 * 60, 2), 5, "night level after sunset until sleep");
  assert.equal(valueAt(points, 23 * 60, 2), 0, "off after sleep");

  const draft = draftOf("Normal");
  assert.deepEqual(draftPoints(draft, 4), points);
  const dimmer = draftPoints({ ...draft, day: [10, 100, 100, 90] }, 4);
  assert.equal(valueAt(dimmer!, 12 * 60, 0), 10);
  const noSleep = draftPoints({ ...draft, sleepOn: false }, 4)!;
  assert.equal(valueAt(noSleep, 23 * 60, 2), 5, "without sleep the night level holds until sunrise");
});

test("a draft that cannot be drawn gives no curve instead of a wrong one", () => {
  const draft = draftOf("Normal");
  assert.equal(draftPoints({ ...draft, sunrise: Number.NaN }, 4), null);
  assert.equal(draftPoints({ ...draft, sunset: 1440 }, 4), null);
  assert.equal(draftPoints({ ...draft, sleep: -3 }, 4), null);
  assert.equal(draftPoints({ ...draft, day: [1, 2, 3] }, 4), null, "a level is missing");
  assert.notEqual(draftPoints({ ...draft, sleepOn: false, sleep: -3 }, 4), null, "a hidden sleep time is ignored");
});

test("the CO2 chip names the window, or says CO2 is off", () => {
  assert.equal(co2Label(program(live(), "Algae Reset")), "CO2 07:30–14:00");
  assert.equal(co2Label(program(live(), "Blackout")), "CO2 off");
});

// ---- how long it has been running ----

test("running time counts hours on the first day and whole days after", () => {
  const start = Date.UTC(2026, 8, 20, 8, 0, 0);
  const at = (ms: number): string | null => describeRunning(start, start + ms);
  assert.equal(at(30_000), "Just started");
  assert.equal(at(25 * 60_000), "Started 25 min ago");
  assert.equal(at(3 * HOUR), "Started 3 h ago");
  assert.equal(at(24 * HOUR - 1), "Started 23 h ago");
  assert.equal(at(24 * HOUR), "Running 1 day");
  assert.equal(at(5 * DAY + 10 * HOUR), "Running 5 days");
  assert.equal(describeRunning(null, start), null);
  assert.equal(describeRunning(start, start - 60_000), "Just started", "a clock a minute off is not worth a mention");
  assert.equal(describeRunning(start, start - 20 * 60_000), null, "a start well in the future is not believable");
});

test("a time-limited program says how long is left, in hours until it is long", () => {
  const start = Date.UTC(2026, 8, 20, 8, 0, 0);
  const ends = (maxDays: number, elapsed: number): string | null => describeEnds(start, maxDays, start + elapsed);
  assert.equal(ends(0, HOUR), null, "no limit");
  assert.equal(describeEnds(null, 3, start), null, "unknown start");
  assert.equal(ends(3, 10 * HOUR), "Ends in 62 h");
  assert.equal(ends(3, 72 * HOUR - 30 * 60_000), "Ends in under an hour");
  assert.equal(ends(3, 72 * HOUR - 61 * 60_000), "Ends in 2 h", "rounded up, never promising less than there is");
  assert.equal(ends(3, 72 * HOUR), "Ends within the hour");
  assert.equal(ends(3, 80 * HOUR), "Ends within the hour", "it is checked on the hour, so it is late, not lost");
  assert.equal(ends(14, 24 * HOUR), "Ends in 13 days");
  assert.equal(ends(14, 19 * HOUR), "Ends in 13 days 5 h");
  assert.equal(ends(4, 1 * HOUR), "Ends in 95 h");
  assert.equal(ends(4, 0), "Ends in 4 days");
});

// ---- the helpers' states ----

const state = (entity_id: string, value: string, attributes: Record<string, unknown> = {}): HassEntityState => ({ entity_id, state: value, attributes, last_changed: "", last_updated: "" });

test("the start time is the helper's exact timestamp when it has date and time", () => {
  const stamp = Date.UTC(2026, 8, 27, 7, 30, 0) / 1000;
  assert.equal(startedFromState(state("input_datetime.p", "2026-09-27 08:30:00", { has_date: true, has_time: true, timestamp: stamp }), "Europe/London"), stamp * 1000);
});

test("without a usable timestamp the printed start is read in Home Assistant's zone", () => {
  const printed = state("input_datetime.p", "2026-09-27 08:30:00", { has_date: true, has_time: true });
  assert.equal(startedFromState(printed, "Europe/London"), Date.UTC(2026, 8, 27, 7, 30), "British summer time is one hour ahead");
  assert.equal(startedFromState(printed, "America/New_York"), Date.UTC(2026, 8, 27, 12, 30));
  assert.equal(startedFromState(printed, "UTC"), Date.UTC(2026, 8, 27, 8, 30));
  assert.equal(startedFromState(state("input_datetime.p", "2026-01-15 08:30:00"), "America/New_York"), Date.UTC(2026, 0, 15, 13, 30), "winter time");
  assert.equal(startedFromState(state("input_datetime.p", "2026-03-08 03:30:00"), "America/New_York"), Date.UTC(2026, 2, 8, 7, 30), "just after the clocks went forward");
  assert.equal(startedFromState(state("input_datetime.p", "2026-09-27T08:30:15+00:00"), "UTC"), Date.UTC(2026, 8, 27, 8, 30, 15), "a T separator works too");
});

test("a date-only helper starts at midnight; a time-only or unknown one says nothing", () => {
  assert.equal(startedFromState(state("input_datetime.p", "2026-09-27", { has_date: true, has_time: false, timestamp: 1 }), "Europe/London"), Date.UTC(2026, 8, 26, 23, 0));
  assert.equal(startedFromState(state("input_datetime.p", "08:30:00", { has_date: false, has_time: true, timestamp: 30600 }), "UTC"), null);
  assert.equal(startedFromState(state("input_datetime.p", "unknown"), "UTC"), null);
  assert.equal(startedFromState(state("input_datetime.p", "unavailable"), "UTC"), null);
  assert.equal(startedFromState(state("input_datetime.p", "yesterday"), "UTC"), null);
  assert.equal(startedFromState(undefined, "UTC"), null);
});

test("the helper's options, the running program and the re-apply button are read from the states", () => {
  const config = { select: "input_select.p", automation: "automation.a", started: "input_datetime.s", reapply: "input_button.r" };
  const states = {
    "input_select.p": state("input_select.p", "Algae Reset", { options: ["Normal", "Algae Reset", "Blackout", 7] }),
    "input_datetime.s": state("input_datetime.s", "2026-09-27 08:30:00", { has_date: true, has_time: true }),
    "input_button.r": state("input_button.r", "2026-09-01T10:00:00+00:00"),
  };
  const read = readProgramState(states, config, "UTC");
  assert.deepEqual([read.options, read.active, read.missing, read.unavailable, read.reapply], [["Normal", "Algae Reset", "Blackout"], "Algae Reset", false, false, "ready"]);
  assert.equal(read.startedMs, Date.UTC(2026, 8, 27, 8, 30));

  const down = readProgramState({ ...states, "input_select.p": state("input_select.p", "unavailable", { options: ["Normal"] }), "input_button.r": state("input_button.r", "unavailable") }, config);
  assert.deepEqual([down.active, down.unavailable, down.reapply], [null, true, "unavailable"]);

  const absent = readProgramState({}, config);
  assert.deepEqual([absent.options, absent.active, absent.missing, absent.startedMs, absent.reapply], [[], null, true, null, "missing"]);

  const minimal = readProgramState(states, { select: "input_select.p", automation: "automation.a" });
  assert.deepEqual([minimal.startedMs, minimal.reapply], [null, "none"]);
  assert.equal(readProgramState({ "input_select.p": state("input_select.p", "unknown") }, config).active, null);
});

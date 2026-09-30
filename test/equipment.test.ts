import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAMP_WATTS,
  RUNNING_WATTS,
  bandTrack,
  batteryTone,
  co2Note,
  describeAge,
  describeVerdict,
  downsample,
  formatWatts,
  judgeTemperature,
  normaliseRole,
  offCost,
  outletStatus,
  parseHistory,
  readBand,
  readBattery,
  readTemperature,
  readWatts,
  shortNames,
  sparkline,
  totalWatts,
  wattsToShow,
  type Co2Window,
  type HistoryPoint,
} from "../src/lib/equipment.ts";
import type { HassEntityState, OutletRole } from "../src/types.ts";

const state = (entity_id: string, value: string, attributes: Record<string, unknown> = {}, last_updated = ""): HassEntityState => ({ entity_id, state: value, attributes, last_changed: last_updated, last_updated });

const status = (role: OutletRole, on: string | undefined, watts: number | null, critical = false) => outletStatus({ role, critical, state: on, watts });

// ---- what an outlet is doing ----

test("a filter drawing 6.8 W is running; one that is on but draws nothing is flagged", () => {
  assert.deepEqual(status("filter", "on", 6.8, true), { label: "Running", tone: "positive" });
  const stalled = status("filter", "on", 0, true);
  assert.equal(stalled.label, "On, no draw");
  assert.equal(stalled.tone, "warning");
});

test("a heater cycling on its thermostat is idle at 0.8 W and heating when it draws power", () => {
  assert.deepEqual(status("heater", "on", 0.8, true), { label: "Idle", tone: "neutral", detail: "On, waiting for the water to cool." });
  assert.deepEqual(status("heater", "on", 96, true), { label: "Heating", tone: "positive" });
});

test("the UV lamp that is on but draws no power is reported honestly, not as running", () => {
  const uv = status("uv", "on", 0);
  assert.deepEqual([uv.label, uv.tone, uv.detail], ["On, no draw", "warning", "On, drawing no power."]);
  assert.equal(status("uv", "on", 9.2).label, "Running");
});

test("the CO2 solenoid is running while it draws its 2.9 W", () => {
  assert.equal(status("co2", "on", 2.9).label, "Running");
  assert.equal(status("co2", "on", 0).tone, "warning");
});

test("the light outlet says whether the lamp is on, using the 8 W the automation trusts", () => {
  assert.equal(status("light", "on", 23).label, "Lamp on");
  const dark = status("light", "on", 1.1);
  assert.deepEqual([dark.label, dark.tone], ["Lamp off", "neutral"]);
});

test("a spare outlet with nothing drawing is simply on", () => {
  assert.deepEqual([status("spare", "on", 0).label, status("spare", "on", 0).tone], ["On, no draw", "neutral"]);
});

test("the thresholds are exact: at the limit it is running, just under it is not", () => {
  assert.equal(status("filter", "on", RUNNING_WATTS).label, "Running");
  assert.equal(status("filter", "on", RUNNING_WATTS - 0.01).label, "On, no draw");
  assert.equal(status("light", "on", LAMP_WATTS).label, "Lamp on");
  assert.equal(status("light", "on", LAMP_WATTS - 0.01).label, "Lamp off");
});

test("without a power reading an outlet that is on is just on", () => {
  for (const role of ["filter", "heater", "co2", "uv", "light", "spare"] as const) assert.deepEqual(status(role, "on", null), { label: "On", tone: "neutral" });
});

test("off matters more for the equipment the fish depend on", () => {
  assert.deepEqual(status("filter", "off", null, true), { label: "Off", tone: "warning" });
  assert.deepEqual(status("uv", "off", null), { label: "Off", tone: "neutral" });
});

test("an outlet that is off but still draws power is flagged, and the CO2 solenoid most of all", () => {
  const stuck = status("co2", "off", 2.9);
  assert.deepEqual([stuck.label, stuck.tone, stuck.detail], ["Off, still drawing", "danger", "Switched off, but it is still drawing power."]);
  assert.equal(status("filter", "off", 6.8, true).tone, "danger");
  assert.equal(status("spare", "off", 4).tone, "warning");
  assert.deepEqual(status("co2", "off", 0.2), { label: "Off", tone: "neutral" }, "standby noise is not a fault");
  assert.deepEqual(status("heater", "off", 0, true), { label: "Off", tone: "warning" });
});

test("a tile shows the draw while the outlet is on, and while it is off only a draw that means something", () => {
  assert.equal(wattsToShow(true, 0.8), 0.8, "a heater idling at 0.8 W is on and drawing");
  assert.equal(wattsToShow(true, 0), 0, "an outlet that is on and draws nothing says so");
  assert.equal(wattsToShow(false, 0), null);
  assert.equal(wattsToShow(false, 0.2), null, "standby noise");
  assert.equal(wattsToShow(false, 0.5), 0.5);
  assert.equal(wattsToShow(false, 2.9), 2.9);
  assert.equal(wattsToShow(true, null), null);
});

test("an outlet Home Assistant cannot reach is unavailable, and danger when it is critical", () => {
  for (const missing of ["unavailable", "unknown", undefined, "weird"]) {
    assert.deepEqual([status("filter", missing, 5, true).label, status("filter", missing, 5, true).tone], ["Unavailable", "danger"]);
    assert.deepEqual([status("spare", missing, 5).label, status("spare", missing, 5).tone], ["Unavailable", "warning"]);
  }
});

test("roles from the configuration fall back to a plain outlet", () => {
  assert.equal(normaliseRole("heater"), "heater");
  assert.equal(normaliseRole("toaster"), "spare");
  assert.equal(normaliseRole(undefined), "spare");
});

// ---- power readings ----

test("power sensors read in watts whatever unit they use, and say nothing when they have no reading", () => {
  assert.equal(readWatts(state("sensor.p", "6.8", { unit_of_measurement: "W" })), 6.8);
  assert.equal(readWatts(state("sensor.p", "0.0")), 0);
  assert.equal(readWatts(state("sensor.p", "0.023", { unit_of_measurement: "kW" })), 23);
  assert.equal(readWatts(state("sensor.p", "1500", { unit_of_measurement: "mW" })), 1.5);
  for (const bad of ["unavailable", "unknown", "", "  ", "n/a"]) assert.equal(readWatts(state("sensor.p", bad)), null, bad);
  assert.equal(readWatts(undefined), null);
});

test("watts are shown with a decimal when small and whole when not", () => {
  assert.equal(formatWatts(0), "0.0 W");
  assert.equal(formatWatts(0.8), "0.8 W");
  assert.equal(formatWatts(6.84), "6.8 W");
  assert.equal(formatWatts(23.4), "23 W");
  assert.equal(formatWatts(1500), "1.50 kW");
});

test("the total counts what is known and admits when nothing is", () => {
  assert.ok(Math.abs((totalWatts([6.8, null, 2.9, 0]) ?? 0) - 9.7) < 1e-9);
  assert.equal(totalWatts([null, null]), null);
  assert.equal(totalWatts([]), null);
});

test("names lose the word they all begin with, unless that would leave one empty", () => {
  assert.deepEqual(shortNames(["Aquarium Canister Filter", "Aquarium water heater", "Aquarium CO2"]), ["Canister Filter", "Water heater", "CO2"]);
  assert.deepEqual(shortNames(["Aquarium Canister Filter", "Plant light"]), ["Aquarium Canister Filter", "Plant light"]);
  assert.deepEqual(shortNames(["Aquarium", "Aquarium heater"]), ["Aquarium", "Aquarium heater"]);
  assert.deepEqual(shortNames(["Aquarium heater"]), ["Aquarium heater"]);
  assert.deepEqual(shortNames([]), []);
});

// ---- switching off ----

test("switching off what the fish depend on asks in the danger tone and says why", () => {
  const filter = offCost("filter", true);
  assert.equal(filter?.tone, "danger");
  assert.match(filter?.text ?? "", /Fish need the filter running/);
  assert.match(offCost("heater", true)?.text ?? "", /heated/);
});

test("the light outlet asks without alarm, and an ordinary outlet does not ask", () => {
  assert.deepEqual(offCost("light", false), { text: "The Fluval loses power and the tank goes dark.", tone: "neutral" });
  assert.equal(offCost("spare", false), null);
  assert.equal(offCost("co2", false), null);
  assert.equal(offCost("uv", false), null);
  assert.equal(offCost("light", true)?.tone, "danger", "marking it critical wins");
});

// ---- the CO2 guard ----

const WINDOW: Co2Window = { enabled: true, start: 7 * 60 + 30, end: 14 * 60 };
const note = (nowMinutes: number, on: boolean, window: Co2Window | null = WINDOW, programName: string | null = "Algae Reset") => co2Note({ window, programName, nowMinutes, on });

test("inside its window the CO2 tile says how long it may run; the edges follow the automation's rule", () => {
  assert.deepEqual(note(10 * 60, true), { text: "Running until 14:00", tone: "neutral" });
  assert.equal(note(10 * 60, false).text, "In its window until 14:00, not running");
  assert.equal(note(7 * 60 + 30, true).text, "Running until 14:00", "the start minute is inside");
  assert.equal(note(14 * 60, false).text, "Next: 07:30–14:00 tomorrow", "the end minute is outside");
});

test("from the light check on, CO2 is held off until the lamp proves it is on, exactly as the automation decides", () => {
  const with_ = (nowMinutes: number, on: boolean, watts: number | null, checkFrom: number | null = 9 * 60 + 15) => co2Note({ window: WINDOW, programName: "Algae Reset", nowMinutes, on, light: { checkFrom, watts } });
  assert.deepEqual(with_(9 * 60 + 20, false, 1.1), { text: "Held off: waiting for the lamp to draw power.", tone: "warning" });
  const running = with_(9 * 60 + 20, true, 1.1);
  assert.equal(running.tone, "warning");
  assert.match(running.text, /lamp isn.t drawing power/);
  assert.equal(with_(9 * 60 + 20, true, 23).text, "Running until 14:00", "the lamp is on: nothing to say");
  assert.equal(with_(9 * 60 + 20, false, LAMP_WATTS).text, "In its window until 14:00, not running", "exactly 8 W counts as proof");
  assert.equal(with_(9 * 60 + 14, false, 0).text, "In its window until 14:00, not running", "before the light check the lamp is not required");
  assert.equal(with_(9 * 60 + 15, false, 0).tone, "warning", "from the light check minute it is");
  assert.equal(with_(9 * 60 + 20, true, null).text, "Running until 14:00", "no reading proves nothing either way");
  assert.equal(with_(9 * 60 + 20, true, 0, null).text, "Running until 14:00", "a program with no light check does not need the lamp");
  assert.match(with_(17 * 60, true, 0).text, /Outside its window/, "outside the window the window is what matters");
});

test("outside its window CO2 says when it is next allowed", () => {
  assert.deepEqual(note(6 * 60, false), { text: "Next: 07:30–14:00", tone: "neutral" });
  assert.equal(note(20 * 60, false).text, "Next: 07:30–14:00 tomorrow");
});

test("CO2 that is on outside its window is flagged because the automation will switch it off", () => {
  const late = note(20 * 60, true);
  assert.equal(late.tone, "warning");
  assert.match(late.text, /Home Assistant switches it off/);
  assert.equal(note(6 * 60, true).tone, "warning");
});

test("a program without CO2 says so, and warns when the outlet is on anyway", () => {
  const blackout: Co2Window = { enabled: false, start: 0, end: 0 };
  assert.deepEqual(note(10 * 60, false, blackout, "Blackout"), { text: "CO2 is off in Blackout.", tone: "neutral" });
  const on = note(10 * 60, true, blackout, "Blackout");
  assert.equal(on.tone, "warning");
  assert.match(on.text, /Blackout/);
});

test("when the program's settings are not known the tile still says CO2 is guarded", () => {
  assert.match(note(10 * 60, true, null, null).text, /lighting program's CO2 window/);
  assert.match(note(10 * 60, true, null, "Normal").text, /Normal/);
  assert.equal(note(10 * 60, true, null, null).tone, "neutral", "nothing to accuse without the window");
});

// ---- the water ----

test("a temperature reading carries its unit and when it was last heard", () => {
  const reading = readTemperature(state("sensor.t", "77.4", { unit_of_measurement: "°F" }, "2026-09-30T10:00:00+00:00"));
  assert.deepEqual(reading, { value: 77.4, unit: "°F", updatedMs: Date.UTC(2026, 8, 30, 10) });
  assert.equal(readTemperature(state("sensor.t", "unavailable")), null);
  assert.equal(readTemperature(state("sensor.t", "")), null);
  assert.equal(readTemperature(undefined), null);
  assert.equal(readTemperature(state("sensor.t", "21"))?.unit, "");
  assert.equal(readTemperature(state("sensor.t", "21", {}, "not a date"))?.updatedMs, null);
  const steady = { ...state("sensor.t", "77", {}, "2026-09-30T06:00:00+00:00"), last_reported: "2026-09-30T10:00:00+00:00" };
  assert.equal(readTemperature(steady)?.updatedMs, Date.UTC(2026, 8, 30, 10), "a sensor that keeps reporting the same value is still alive");
});

test("the comfortable band needs two numbers in order", () => {
  assert.deepEqual(readBand(74, 80), { min: 74, max: 80 });
  assert.equal(readBand(80, 74), null);
  assert.equal(readBand(74, 74), null);
  assert.equal(readBand(undefined, 80), null);
  assert.equal(readBand("74", 80), null);
});

test("inside the band is fine, just outside warns, well outside is dangerous", () => {
  const band = { min: 74, max: 80 };
  assert.deepEqual(judgeTemperature(77, band), { position: "in", tone: "positive", away: 0 });
  assert.equal(judgeTemperature(74, band).position, "in", "the limits belong to the band");
  assert.equal(judgeTemperature(80, band).position, "in");
  assert.deepEqual(judgeTemperature(72, band), { position: "low", tone: "warning", away: 2 });
  assert.equal(judgeTemperature(71, band).tone, "warning", "half the band's width away is still a warning");
  assert.equal(judgeTemperature(70.9, band).tone, "danger");
  assert.equal(judgeTemperature(83, band).tone, "warning");
  assert.deepEqual([judgeTemperature(83.1, band).position, judgeTemperature(83.1, band).tone], ["high", "danger"]);
});

test("the verdict is put in words in the sensor's own unit", () => {
  const band = { min: 74, max: 80 };
  assert.equal(describeVerdict(judgeTemperature(77, band), band, "°F"), "In the comfortable range, 74–80°F");
  assert.equal(describeVerdict(judgeTemperature(72.1, band), band, "°F"), "1.9° below the comfortable range");
  assert.equal(describeVerdict(judgeTemperature(81.25, band), band, "°C"), "1.3° above the comfortable range");
  assert.equal(describeVerdict(judgeTemperature(81, { min: 70, max: 80 }), { min: 70, max: 80 }, "K"), "1 K above the comfortable range");
});

test("the band indicator puts the band in the middle and stops the marker at its ends", () => {
  const band = { min: 74, max: 80 };
  const track = bandTrack(77, band);
  assert.ok(Math.abs(track.from - 0.3) < 1e-9 && Math.abs(track.to - 0.7) < 1e-9);
  assert.ok(Math.abs((track.marker ?? -1) - 0.5) < 1e-9);
  assert.equal(bandTrack(40, band).marker, 0);
  assert.equal(bandTrack(120, band).marker, 1);
  assert.equal(bandTrack(null, band).marker, null);
  assert.ok(bandTrack(74, band).marker === track.from && bandTrack(80, band).marker === track.to, "the band's ends are its limits");
});

test("a reading's age is put the way a person would say it", () => {
  const minute = 60_000;
  assert.equal(describeAge(0), "just now");
  assert.equal(describeAge(-5 * minute), "just now", "a clock slightly ahead is not an age");
  assert.equal(describeAge(90_000), "1 min ago");
  assert.equal(describeAge(59 * minute), "59 min ago");
  assert.equal(describeAge(60 * minute), "1 h ago");
  assert.equal(describeAge(47 * 60 * minute), "47 h ago");
  assert.equal(describeAge(48 * 60 * minute), "2 days ago");
});

test("the thermometer's battery is read as a percent and warns when it runs low", () => {
  assert.equal(readBattery(state("sensor.b", "87")), 87);
  assert.equal(readBattery(state("sensor.b", "104")), 100);
  assert.equal(readBattery(state("sensor.b", "unavailable")), null);
  assert.equal(readBattery(undefined), null);
  assert.deepEqual([batteryTone(80), batteryTone(20), batteryTone(11), batteryTone(10), batteryTone(0)], ["neutral", "warning", "warning", "danger", "danger"]);
});

// ---- the history ----

const HOUR = 3_600_000;

test("the compact history answer is read into numbers in time order, dropping what is not a number", () => {
  const answer = {
    "sensor.t": [
      { s: "77.5", lu: 1_800_000_060 },
      { s: "77.1", lu: 1_800_000_000 },
      { s: "unavailable", lu: 1_800_000_120 },
      { s: "unknown", lu: 1_800_000_180 },
      { s: "", lu: 1_800_000_240 },
      { s: "77.9" },
    ],
    "sensor.other": [{ s: "1", lu: 1 }],
  };
  assert.deepEqual(parseHistory(answer, "sensor.t"), [
    { t: 1_800_000_000_000, v: 77.1 },
    { t: 1_800_000_060_000, v: 77.5 },
  ]);
  assert.deepEqual(parseHistory(answer, "sensor.missing"), []);
  assert.deepEqual(parseHistory(null, "sensor.t"), []);
  assert.deepEqual(parseHistory({ "sensor.t": "nope" }, "sensor.t"), []);
});

test("the long history form is read too", () => {
  const answer = { "sensor.t": [{ state: "70.5", last_updated: "2026-09-30T10:00:00+00:00" }, { state: "71", last_changed: "2026-09-30T11:00:00+00:00" }] };
  assert.deepEqual(parseHistory(answer, "sensor.t"), [
    { t: Date.UTC(2026, 8, 30, 10), v: 70.5 },
    { t: Date.UTC(2026, 8, 30, 11), v: 71 },
  ]);
});

test("a chatty sensor is averaged down to a few points without changing the shape", () => {
  const points: HistoryPoint[] = Array.from({ length: 1000 }, (_, i) => ({ t: i * 1000, v: i < 500 ? 70 : 80 }));
  const small = downsample(points, 0, 1_000_000, 10);
  assert.equal(small.length, 10);
  assert.deepEqual(small.map((point) => point.v), [70, 70, 70, 70, 70, 80, 80, 80, 80, 80]);
  assert.deepEqual(downsample(points.slice(0, 4), 0, 1_000_000, 10), points.slice(0, 4), "few points are left alone");
  assert.ok(downsample(points, 0, 1_000_000, 10).every((point, i, all) => i === 0 || point.t > all[i - 1]!.t));
});

test("empty stretches of time do not become empty buckets", () => {
  const points: HistoryPoint[] = [{ t: 0, v: 1 }, { t: 1, v: 3 }, { t: 900, v: 5 }];
  const small = downsample(points, 0, 1000, 2);
  assert.deepEqual(small.map((point) => point.v), [2, 5]);
});

test("the sparkline draws high readings high, ends at the latest reading, and keeps the band in view", () => {
  const start = 0;
  const end = 24 * HOUR;
  const points: HistoryPoint[] = [{ t: 0, v: 76 }, { t: 12 * HOUR, v: 78 }, { t: 24 * HOUR, v: 77 }];
  const line = sparkline(points, start, end, { width: 200, height: 60, pad: 4 }, { min: 74, max: 80 });
  assert.ok(line);
  assert.match(line.path, /^M4 /, "starts at the left padding");
  assert.equal(line.last?.x, 196, "ends at the right padding");
  const ys = line.path.split(/[ML]/).filter(Boolean).map((pair) => Number(pair.split(" ")[1]));
  assert.ok(ys[1]! < ys[0]! && ys[1]! < ys[2]!, "the 78 is higher (smaller y) than 76 and 77");
  assert.ok(line.band && line.band.top < line.band.bottom, "the band is drawn top to bottom");
  assert.ok(ys.every((y) => y > line.band!.top && y < line.band!.bottom), "readings of 76-78 lie inside the 74-80 band, not stretched to fill the box");
  assert.deepEqual([line.low, line.high], [76, 78], "the range reported is that of the readings, not the band");
});

test("the sparkline without a band, or without readings", () => {
  const flat = sparkline([{ t: 0, v: 20 }, { t: 1000, v: 20 }], 0, 1000, { width: 100, height: 40, pad: 2 }, null);
  assert.ok(flat && flat.band === null && !flat.path.includes("NaN"), "a flat line still has a scale");
  assert.equal(sparkline([], 0, 1000, { width: 100, height: 40, pad: 2 }, null), null);
  assert.equal(sparkline([{ t: 0, v: 1 }], 5, 5, { width: 100, height: 40, pad: 2 }, null), null);
  const one = sparkline([{ t: 500, v: 21 }], 0, 1000, { width: 100, height: 40, pad: 2 }, null);
  assert.ok(one && one.path.startsWith("M") && !one.path.includes("L"));
});

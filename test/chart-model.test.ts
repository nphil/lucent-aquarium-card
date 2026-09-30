import { test } from "node:test";
import assert from "node:assert/strict";
import { swatchColour, type ChannelDef } from "../src/lib/channels.ts";
import { chartHeight, chartLayout, chartSummary, channelDodge, channelGeometry, DODGE_PX, keyStep, needsHalo, RAIL_HEIGHT, readoutWidth, ribbonGradient, ribbonStops, scrubMinutes } from "../src/lib/chart-model.ts";
import { movePointTo, neighbourBounds, type SchedulePoint } from "../src/lib/points.ts";

const RGBW: readonly ChannelDef[] = [
  { id: "red", name: "Red", short: "R", colour: "#f2545b", light: [1, 0, 0] },
  { id: "green", name: "Green", short: "G", colour: "#2fc77a", light: [0, 1, 0] },
  { id: "blue", name: "Blue", short: "B", colour: "#4b8bf5", light: [0, 0, 1] },
  { id: "white", name: "White", short: "W", colour: "#f6f3ea", light: [0.85, 0.85, 0.85] },
];
/** A five-emitter light with two-letter short names, like a Fluval. */
const FIVE: readonly ChannelDef[] = [
  { id: "pink", name: "Pink", short: "PK", colour: "#ff7fb0", light: [1, 0.3, 0.5] },
  { id: "blue", name: "Blue", short: "B", colour: "#3f7bff", light: [0, 0.2, 1] },
  { id: "cold", name: "Cold white", short: "CW", colour: "#e6f0ff", light: [0.8, 0.9, 1] },
  { id: "white", name: "White", short: "W", colour: "#ffffff", light: [1, 1, 1] },
  { id: "warm", name: "Warm white", short: "WW", colour: "#ffe2b8", light: [1, 0.8, 0.5] },
];

const flat = (minutes: number, level: number, count = 4): SchedulePoint => ({ minutes, levels: new Array<number>(count).fill(level) });

test("the chart is about half as tall as it is wide, clamped between 180 and 300 px", () => {
  assert.equal(chartHeight(300), 180);
  assert.equal(chartHeight(400), 200);
  assert.equal(chartHeight(560), 280);
  assert.equal(chartHeight(900), 300);
  assert.equal(chartHeight(0), 180, "before the first measurement");
});

test("the plot stays usable from 300 px to 900 px, and the editor's rail sits between plot and labels", () => {
  for (const width of [300, 375, 640, 900]) {
    const read = chartLayout(width, false);
    assert.ok(read.box.width >= 240 && read.box.left + read.box.width < width, `plot fits at ${width}`);
    assert.ok(read.box.height >= 138, `plot is tall enough at ${width}`);
    assert.equal(read.railY, null);
    assert.ok(read.labelY > read.box.top + read.box.height && read.labelY < read.height, "labels sit under the plot, inside the drawing");

    const edit = chartLayout(width, true);
    assert.equal(edit.height, read.height + RAIL_HEIGHT);
    assert.deepEqual(edit.box, read.box, "the rail must not squeeze the plot");
    const plotBottom = edit.box.top + edit.box.height;
    assert.ok(edit.railY! > plotBottom && edit.railY! < edit.labelY - 8, "the rail is between the plot and the hour labels");
  }
});

test("channels at the same level are nudged apart symmetrically, for four channels or five", () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => channelDodge(i, 4)), [-1.875, -0.625, 0.625, 1.875]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => channelDodge(i, 5)), [-2.5, -1.25, 0, 1.25, 2.5]);
  assert.equal(channelDodge(0, 1), 0, "a lone channel is not moved");

  const box = chartLayout(375, false).box;
  for (const channels of [RGBW, FIVE]) {
    const geometry = channelGeometry([flat(360, 50, channels.length), flat(1080, 50, channels.length)], box, channels);
    assert.deepEqual(geometry.map((g) => g.channel.id), channels.map((c) => c.id), "the light's own channel order");
    assert.deepEqual(geometry.map((g) => g.index), channels.map((_, i) => i));
    const ys = geometry.map((g) => g.dots[0]!.y);
    assert.equal(new Set(ys).size, channels.length, "equal channels are distinct lines");
    assert.ok(ys.every((y, i) => i === 0 || y - ys[i - 1]! === DODGE_PX));
    const centre = box.top + box.height / 2;
    assert.ok(Math.abs(ys.reduce((a, b) => a + b, 0) / ys.length - centre) < 1e-9, "the nudges average out to the true 50% line");
  }
});

test("every channel path runs edge to edge (the wrap is drawn) and has a dot per point", () => {
  const box = chartLayout(375, false).box;
  const points: SchedulePoint[] = [flat(420, 0, 5), { minutes: 720, levels: [100, 40, 0, 100, 60] }, flat(1200, 20, 5)];
  for (const channel of channelGeometry(points, box, FIVE)) {
    assert.equal(channel.dots.length, points.length);
    const numbers = channel.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    assert.equal(numbers[0], box.left, `${channel.channel.name} starts at the left edge`);
    assert.equal(numbers[numbers.length - 2], box.left + box.width, `${channel.channel.name} ends at the right edge`);
    assert.equal(channel.path.split("L").length - 1, 4, "left edge, three points, right edge");
  }
  const empty = channelGeometry([], box, RGBW);
  assert.ok(empty.every((channel) => channel.dots.length === 0 && channel.path.startsWith("M")), "an empty program is a flat dark line");
  assert.deepEqual(channelGeometry(points, box, []), [], "a light without channels draws nothing");
});

test("near-white channels get a halo so they read on a light theme; coloured ones do not", () => {
  assert.equal(needsHalo(RGBW[3]!), true);
  assert.equal(needsHalo(FIVE[3]!), true, "pure white");
  assert.equal(needsHalo(FIVE[2]!), true, "cold white");
  assert.equal(needsHalo(FIVE[4]!), true, "warm white");
  for (const channel of [RGBW[0]!, RGBW[1]!, RGBW[2]!, FIVE[0]!, FIVE[1]!]) assert.equal(needsHalo(channel), false, channel.name);
  assert.equal(needsHalo({ ...RGBW[0]!, colour: "rgb(250, 250, 240)" }), true, "rgb() colours are read too");
  assert.equal(needsHalo({ ...RGBW[0]!, colour: "#fff" }), true, "short hex");
  assert.equal(needsHalo({ ...RGBW[0]!, colour: "var(--x)" }), false, "an unreadable colour is left alone");
});

test("the ribbon keeps every point's own minute, so a sharp ramp is not averaged away", () => {
  const points = [flat(0, 0), flat(427, 100), flat(1000, 0)];
  const stops = ribbonStops(points, RGBW);
  assert.equal(stops[0]!.offset, 0);
  assert.equal(stops[stops.length - 1]!.offset, 1);
  assert.ok(stops.every((stop, i) => i === 0 || stop.offset > stops[i - 1]!.offset), "strictly increasing");
  const peak = stops.find((stop) => stop.offset === 427 / 1440);
  assert.ok(peak, "07:07 is on the ribbon although it is not a half hour");
  assert.equal(peak.colour, swatchColour([100, 100, 100, 100], RGBW));
  assert.equal(stops[0]!.colour, swatchColour([0, 0, 0, 0], RGBW));

  const css = ribbonGradient(stops);
  assert.ok(css.startsWith("linear-gradient(to right, ") && css.includes(" 0.00%") && css.includes(" 100.00%"));
});

test("the ribbon is drawn from the light's own channels, so five emitters colour it differently from four", () => {
  const four = ribbonStops([flat(0, 100, 4)], RGBW);
  const five = ribbonStops([flat(0, 100, 5)], FIVE);
  assert.notEqual(four[0]!.colour, five[0]!.colour);
  assert.equal(five[0]!.colour, swatchColour([100, 100, 100, 100, 100], FIVE));
});

test("scrubbing the far right edge reads 23:59, never 24:00", () => {
  const box = chartLayout(375, false).box;
  assert.equal(scrubMinutes(box, box.left), 0);
  assert.equal(scrubMinutes(box, box.left + box.width / 2), 720);
  assert.equal(scrubMinutes(box, box.left + box.width), 1439);
  assert.equal(scrubMinutes(box, box.left + box.width + 80), 1439);
  assert.equal(scrubMinutes(box, -50), 0);
});

test("the scrub readout is wider for more or longer channel names, so the chart can keep it inside", () => {
  assert.ok(readoutWidth(FIVE) > readoutWidth(RGBW));
  assert.ok(readoutWidth([{ ...RGBW[0]!, short: "RR" }]) > readoutWidth([RGBW[0]!]));
  assert.ok(readoutWidth([]) > 0, "the time is always shown");
});

test("the chart's text alternative names the program, the count and the span", () => {
  const dutch = ["06:00", "08:00", "09:00", "11:00", "13:00", "16:00", "17:00", "18:00", "19:00", "22:00"].map((t) => flat(Number(t.slice(0, 2)) * 60, 10));
  assert.equal(chartSummary("Dutch style", dutch), "Dutch style: 10 points from 06:00 to 22:00");
  assert.equal(chartSummary("DIY 1", [flat(450, 5)]), "DIY 1: 1 point at 07:30");
  assert.equal(chartSummary("DIY 3", []), "DIY 3: no points");
  assert.equal(chartSummary("DIY 2", [flat(0, 0), flat(1439, 0)]), "DIY 2: 2 points from 00:00 to 23:59");
});

test("keys move a time grip by the snap step, one minute with Shift, an hour with Page keys", () => {
  const bounds = { lo: 421, hi: 900 };
  assert.deepEqual(keyStep("ArrowRight", false, 600, 15, bounds), { minutes: 615, step: 15 });
  assert.deepEqual(keyStep("ArrowLeft", false, 600, 15, bounds), { minutes: 585, step: 15 });
  assert.deepEqual(keyStep("ArrowRight", true, 600, 15, bounds), { minutes: 601, step: 1 });
  assert.deepEqual(keyStep("ArrowLeft", true, 600, 15, bounds), { minutes: 599, step: 1 });
  assert.deepEqual(keyStep("PageUp", false, 600, 15, bounds), { minutes: 660, step: 15 });
  assert.deepEqual(keyStep("PageDown", false, 600, 15, bounds), { minutes: 540, step: 15 });
  assert.deepEqual(keyStep("Home", false, 600, 15, bounds), { minutes: 421, step: 1 }, "earliest allowed is exact, not snapped away from the neighbour");
  assert.deepEqual(keyStep("End", false, 600, 15, bounds), { minutes: 900, step: 1 });
  for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "a", "Tab"]) assert.equal(keyStep(key, false, 600, 15, bounds), null, key);
});

test("a key edit applied through the editor's rules snaps to the grid and never crosses a neighbour", () => {
  const points = [flat(420, 10), flat(600, 20), flat(1200, 30)];
  const apply = (key: string, shift = false, index = 1): number => {
    const step = keyStep(key, shift, points[index]!.minutes, 15, neighbourBounds(points, index))!;
    return movePointTo(points, index, step.minutes, step.step)[index]!.minutes;
  };
  assert.equal(apply("ArrowRight"), 615);
  assert.equal(apply("ArrowLeft", true), 599);
  assert.equal(apply("Home"), 421, "one minute after the previous point");
  assert.equal(apply("End"), 1199, "one minute before the next point");
  assert.equal(apply("End", false, 2), 1439, "the last point can reach the last minute of the day");
  assert.equal(apply("PageDown", false, 0), 360);
  assert.equal(apply("PageDown", false, 1), 540);
});

test("points that share a minute are a step: the ribbon draws a hard edge there, not a fade", () => {
  // Night levels until 23:00, then off at once (the light's sleep time).
  const points = [flat(480, 0), flat(540, 100), flat(1200, 40), flat(1380, 40), flat(1380, 0)];
  const stops = ribbonStops(points, RGBW);
  const step = stops.filter((stop) => stop.offset === 1380 / 1440);
  assert.equal(step.length, 2, "two stops on the same offset");
  assert.equal(step[0]!.colour, swatchColour([40, 40, 40, 40], RGBW), "the colour arriving at the step");
  assert.equal(step[1]!.colour, swatchColour([0, 0, 0, 0], RGBW), "and the colour leaving it");
  assert.equal(stops.filter((stop) => stop.offset === 540 / 1440).length, 1, "a lone point still gets one stop");
  assert.match(ribbonGradient(stops), /rgb\(\d+, \d+, \d+\) 95\.83%, rgb\(\d+, \d+, \d+\) 95\.83%/, "a hard stop in the gradient");
});

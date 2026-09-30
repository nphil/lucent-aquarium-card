import { test } from "node:test";
import assert from "node:assert/strict";
import { brightestPoint, parseTypedTime, restorePoint, setPointTime } from "../src/lib/point-edit.ts";
import { validatePoints, type SchedulePoint } from "../src/lib/points.ts";

const at = (time: string, level = 10, count = 4): SchedulePoint => ({ minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), levels: new Array<number>(count).fill(level) });
const times = (points: readonly SchedulePoint[]): number[] => points.map((point) => point.minutes);

test("a typed time can jump past a neighbour: the list re-sorts and the index follows the point", () => {
  const points = [at("06:00", 1), at("08:00", 2), at("12:00", 3), at("20:00", 4)];
  const result = setPointTime(points, 1, 13 * 60);
  assert.ok(result.ok);
  assert.deepEqual(times(result.points), [360, 720, 780, 1200]);
  assert.equal(result.index, 2);
  assert.deepEqual(result.points[result.index]!.levels, [2, 2, 2, 2], "the moved point keeps its own levels");
  assert.deepEqual(validatePoints(result.points, 12), []);
  assert.equal(points[1]!.minutes, 480, "the draft it came from is untouched");
});

test("a typed time another point already has is refused with a readable message", () => {
  const points = [at("06:00"), at("08:00"), at("12:00")];
  const result = setPointTime(points, 0, 8 * 60);
  assert.deepEqual(result, { ok: false, error: "08:00 is already used" });
});

test("typing the time a point already has changes nothing, and impossible times are refused", () => {
  const points = [at("06:00"), at("08:00")];
  const same = setPointTime(points, 1, 480);
  assert.ok(same.ok && same.points === points && same.index === 1);
  for (const bad of [-1, 1440, 12.5, Number.NaN]) assert.equal(setPointTime(points, 0, bad).ok, false, String(bad));
  assert.equal(setPointTime(points, 5, 100).ok, false, "no such point");
});

test("undo puts the deleted point back at its own time, or the nearest free minute", () => {
  const removed: SchedulePoint = { minutes: 480, levels: [7, 7, 7, 7] };
  const back = restorePoint([at("06:00"), at("12:00")], removed, 12)!;
  assert.deepEqual(times(back.points), [360, 480, 720]);
  assert.equal(back.index, 1);
  assert.deepEqual(back.points[1]!.levels, [7, 7, 7, 7]);

  const taken = restorePoint([at("06:00"), at("08:00"), at("12:00")], removed, 12)!;
  assert.deepEqual(times(taken.points), [360, 480, 481, 720], "the time was reused meanwhile: next free minute, later first");
  assert.deepEqual(taken.points[taken.index]!.levels, [7, 7, 7, 7]);
  assert.deepEqual(validatePoints(taken.points, 12), []);

  const crowded = restorePoint([at("08:00"), at("08:01"), at("07:59")], removed, 12)!;
  assert.deepEqual(times(crowded.points), [479, 480, 481, 482], "keeps searching outwards past used minutes");
  assert.equal(crowded.index, 3);
});

test("undo is refused when the program is already full, for whatever limit the light has", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => at(`${String(i * 2).padStart(2, "0")}:00`));
  assert.equal(restorePoint(twelve, at("01:00"), 12), null);
  assert.ok(restorePoint(twelve.slice(1), at("01:00"), 12));
  assert.equal(restorePoint(twelve.slice(0, 6), at("01:00"), 6), null, "a light that holds six");
});

test("the editor opens on the point with the most light, first on a tie, and none for an empty draft", () => {
  assert.equal(brightestPoint([at("06:00", 0), at("12:00", 40), at("18:00", 20)]), 1);
  assert.equal(brightestPoint([at("06:00", 5), at("12:00", 5)]), 0);
  assert.equal(brightestPoint([{ minutes: 60, levels: [0, 0, 0, 0] }]), 0);
  assert.equal(brightestPoint([{ minutes: 60, levels: [10, 0, 0, 0, 0] }, { minutes: 120, levels: [0, 0, 0, 0, 30] }]), 1, "any number of channels");
  assert.equal(brightestPoint([]), -1);
});

test("what people type in the time field is read as a 24-hour time, however they write it", () => {
  for (const [typed, minutes] of [
    ["07:15", 435],
    ["7:15", 435],
    ["715", 435],
    ["0715", 435],
    ["7.15", 435],
    ["7 15", 435],
    ["19", 1140],
    ["7", 420],
    ["00:00", 0],
    ["23:59", 1439],
    ["  22:30 ", 1350],
  ] as const) {
    assert.equal(parseTypedTime(typed), minutes, typed);
  }
});

test("times that are not a time of day are not guessed at", () => {
  for (const typed of ["", "24:00", "7:60", "2400", "25", "12345", "3pm", "ab:cd", "7:5", "-1:00"]) assert.equal(parseTypedTime(typed), null, typed);
});

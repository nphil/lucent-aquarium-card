import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProgramData, ScheduleProgram } from "../src/adapters/types.ts";
import type { ProgramEntry } from "../src/lib/program-store.ts";
import type { SchedulePoint } from "../src/lib/points.ts";
import { describeView, groupPrograms, initialProgram, NOT_CONNECTED, overwriteNote, planActions, suggestSlot, type ProgramView } from "../src/lib/schedule-view.ts";

const program = (id: string, name: string, group: string, editable: boolean): ScheduleProgram => ({ id, name, group, editable });
const JAPANESE = program("japanese_style", "Japanese style", "Presets", false);
const DUTCH = program("dutch_style", "Dutch style", "Presets", false);
const DIY1 = program("diy_1", "DIY 1", "Your programs", true);
const DIY2 = program("diy_2", "DIY 2", "Your programs", true);
const DIY3 = program("diy_3", "DIY 3", "Your programs", true);
const PAWFLY = [JAPANESE, DUTCH, DIY1, DIY2, DIY3];

const point = (minutes: number): SchedulePoint => ({ minutes, levels: [10, 10, 10, 10] });
const data = (p: ScheduleProgram, count: number, source: ProgramData["source"] = p.editable ? "device" : "preset"): ProgramData => ({
  id: p.id,
  name: p.name,
  editable: p.editable,
  source,
  points: Array.from({ length: count }, (_, i) => point(i * 60)),
});
const ready = (p: ScheduleProgram, count: number, source?: ProgramData["source"]): ProgramEntry => ({ status: "ready", data: data(p, count, source), error: null });
const idle: ProgramEntry = { status: "idle", data: null, error: null };
const loading: ProgramEntry = { status: "loading", data: null, error: null };
const failed = (p: ScheduleProgram | null, count = 0): ProgramEntry => ({ status: "error", data: p === null ? null : data(p, count), error: "The light did not answer in time." });

test("a program that has not arrived yet is a skeleton, never an empty state", () => {
  assert.deepEqual(describeView(DUTCH, idle, "on"), { kind: "loading" });
  assert.deepEqual(describeView(DIY2, loading, "on"), { kind: "loading" });
});

test("a failed first read says so with the reason instead of showing a blank chart", () => {
  assert.deepEqual(describeView(DUTCH, failed(null), "on"), { kind: "error", message: "The light did not answer in time." });
});

test("old data survives a failed read but is marked stale, with the error next to it", () => {
  const view = describeView(DIY2, failed(DIY2, 5), "on");
  assert.ok(view.kind === "chart" && view.stale && view.data.points.length === 5);
  assert.deepEqual(view.kind === "chart" && view.notice, { kind: "error", message: "The light did not answer in time." });
});

test("re-reading a program keeps showing it, flagged as refreshing but not stale", () => {
  const view = describeView(JAPANESE, { status: "loading", data: data(JAPANESE, 7), error: null }, "on");
  assert.ok(view.kind === "chart" && !view.stale && view.refreshing && view.notice === null);
});

test("an editable slot with no points is the empty state; a built-in program is never empty", () => {
  assert.deepEqual(describeView(DIY3, ready(DIY3, 0), "on"), { kind: "empty" });
  assert.equal(describeView(JAPANESE, ready(JAPANESE, 3), "on").kind, "chart");
});

test("with the link down an editable program is never asked for: cached data goes stale, no data says the link is down", () => {
  assert.deepEqual(describeView(DIY1, idle, "unavailable"), { kind: "link-down" });
  const cached = describeView(DIY1, ready(DIY1, 4), "unavailable");
  assert.ok(cached.kind === "chart" && cached.stale && cached.notice?.kind === "link-down");
  assert.deepEqual(describeView(DIY1, ready(DIY1, 0), "unavailable"), { kind: "link-down" }, "an empty slot cannot be trusted either");
  assert.deepEqual(describeView(DIY1, failed(null), "unavailable"), { kind: "link-down" }, "the link, not the read, is the story");
});

test("built-in presets keep working while the link is down", () => {
  const view = describeView(DUTCH, ready(DUTCH, 10), "unavailable");
  assert.ok(view.kind === "chart" && !view.stale && view.notice === null);
});

test("a read-only program that comes from the light (not a preset table) is stale while the link is down, and is still tried", () => {
  const fluval = program("automatic", "Automatic", "Schedules", false);
  const cached = describeView(fluval, ready(fluval, 4, "device"), "unavailable");
  assert.ok(cached.kind === "chart" && cached.stale && cached.notice?.kind === "link-down");
  assert.deepEqual(describeView(fluval, idle, "unavailable"), { kind: "loading" }, "the read is attempted, so it is not yet a verdict");
  assert.deepEqual(describeView(fluval, failed(null), "unavailable"), { kind: "link-down" });
  assert.deepEqual(describeView(fluval, failed(null), "on"), { kind: "error", message: "The light did not answer in time." });
});

const chart = (points = 8): ProgramView => ({ kind: "chart", data: data(DIY1, points), stale: false, notice: null, refreshing: false });
const base = { phase: "on" as const, running: false, canSave: true, hasEditableTarget: true };

test("a program that is not running offers Activate; the one that is running offers none", () => {
  assert.deepEqual(planActions({ ...base, program: DUTCH, view: chart() }).activate, { disabledReason: null });
  const running = planActions({ ...base, program: DIY2, view: chart(), running: true });
  assert.equal(running.activate, null);
  assert.equal(running.secondary?.kind, "edit", "a running program of your own can still be edited");
});

test("presets offer Customise, your own programs offer Edit, an empty slot offers only Create program", () => {
  assert.equal(planActions({ ...base, program: JAPANESE, view: chart() }).secondary?.kind, "customise");
  assert.equal(planActions({ ...base, program: DIY1, view: chart() }).secondary?.kind, "edit");
  const empty = planActions({ ...base, program: DIY3, view: { kind: "empty" } });
  assert.equal(empty.activate, null, "there is nothing to activate");
  assert.deepEqual(empty.secondary, { kind: "create", disabledReason: null });
});

test("a light whose schedules cannot be written offers Activate but no Edit and no Customise", () => {
  const fluval = program("professional", "Professional", "Schedules", false);
  const plan = planActions({ ...base, program: fluval, view: chart(), canSave: false, hasEditableTarget: false });
  assert.deepEqual(plan.activate, { disabledReason: null });
  assert.equal(plan.secondary, null);
  const running = planActions({ ...base, program: fluval, view: chart(), canSave: false, hasEditableTarget: false, running: true });
  assert.deepEqual([running.activate, running.secondary], [null, null]);
});

test("Customise needs a slot to save into", () => {
  assert.equal(planActions({ ...base, program: DUTCH, view: chart(), hasEditableTarget: false }).secondary, null);
});

test("every action that needs the link is disabled with the same visible reason when it is down", () => {
  for (const [p, view] of [
    [DUTCH, chart()],
    [DIY2, chart()],
  ] as const) {
    const plan = planActions({ ...base, program: p, view, phase: "unavailable" });
    assert.equal(plan.activate?.disabledReason, NOT_CONNECTED);
    assert.equal(plan.secondary?.disabledReason, NOT_CONNECTED);
  }
  const link = planActions({ ...base, program: DIY2, view: { kind: "link-down" }, phase: "unavailable" });
  assert.equal(link.secondary?.disabledReason, NOT_CONNECTED);
  assert.equal(planActions({ ...base, program: DUTCH, view: chart(), phase: null }).activate?.disabledReason, "Waiting for the light…");
  assert.equal(planActions({ ...base, program: DIY3, view: { kind: "empty" }, phase: "unavailable" }).secondary?.disabledReason, NOT_CONNECTED);
});

test("a light that is off is not running anything, so Activate is still offered", () => {
  const plan = planActions({ ...base, program: DIY2, view: chart(), phase: "off" });
  assert.deepEqual(plan.activate, { disabledReason: null });
});

test("an editable program that has not been read cannot be activated or edited, and says why; a built-in can still be activated", () => {
  const diy = planActions({ ...base, program: DIY2, view: { kind: "loading" } });
  assert.equal(diy.activate?.disabledReason, "Reading DIY 2 from the light…");
  assert.equal(diy.secondary?.disabledReason, "Reading DIY 2 from the light…");
  const failedDiy = planActions({ ...base, program: DIY2, view: { kind: "error", message: "x" } });
  assert.equal(failedDiy.activate?.disabledReason, "Reload DIY 2 first.");

  const preset = planActions({ ...base, program: DUTCH, view: { kind: "loading" } });
  assert.deepEqual(preset.activate, { disabledReason: null }, "the firmware has its own presets: nothing to read first");
  assert.equal(preset.secondary?.disabledReason, "Loading Dutch style…", "Customise needs the preset's points");
});

test("programs are grouped under their own headings in the order the groups first appear", () => {
  const groups = groupPrograms([DIY1, JAPANESE, DIY2, DUTCH, DIY3]);
  assert.deepEqual(groups.map((group) => group.label), ["Your programs", "Presets"]);
  assert.deepEqual(groups[0]!.programs.map((p) => p.id), ["diy_1", "diy_2", "diy_3"]);
  assert.deepEqual(groups[1]!.programs.map((p) => p.id), ["japanese_style", "dutch_style"]);
  assert.deepEqual(groupPrograms([]), []);
});

test("the panel opens on the running program, else on the first one", () => {
  assert.equal(initialProgram(PAWFLY, "diy_2"), "diy_2");
  assert.equal(initialProgram(PAWFLY, null), "japanese_style");
  assert.equal(initialProgram(PAWFLY, "no_such_program"), "japanese_style", "an id this light does not list is ignored");
  assert.equal(initialProgram([], "diy_2"), null);
});

test("a customised preset defaults to a slot known to be empty, else one not read yet, else the first", () => {
  const entries = new Map<string, ProgramEntry>();
  const entryOf = (id: string): ProgramEntry => entries.get(id) ?? idle;
  const slots = [DIY1, DIY2, DIY3];
  assert.equal(suggestSlot(slots, entryOf), "diy_1", "nothing known: the first slot");
  entries.set("diy_1", ready(DIY1, 6));
  assert.equal(suggestSlot(slots, entryOf), "diy_2", "DIY 1 is in use, DIY 2 is unknown");
  entries.set("diy_2", ready(DIY2, 2));
  entries.set("diy_3", ready(DIY3, 0));
  assert.equal(suggestSlot(slots, entryOf), "diy_3", "the empty slot beats an unknown one");
  entries.set("diy_3", ready(DIY3, 9));
  assert.equal(suggestSlot(slots, entryOf), "diy_1", "everything in use: start at the first");
  entries.set("diy_1", failed(DIY1, 6));
  assert.equal(suggestSlot(slots, entryOf), "diy_1");
  assert.equal(suggestSlot([], entryOf), null, "no slot to save into");
});

test("the overwrite warning names the slot and its point count only when it holds something", () => {
  assert.equal(overwriteNote("DIY 2", ready(DIY2, 6)), "Overwrites DIY 2 (6 points)");
  assert.equal(overwriteNote("DIY 1", ready(DIY1, 1)), "Overwrites DIY 1 (1 point)");
  assert.equal(overwriteNote("DIY 3", ready(DIY3, 0)), null);
  assert.equal(overwriteNote("DIY 3", idle), null, "not read: no claim either way");
  assert.equal(overwriteNote("DIY 1", failed(DIY1, 4)), "Overwrites DIY 1 (4 points)", "stale data still warns");
});

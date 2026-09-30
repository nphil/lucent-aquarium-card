/** What the Schedule tab shows for the program being viewed, and which actions it may offer.
 * Pure and light-agnostic: the panel renders exactly what these functions decide, so the
 * honest-state rules (loading, empty, stale, link down, why a button is disabled) are testable
 * without a DOM. Programs, their groups and their `editable` flag come from the adapter. */

import type { Phase, ProgramData, ScheduleProgram } from "../adapters/types.ts";
import { pointCountLabel } from "./chart-model.ts";
import type { ProgramEntry } from "./program-store.ts";

export const NOT_CONNECTED = "The light isn't connected.";

export function programName(programs: readonly ScheduleProgram[], id: string): string {
  return programs.find((program) => program.id === id)?.name ?? id;
}

export interface ProgramGroup {
  label: string;
  programs: ScheduleProgram[];
}

/** The picker's groups, in the order each group first appears in the program list. */
export function groupPrograms(programs: readonly ScheduleProgram[]): ProgramGroup[] {
  const groups: ProgramGroup[] = [];
  for (const program of programs) {
    const group = groups.find((candidate) => candidate.label === program.group);
    if (group) group.programs.push(program);
    else groups.push({ label: program.group, programs: [program] });
  }
  return groups;
}

/** What to view first: the program the light is running, else the first in the list. */
export function initialProgram(programs: readonly ScheduleProgram[], runningId: string | null): string | null {
  return programs.find((program) => program.id === runningId)?.id ?? programs[0]?.id ?? null;
}

export type ViewNotice = { kind: "error"; message: string } | { kind: "link-down" };

export type ProgramView =
  /** Nothing to show yet: the first read is under way. */
  | { kind: "loading" }
  /** The program lives on the light and the link is down: it cannot be read or changed. */
  | { kind: "link-down" }
  /** The read failed and there is nothing older to show. */
  | { kind: "error"; message: string }
  /** An editable slot that holds no points. */
  | { kind: "empty" }
  | { kind: "chart"; data: ProgramData; stale: boolean; notice: ViewNotice | null; refreshing: boolean };

const READ_FAILED = "The light did not answer.";

/** Decide what the viewed program's card shows. Old data survives a failed read or a dropped
 * link, but is marked stale (built-in presets excepted: they do not come from the light). An
 * editable program without data while the link is down is never even asked for. */
export function describeView(program: ScheduleProgram, entry: ProgramEntry, phase: Phase | null): ProgramView {
  const linkDown = phase === "unavailable";
  const failed = entry.status === "error";
  const data = entry.data;
  const emptySlot = data !== null && program.editable && data.points.length === 0;
  if (data && !emptySlot) {
    if (linkDown && data.source !== "preset") return { kind: "chart", data, stale: true, notice: { kind: "link-down" }, refreshing: false };
    if (failed) return { kind: "chart", data, stale: true, notice: { kind: "error", message: entry.error ?? READ_FAILED }, refreshing: false };
    return { kind: "chart", data, stale: false, notice: null, refreshing: entry.status === "loading" };
  }
  if (emptySlot && !linkDown && !failed) return { kind: "empty" };
  if (linkDown && (failed || program.editable)) return { kind: "link-down" };
  if (failed) return { kind: "error", message: entry.error ?? READ_FAILED };
  return { kind: "loading" };
}

export interface ActionState {
  /** Why the button is disabled; null when it can be pressed. Always shown as text. */
  disabledReason: string | null;
}

export type SecondaryKind = "edit" | "customise" | "create";

export interface ActionPlan {
  /** "Activate"; null when it is not offered (already running, or nothing to run). */
  activate: ActionState | null;
  /** "Edit" (own program), "Customise" (built-in) or "Create program" (empty slot); null when
   * this light's schedules cannot be written from the card. */
  secondary: (ActionState & { kind: SecondaryKind }) | null;
}

export interface ActionInput {
  program: ScheduleProgram;
  view: ProgramView;
  phase: Phase | null;
  /** The light is on and following this program. */
  running: boolean;
  /** Schedules can be written from the card (`ScheduleModel.save` exists). */
  canSave: boolean;
  /** Some program can hold a customised copy, so Customise has somewhere to save. */
  hasEditableTarget: boolean;
}

/** Which actions the viewed program offers, and the reason for each one that is disabled.
 * Activating, previewing and saving all need the link, so a dropped link disables them; an empty
 * slot has nothing to activate, so its only action is creating a program. */
export function planActions({ program, view, phase, running, canSave, hasEditableTarget }: ActionInput): ActionPlan {
  const linkReason = phase === "unavailable" ? NOT_CONNECTED : phase === null || phase === "loading" ? "Waiting for the light…" : null;
  const loadingReason = program.editable ? `Reading ${program.name} from the light…` : `Loading ${program.name}…`;
  const dataReason = view.kind === "chart" ? null : view.kind === "loading" ? loadingReason : `Reload ${program.name} first.`;

  const activate: ActionState | null = running || view.kind === "empty" ? null : { disabledReason: linkReason ?? (program.editable ? dataReason : null) };
  if (!canSave) return { activate, secondary: null };
  if (view.kind === "empty") return { activate, secondary: { kind: "create", disabledReason: linkReason } };
  if (program.editable) return { activate, secondary: { kind: "edit", disabledReason: linkReason ?? dataReason } };
  return { activate, secondary: hasEditableTarget ? { kind: "customise", disabledReason: linkReason ?? dataReason } : null };
}

/** The slot a customised built-in should default to: one known to be empty (nothing is
 * overwritten), else one not read yet, else the first. null when there is no slot at all. */
export function suggestSlot(slots: readonly ScheduleProgram[], entryOf: (id: string) => ProgramEntry): string | null {
  const empty = slots.find((slot) => {
    const data = entryOf(slot.id).data;
    return data !== null && data.points.length === 0;
  });
  return (empty ?? slots.find((slot) => entryOf(slot.id).data === null) ?? slots[0])?.id ?? null;
}

/** "Overwrites DIY 2 (6 points)" when the slot is known to hold something; null otherwise. */
export function overwriteNote(name: string, entry: ProgramEntry): string | null {
  const count = entry.data?.points.length ?? 0;
  return count > 0 ? `Overwrites ${name} (${pointCountLabel(count)})` : null;
}

/** The capability model every supported light is translated into.
 *
 * The card never talks to an integration directly. An ADAPTER (one per Home Assistant platform:
 * `pawfly`, `fluvalble`) reads that integration's entities and attributes into a `DeviceModel`,
 * and turns the user's intent (move a channel, pick an effect, activate a schedule) into that
 * integration's own service calls through `AdapterCommands`. The shell, hero and panels are
 * written once against these types; what a light cannot do is simply absent from its model
 * (no `effects`, no `save`, no `preview`), and the UI says so instead of faking it.
 */

import type { ChannelDef, Levels } from "../lib/channels.ts";
import type { IconName } from "../lib/icons.ts";
import type { SchedulePoint } from "../lib/points.ts";
import type { HomeAssistant } from "../types.ts";

export type Phase = "loading" | "unavailable" | "off" | "on";
export type RunKind = "manual" | "effect" | "schedule";
export type ChipKind = "positive" | "warning" | "neutral";
export type EffectMotion = "storm" | "cycle";

/** A colour for the tank glow: channel levels (aligned with the light's channels) or a plain RGB
 * for lights whose channels cannot be drawn directly (Fluval reports an approximate RGB). */
export type TankColour = { levels: Levels } | { rgb: readonly [number, number, number] };

export interface StatusChip {
  label: string;
  kind: ChipKind;
  icon: IconName;
}

export interface Status {
  /** Link and problem chips, most important first. */
  chips: readonly StatusChip[];
  /** What the light is doing, as a short phrase ("Manual colour", "Dutch style schedule"). */
  mode: string | null;
  /** One sentence for assistive technology. */
  summary: string;
}

/** A colour preset for the Colour tab: levels aligned with `DeviceModel.channels`. */
export interface Swatch {
  id: string;
  name: string;
  levels: Levels;
}

/** A built-in scene or native effect, shown as a tile. */
export interface EffectDef {
  /** What `AdapterCommands.selectEffect` receives. */
  id: string;
  name: string;
  icon: IconName;
  /** Tile art: a literal CSS colour, or "cycle" for a hue sweep ring; null for a plain tile. */
  art: string | "cycle" | null;
  /** What the tank glow shows while it runs, when the light's own status frame does not say. */
  glow?: TankColour;
  /** Some effects visibly animate on the real light; the hero can echo that when allowed. */
  motion?: EffectMotion;
  /** The colour to draw while animating (the colour the motion starts from). */
  motionTank?: TankColour;
}

export interface DemoModel {
  /** Whether the Demo can run now, and the plain reason when it cannot. */
  available: boolean;
  reason: string;
  /** What it does, in a sentence. */
  description: string;
  durationMs: number;
}

export interface EffectsModel {
  effects: readonly EffectDef[];
  runningId: string | null;
  /** Effect id that switches effects off, when the light has one ("Stop effect"). */
  offId?: string | null;
  demo: DemoModel | null;
}

export interface ScheduleProgram {
  /** Stable id, opaque to the card. */
  id: string;
  name: string;
  /** Heading of the group this program is listed under. */
  group: string;
  editable: boolean;
}

export interface ProgramData {
  id: string;
  name: string;
  /** Sorted by time, unique times. */
  points: SchedulePoint[];
  editable: boolean;
  source: "device" | "preset" | "saved" | null;
  /** Extra honest context for this program ("Sunrise 08:00, sunset 20:00"). */
  note?: string;
}

export interface SaveOutcome {
  /** What the light reports after the write. */
  points: SchedulePoint[];
  verified: boolean;
}

export interface ProgramReadOptions {
  /** The user asked to read the light again: ask the light itself, not just what the integration
   * cached. Lights that always read live may ignore it. */
  refresh?: boolean;
}

export interface ScheduleModel {
  channels: readonly ChannelDef[];
  programs: readonly ScheduleProgram[];
  /** The program the light is following now, when it is following one. */
  runningId: string | null;
  maxPoints: number;
  /** Read one program. Rejects with a human-readable message. */
  load(id: string, options?: ProgramReadOptions): Promise<ProgramData>;
  /** Write a program. Absent when this light's schedules cannot be edited from the card. */
  save?(id: string, points: readonly SchedulePoint[]): Promise<SaveOutcome>;
  /** Show levels on the light immediately while editing, then restore it. Absent when unsupported. */
  preview?: {
    show(levels: Levels): Promise<void>;
    end(): Promise<void>;
  };
  /** Starting points for a brand-new program. */
  newProgramPoints(): SchedulePoint[];
  /** Why there is no Edit, shown wherever Edit would be. */
  readOnlyNote?: string;
}

/** Named lighting programs (a light schedule plus a CO2 window, kept in the user's automation) can
 * be shown and edited for this light. The card offers them only when it was also given the
 * `program` settings. */
export interface LightingProgramsModel {
  /** The light's channels, named as it reports them ([] until it has). */
  channels: readonly ChannelDef[];
}

export interface ActionDef {
  id: string;
  label: string;
  icon: IconName;
  /** Set when the action cannot run now; shown as the reason. */
  unavailable?: string;
  run(): Promise<void>;
}

export interface Notice {
  kind: "info" | "warning";
  text: string;
}

export interface DeviceModel {
  phase: Phase;
  /** Fallback title when the card has no name of its own. */
  name: string;
  status: Status;
  /** The light has a master brightness (the hero shows the slider). */
  hasBrightness: boolean;
  /** Master brightness percent 1-100 while it is known (HA drops it while a light is off). */
  brightness: number | null;
  /** Channels the user can mix by hand ([] hides the sliders). */
  channels: readonly ChannelDef[];
  /** Current manual levels aligned with `channels`; null when the light does not report them. */
  levels: Levels | null;
  swatches: readonly Swatch[];
  running: { kind: RunKind; effectId?: string | null; scheduleId?: string | null };
  /** The light's own colour for the tank when `levels` are unknown (its colour attribute). */
  tank: TankColour | null;
  effects: EffectsModel | null;
  schedule: ScheduleModel | null;
  /** Absent when the light has no lighting programs. */
  lightingPrograms?: LightingProgramsModel;
  /** Device actions (sync the clock, return to schedule); shown in the Schedule tab. */
  actions: readonly ActionDef[];
  notices: readonly Notice[];
  /** What the tank should show right now when the status frame's colour is not what the light is
   * doing (a running scene or schedule), given the running program's points once loaded. */
  live(program: ProgramData | null, minutesOfDay: number): TankColour | null;
}

/** What the card asks a light to do. Every method rejects with a human-readable message. */
export interface AdapterCommands {
  setPower(on: boolean): Promise<void>;
  /** Master brightness, percent 1-100. Must not change the light's mode. */
  setBrightness(percent: number): Promise<void>;
  /** Write ONLY these channels (index -> percent); the others stay as they are. */
  setChannels(changes: Readonly<Record<number, number>>): Promise<void>;
  selectEffect(id: string): Promise<void>;
  playDemo(): Promise<void>;
  activateSchedule(id: string): Promise<void>;
}

export interface HassRef {
  readonly current: HomeAssistant;
}

/** One configured light, bound to a Home Assistant instance through `HassRef`. */
export interface AdapterBinding {
  readonly platform: string;
  /** Home Assistant device id when the light has one (services target it). */
  readonly deviceId: string;
  /** Entity ids whose state changes should re-render the card. */
  readonly watch: readonly string[];
  /** Key that changes when the card must forget cached programs (another light, another device). */
  readonly key: string;
  /** null while Home Assistant has no state for the light. */
  read(): DeviceModel | null;
  readonly commands: AdapterCommands;
  /** Start any asynchronous loading the light needs (channel names, schedule readback) and call
   * `onChange` when something arrives so the card re-reads. Returns a disposer. */
  connect?(onChange: () => void): () => void;
}

export interface AquariumAdapter {
  readonly platform: string;
  /** null when `entityId` is not this adapter's light. */
  bind(ref: HassRef, entityId: string): AdapterBinding | null;
  /** Every light of this platform in the registry (card editor, stub config). */
  findLights(hass: HomeAssistant): readonly string[];
}

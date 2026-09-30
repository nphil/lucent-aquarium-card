/** Adapter for the `pawfly` integration (PinYing PY4C WRGB aquarium light over Bluetooth).
 *
 * The light is one HA `light` entity plus a programme select, a mode sensor and a link sensor;
 * everything richer goes through the `pawfly.*` services. See `pawfly-data.ts` for the pure part. */

import { colourAt } from "../lib/curve.ts";
import { percentToBrightness } from "../lib/channels.ts";
import type { CallWS, HassEntityState, HomeAssistant } from "../types.ts";
import {
  DEFAULT_MAX_POINTS,
  PAWFLY_CHANNELS,
  PAWFLY_PLATFORM,
  PAWFLY_SWATCHES,
  defaultDiyPoints,
  describePawflyStatus,
  domainOf,
  effectCatalogue,
  endPreview,
  fetchProgram,
  optionForProgram,
  readPawflyState,
  resolvePawflyEntities,
  saveProgram,
  scheduleProgramsFor,
  sceneEffects,
  setChannels,
  showPreview,
  type PawflyEntities,
  type PawflyProgramInfo,
  type PawflyReading,
} from "./pawfly-data.ts";
import type { AdapterBinding, AdapterCommands, AquariumAdapter, DeviceModel, EffectsModel, HassRef, ScheduleModel } from "./types.ts";

/** How long the light's Demo runs (it replays 24 h at one hour per second). */
export const DEMO_MS = 24_000;

const NO_DEVICE = "This light is not linked to a Home Assistant device, so this can't be sent.";

function buildEffects(reading: PawflyReading): EffectsModel {
  const catalogue = effectCatalogue(reading.effectList);
  const running = reading.mode === "scene" && reading.scene !== null ? (catalogue.scenes[reading.scene] ?? null) : null;
  const programRunning = reading.phase === "on" && reading.mode === "program";
  return {
    effects: sceneEffects(catalogue.scenes, reading.sceneColours),
    runningId: running,
    demo: catalogue.demo
      ? {
          available: programRunning,
          reason: "Demo replays the running schedule. Start a schedule first.",
          description: "Replays your running schedule, one hour per second (about 24 seconds).",
          durationMs: DEMO_MS,
        }
      : null,
  };
}

function buildModel(reading: PawflyReading, entities: PawflyEntities, ref: HassRef): DeviceModel {
  const callWS: CallWS = <T>(message: Record<string, unknown>): Promise<T> => ref.current.callWS<T>(message);
  const deviceId = entities.deviceId;
  const requireDevice = (): string => {
    if (!deviceId) throw new Error(NO_DEVICE);
    return deviceId;
  };
  const programBySlug = (slug: string): PawflyProgramInfo => {
    const program = reading.programs.find((candidate) => candidate.slug === slug);
    if (!program) throw new Error(`This light has no program called ${slug}.`);
    return program;
  };

  const effects = buildEffects(reading);
  const runningProgram = reading.mode === "program" ? reading.program : null;
  const schedule: ScheduleModel = {
    channels: PAWFLY_CHANNELS,
    programs: scheduleProgramsFor(reading.programs),
    runningId: runningProgram?.slug ?? null,
    maxPoints: reading.maxPoints || DEFAULT_MAX_POINTS,
    load: async (id) => fetchProgram(callWS, requireDevice(), programBySlug(id)),
    save: async (id, points) => {
      const saved = await saveProgram(callWS, requireDevice(), programBySlug(id), points);
      return { points: saved.points, verified: saved.verified };
    },
    preview: {
      show: async (levels) => showPreview(callWS, requireDevice(), levels),
      end: async () => endPreview(callWS, requireDevice()),
    },
    newProgramPoints: defaultDiyPoints,
  };

  return {
    phase: reading.phase,
    name: reading.name,
    status: describePawflyStatus(reading),
    hasBrightness: true,
    brightness: reading.brightness,
    channels: PAWFLY_CHANNELS,
    levels: reading.mix,
    swatches: PAWFLY_SWATCHES,
    running:
      reading.mode === "scene"
        ? { kind: "effect", effectId: effects.runningId }
        : reading.mode === "program"
          ? { kind: "schedule", scheduleId: runningProgram?.slug ?? null }
          : { kind: "manual" },
    tank: null,
    effects,
    schedule,
    actions: [],
    notices: [],
    live: (program, minutes) => {
      if (reading.phase !== "on") return null;
      // The status frame only carries the last MANUAL colour outside manual mode, so the tank is
      // drawn from what the light is really doing: the scene's colours or the schedule's curve.
      if (reading.mode === "scene" && reading.scene !== null) return effects.effects[reading.scene]?.glow ?? null;
      if (reading.mode === "program" && program) return { levels: program.points.length === 0 ? [0, 0, 0, 0] : colourAt(program.points, minutes, PAWFLY_CHANNELS.length) };
      return null;
    },
  };
}

function buildCommands(ref: HassRef, entities: PawflyEntities): AdapterCommands {
  const hass = (): HomeAssistant => ref.current;
  const light = { entity_id: entities.light };
  const service = async (domain: string, name: string, data: Record<string, unknown>, target: Record<string, unknown>): Promise<void> => {
    await hass().callService(domain, name, data, target, false);
  };
  const state = (): Record<string, HassEntityState | undefined> => hass().states;
  return {
    setPower: (on) => service("light", on ? "turn_on" : "turn_off", {}, light),
    setBrightness: (percent) => service("light", "turn_on", { brightness: percentToBrightness(percent) }, light),
    setChannels: (changes) => {
      if (!entities.deviceId) return Promise.reject(new Error(NO_DEVICE));
      return setChannels(<T>(message: Record<string, unknown>) => hass().callWS<T>(message), entities.deviceId, changes);
    },
    selectEffect: (id) => service("light", "turn_on", { effect: id }, light),
    playDemo: () => {
      const demo = effectCatalogue(readEffectList(state(), entities.light)).demo;
      if (!demo) return Promise.reject(new Error("This light has no demo."));
      return service("light", "turn_on", { effect: demo }, light);
    },
    activateSchedule: (id) => {
      if (!entities.program) return Promise.reject(new Error("This light has no program selector."));
      const reading = readPawflyState(state(), entities);
      const program = reading?.programs.find((candidate) => candidate.slug === id);
      if (!program) return Promise.reject(new Error(`This light has no program called ${id}.`));
      const select = state()[entities.program];
      const options = Array.isArray(select?.attributes.options) ? select.attributes.options.filter((option): option is string => typeof option === "string") : undefined;
      return service("select", "select_option", { option: optionForProgram(program, options) }, { entity_id: entities.program });
    },
  };
}

function readEffectList(states: Record<string, HassEntityState | undefined>, light: string): string[] {
  const list = states[light]?.attributes.effect_list;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
}

export const pawflyAdapter: AquariumAdapter = {
  platform: PAWFLY_PLATFORM,

  findLights(hass) {
    return Object.values(hass.entities ?? {})
      .filter((entry) => entry.platform === PAWFLY_PLATFORM && domainOf(entry.entity_id) === "light")
      .map((entry) => entry.entity_id);
  },

  bind(ref, entityId): AdapterBinding | null {
    const entities = resolvePawflyEntities(ref.current.entities ?? {}, entityId);
    if (!entities) return null;
    return {
      platform: PAWFLY_PLATFORM,
      deviceId: entities.deviceId,
      key: `${PAWFLY_PLATFORM}:${entities.deviceId || entities.light}`,
      watch: [entities.light, entities.program, entities.mode, entities.connected].filter((id): id is string => id !== undefined),
      read() {
        const reading = readPawflyState(ref.current.states, entities);
        return reading ? buildModel(reading, entities, ref) : null;
      },
      commands: buildCommands(ref, entities),
    };
  },
};

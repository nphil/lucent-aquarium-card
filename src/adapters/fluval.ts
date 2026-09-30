/** Adapter for the `fluvalble` integration (Fluval Bluetooth aquarium LEDs).
 *
 * Manual colour goes through `fluvalble.set_channels`, modes through the `mode` select, effects
 * through the light's native effect list. Fixture schedules (Automatic sunrise/sunset ramps and
 * Professional timed points) are read through `fluvalble/get_schedule` and shown READ-ONLY: the
 * card offers no way to change them and says so. See `fluval-data.ts` for the pure part. */

import { percentToBrightness } from "../lib/channels.ts";
import type { HassEntityState } from "../types.ts";
import {
  EFFECT_NONE,
  FLUVAL_MAX_POINTS,
  FLUVAL_PLATFORM,
  READ_ONLY_NOTE,
  SET_CHANNEL_KEYS,
  channelDefs,
  describeFluvalStatus,
  domainOf,
  effectDefs,
  parseSchedulePayload,
  programFromPayload,
  readFluvalState,
  resolveFluvalEntities,
  type FluvalEntities,
  type FluvalReading,
  type SchedulePayload,
} from "./fluval-data.ts";
import type { ActionDef, AdapterBinding, AdapterCommands, AquariumAdapter, DeviceModel, HassRef, ScheduleModel } from "./types.ts";

const NO_DEVICE = "This light is not linked to a Home Assistant device, so this can't be sent.";

/** Loads and caches the fixture's schedule readback for one light. */
class ScheduleSource {
  /** The last usable readback: it carries the channel names, so it outlives any one binding. */
  payload: SchedulePayload | null = null;
  private inflight: { promise: Promise<SchedulePayload | null>; refresh: boolean } | null = null;

  constructor(
    private readonly ref: HassRef,
    private readonly deviceId: string,
  ) {}

  private get entryId(): string | undefined {
    return this.ref.current.devices?.[this.deviceId]?.config_entries?.[0];
  }

  /** Read the schedules. `refresh` asks the light itself to read them again (over Bluetooth)
   * instead of returning what the integration last read. A read that is already under way is
   * shared, unless it would not ask the light and this one must: that one waits for it, then asks. */
  load(refresh = false): Promise<SchedulePayload | null> {
    const running = this.inflight;
    if (running && (running.refresh || !refresh)) return running.promise;
    const start = (): Promise<SchedulePayload | null> => this.fetch(refresh);
    const promise = running ? running.promise.then(start, start) : start();
    const entry = { promise, refresh };
    this.inflight = entry;
    const done = (): void => {
      if (this.inflight === entry) this.inflight = null;
    };
    promise.then(done, done);
    return promise;
  }

  private fetch(refresh: boolean): Promise<SchedulePayload | null> {
    const entryId = this.entryId;
    if (!entryId) return Promise.reject(new Error(NO_DEVICE));
    return this.ref.current.callWS<unknown>({ type: "fluvalble/get_schedule", entry_id: entryId, refresh }).then((raw) => {
      const parsed = parseSchedulePayload(raw);
      if (parsed) this.payload = parsed;
      return parsed;
    });
  }
}

const SOURCES = new WeakMap<HassRef, Map<string, ScheduleSource>>();

/** One source per light and per card, so registry changes (which re-bind the light) do not throw
 * away the channel names and make the Colour tab disappear until they are read again. */
function sourceFor(ref: HassRef, entities: FluvalEntities): ScheduleSource {
  let sources = SOURCES.get(ref);
  if (!sources) {
    sources = new Map();
    SOURCES.set(ref, sources);
  }
  const key = entities.deviceId || entities.light;
  let source = sources.get(key);
  if (!source) {
    source = new ScheduleSource(ref, entities.deviceId);
    sources.set(key, source);
  }
  return source;
}

function buildModel(reading: FluvalReading, entities: FluvalEntities, ref: HassRef, source: ScheduleSource): DeviceModel {
  const channels = channelDefs(source.payload?.channels ?? []);
  const press = (entity: string | undefined): (() => Promise<void>) => async () => {
    if (!entity) throw new Error("This light has no such button.");
    await ref.current.callService("button", "press", {}, { entity_id: entity }, false);
  };

  const effects = effectDefs(reading.effectList);
  const scheduleRunning = reading.mode === "automatic" || reading.mode === "professional";
  const schedule: ScheduleModel = {
    channels,
    programs: [
      { id: "automatic", name: "Automatic", group: "Fluval schedules", editable: false },
      { id: "professional", name: "Professional", group: "Fluval schedules", editable: false },
    ],
    runningId: scheduleRunning ? reading.mode : null,
    maxPoints: FLUVAL_MAX_POINTS,
    load: async (id, options) => {
      const refresh = options?.refresh === true;
      const payload = await source.load(refresh);
      if (!payload) throw new Error("The light has not reported its schedules yet.");
      // The integration answers with what it last read when the light does not respond; a
      // reload the user asked for must not pass that off as fresh.
      if (refresh && payload.refreshOk === false) throw new Error("The light didn't answer the refresh.");
      return programFromPayload(id, payload);
    },
    newProgramPoints: () => [],
    readOnlyNote: READ_ONLY_NOTE,
  };

  const actions: ActionDef[] = [];
  if (entities.syncClock) actions.push({ id: "sync-clock", label: "Sync the light's clock", icon: "clockCheck", run: press(entities.syncClock) });
  if (entities.returnToSchedule) {
    actions.push({
      id: "return-to-schedule",
      label: "Return to schedule",
      icon: "calendarSync",
      ...(reading.overrideActive ? {} : { unavailable: "No manual override is active." }),
      run: press(entities.returnToSchedule),
    });
  }

  const running = reading.effect ? { kind: "effect" as const, effectId: reading.effect } : scheduleRunning ? { kind: "schedule" as const, scheduleId: reading.mode } : { kind: "manual" as const };
  return {
    phase: reading.phase,
    name: reading.name,
    status: describeFluvalStatus(reading),
    hasBrightness: true,
    brightness: reading.brightness,
    channels,
    levels: reading.scheduledLevels && reading.scheduledLevels.length === channels.length ? reading.scheduledLevels : null,
    swatches: [],
    running,
    tank: reading.rgb ? { rgb: reading.rgb } : null,
    effects: effects.length > 0 ? { effects, runningId: reading.effect, offId: EFFECT_NONE, demo: null } : null,
    schedule,
    actions,
    notices: channels.length > 0 ? [{ kind: "info", text: "This light does not report its channel levels in manual mode, so the sliders show what you set here." }] : [],
    live: () => {
      if (reading.phase !== "on") return null;
      const running = effects.find((effect) => effect.id === reading.effect);
      if (running?.glow) return running.glow;
      if (scheduleRunning && reading.scheduledLevels && reading.scheduledLevels.length === channels.length) return { levels: reading.scheduledLevels };
      return null;
    },
  };
}

function buildCommands(ref: HassRef, entities: FluvalEntities): AdapterCommands {
  const service = async (domain: string, name: string, data: Record<string, unknown>, target: Record<string, unknown>): Promise<void> => {
    await ref.current.callService(domain, name, data, target, false);
  };
  const light = { entity_id: entities.light };
  return {
    setPower: (on) => service("light", on ? "turn_on" : "turn_off", {}, light),
    setBrightness: (percent) => service("light", "turn_on", { brightness: percentToBrightness(percent) }, light),
    setChannels: async (changes) => {
      if (!entities.deviceId) throw new Error(NO_DEVICE);
      const data: Record<string, unknown> = { device_id: entities.deviceId };
      for (const [index, value] of Object.entries(changes)) {
        const key = SET_CHANNEL_KEYS[Number(index)];
        if (key) data[key] = Math.round(value);
      }
      await service("fluvalble", "set_channels", data, {});
    },
    selectEffect: (id) => service("light", "turn_on", { effect: id }, light),
    playDemo: () => Promise.reject(new Error("This light has no demo.")),
    activateSchedule: async (id) => {
      if (!entities.mode) throw new Error("This light has no mode selector.");
      await service("select", "select_option", { option: id }, { entity_id: entities.mode });
    },
  };
}

export const fluvalAdapter: AquariumAdapter = {
  platform: FLUVAL_PLATFORM,

  findLights(hass) {
    return Object.values(hass.entities ?? {})
      .filter((entry) => entry.platform === FLUVAL_PLATFORM && domainOf(entry.entity_id) === "light")
      .map((entry) => entry.entity_id);
  },

  bind(ref, entityId): AdapterBinding | null {
    const entities = resolveFluvalEntities(ref.current.entities ?? {}, entityId);
    if (!entities) return null;
    const source = sourceFor(ref, entities);
    const states = (): Record<string, HassEntityState | undefined> => ref.current.states;
    return {
      platform: FLUVAL_PLATFORM,
      deviceId: entities.deviceId,
      key: `${FLUVAL_PLATFORM}:${entities.deviceId || entities.light}`,
      watch: [entities.light, entities.mode, entities.connection, entities.scheduleProblem].filter((id): id is string => id !== undefined),
      read() {
        const reading = readFluvalState(states(), entities);
        return reading ? buildModel(reading, entities, ref, source) : null;
      },
      commands: buildCommands(ref, entities),
      connect(onChange) {
        let live = true;
        if (entities.deviceId && !source.payload) {
          source
            .load(false)
            .then(() => live && onChange())
            .catch(() => undefined);
        }
        return () => {
          live = false;
        };
      },
    };
  },
};

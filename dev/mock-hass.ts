/** Stateful fake `hass` for the dev harness: emulates the `pawfly` integration contract
 * (light/select/sensor/binary_sensor states, `light.*`/`select.*` services and
 * the `pawfly.get_program|set_program|set_channel|preview` services over `callWS`). Every change builds a
 * NEW hass object (like real HA) and notifies subscribers.
 */
import type { HassEntityState, HomeAssistant } from "../src/types.ts";

/** One point as the `pawfly.get_program` / `set_program` services carry it. */
export interface ServiceProgramPoint {
  time: string;
  red: number;
  green: number;
  blue: number;
  white: number;
}

export interface GetProgramResponse {
  program: number;
  slug: string;
  name: string;
  source: "device" | "preset";
  editable: boolean;
  points: ServiceProgramPoint[];
}

export const DEVICE_ID = "dev_pawfly_1";
export const DEVICE_NAME = "Plant Room Aquarium Accent Light";
const SLUG = "plant_room_aquarium_accent_light";
export const LIGHT = `light.${SLUG}`;
export const SELECT = `select.${SLUG}_program`;
export const MODE_SENSOR = `sensor.${SLUG}_mode`;
export const CONNECTED = `binary_sensor.${SLUG}_connected`;
export const RELEASE = `button.${SLUG}_release_link`;

/** Status colour in scene mode = the vendor app's scene mirror colours (backend contract). */
const SCENE_MIRROR: Array<[number, number, number, number]> = [[30, 30, 30, 30], [0, 0, 0, 0], [100, 100, 100, 100], [0, 10, 100, 0], [100, 0, 0, 100], [0, 0, 100, 100], [0, 0, 0, 100], [100, 100, 100, 0]];

export const EFFECT_LIST = ["Cloudy", "Thunderstorm", "Sunny", "Moonlight", "Warm white", "Bright white", "Day", "RGB cycle", "Demo"];
export const PROGRAM_OPTIONS = ["manual", "japanese_style", "dutch_style", "jungle_style", "diy_1", "diy_2", "diy_3"];
const PROGRAM_SLUGS = PROGRAM_OPTIONS.slice(1);
const PROGRAM_NAMES = ["Japanese style", "Dutch style", "Jungle style", "DIY 1", "DIY 2", "DIY 3"];

export type Scenario = "on" | "off" | "unavailable" | "scene" | "program";
export type Mode = "manual" | "scene" | "program";
export type Pt = ServiceProgramPoint;
export interface ServiceError { code: string; message: string }

export interface MockOptions { scenario?: Scenario; latency?: number; setProgramLatency?: number }

export interface CallRecord {
  t: number;
  kind: "service" | "ws";
  domain: string;
  service: string;
  data: Record<string, unknown>;
  target?: Record<string, unknown>;
}

export interface LightView {
  on: boolean;
  unavailable: boolean;
  brightnessPct: number;
  rgbwPct: [number, number, number, number];
  mode: Mode;
  program: number | null;
  scenario: number | null;
  effect: string | null;
}

const p = (time: string, red: number, green = red, blue = red, white = red): Pt => ({ time, red, green, blue, white });
const P = (time: string, r: number, g: number, b: number, w: number) => p(time, r, g, b, w);

const PRESETS: Pt[][] = [
  [P("07:00", 0, 0, 0, 0), p("07:15", 70), p("08:00", 70), p("08:15", 100), p("15:00", 100), p("15:15", 70), p("18:00", 70), P("18:15", 0, 0, 100, 0), P("22:00", 0, 0, 100, 0), P("22:15", 0, 0, 0, 0)],
  [P("06:00", 0, 0, 0, 0), P("08:00", 50, 12, 3, 15), P("09:00", 65, 30, 20, 50), P("11:00", 100, 0, 0, 100), p("13:00", 100), P("16:00", 70, 70, 100, 100), p("17:00", 50), P("18:00", 50, 10, 10, 10), P("19:00", 0, 50, 100, 0), P("22:00", 0, 0, 0, 0)],
  [P("08:00", 0, 0, 0, 0), P("08:30", 100, 50, 10, 10), p("09:00", 100), p("17:00", 100), P("18:00", 100, 50, 15, 0), P("19:00", 0, 50, 100, 0), P("22:00", 0, 0, 0, 0)],
];

const tmin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const sortPts = (pts: Pt[]) => pts.map((x) => ({ ...x })).sort((a, b) => tmin(a.time) - tmin(b.time));
const pct = (v255: number) => Math.round((v255 * 100) / 255);
const to255 = (v: number) => Math.round(v * 2.55);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const svcErr = (message: string): ServiceError => ({ code: "service_validation_error", message });

export interface MockController {
  calls: CallRecord[];
  previewLog: { t: number; payload: Record<string, unknown> }[];
  readonly previewActive: boolean;
  getState(): LightView;
  setScenario(name: Scenario): void;
  patchLight(partial: Partial<LightView>): void;
  setUnavailable(v: boolean): void;
  setLatency(ms: number): void;
  setProgramPoints(index: number, points: Pt[]): void;
  failNext(key: string, error: ServiceError, count?: number): void;
  /** `performance.now()` deadline of a running Demo (24 s), or null. */
  readonly demoUntil: number | null;
}

export interface MockHass {
  hass: HomeAssistant;
  controller: MockController;
  current(): HomeAssistant;
  subscribe(fn: (h: HomeAssistant) => void): () => void;
}

export function createMockHass(options: MockOptions = {}): MockHass {
  let latency = options.latency ?? 120;
  const setProgramLatency = options.setProgramLatency ?? 1800;
  const scenario = options.scenario ?? "on";

  const view: LightView = {
    on: true, unavailable: false, brightnessPct: 80, rgbwPct: [60, 40, 90, 30],
    mode: "manual", program: null, scenario: null, effect: null,
  };
  const diy: Pt[][] = [
    [P("06:00", 0, 0, 0, 0), P("08:00", 20, 10, 5, 20), P("10:00", 60, 40, 20, 60), P("12:00", 100, 80, 60, 100), P("15:00", 100, 90, 70, 100), P("18:00", 60, 30, 40, 40), P("20:00", 10, 5, 40, 0), P("22:30", 0, 0, 0, 0)],
    ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00", "00:00"].map((t) => P(t, 0, 0, 0, 0)),
    [],
  ].map(sortPts);

  const calls: CallRecord[] = [];
  const previewLog: { t: number; payload: Record<string, unknown> }[] = [];
  const failures = new Map<string, { error: ServiceError; count: number }>();
  const subscribers = new Set<(h: HomeAssistant) => void>();
  let demoUntil: number | null = null;
  let previewActive = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const entities: HomeAssistant["entities"] = {};
  const reg = (entity_id: string, translation_key: string | null, entity_category: string | null = null) => {
    entities[entity_id] = { entity_id, device_id: DEVICE_ID, platform: "pawfly", translation_key, name: null, hidden: false, entity_category };
  };
  reg(LIGHT, null);
  reg(SELECT, "program");
  reg(MODE_SENSOR, "mode", "diagnostic");
  reg(CONNECTED, "connected", "diagnostic");
  reg(RELEASE, "release_link", "config");

  const now = () => new Date().toISOString();
  const st = (entity_id: string, state: string, attributes: Record<string, unknown>): HassEntityState =>
    ({ entity_id, state, attributes, last_changed: now(), last_updated: now() });

  function buildStates(): Record<string, HassEntityState> {
    const v = view;
    const base = {
      friendly_name: DEVICE_NAME,
      supported_color_modes: ["rgbw"],
      effect_list: EFFECT_LIST,
      programs: PROGRAM_SLUGS.map((slug, program) => ({ program, slug, name: PROGRAM_NAMES[program], editable: program >= 3 })),
      scene_colors: Object.fromEntries(EFFECT_LIST.slice(0, 8).map((name, index) => [name, SCENE_MIRROR[index]])),
      max_program_points: 12,
    };
    let light: HassEntityState;
    if (v.unavailable) light = st(LIGHT, "unavailable", { ...base });
    else {
      const extras = {
        mode: v.mode, program: v.program, program_name: v.program === null ? null : PROGRAM_NAMES[v.program] ?? null, scenario: v.scenario,
      };
      if (!v.on) light = st(LIGHT, "off", { ...base, ...extras });
      else {
        light = st(LIGHT, "on", {
          ...base, ...extras,
          brightness: clamp(to255(v.brightnessPct), 1, 255),
          rgbw_color: v.rgbwPct.map(to255),
          color_mode: "rgbw",
          effect: v.mode === "scene" && v.scenario !== null ? EFFECT_LIST[v.scenario] ?? null : null,
        });
      }
    }
    const un = v.unavailable;
    const selState = un ? "unavailable" : v.mode === "manual" ? "manual" : v.mode === "program" && v.program !== null ? PROGRAM_SLUGS[v.program]! : "unknown";
    return {
      [LIGHT]: light,
      [SELECT]: st(SELECT, selState, { options: PROGRAM_OPTIONS, friendly_name: `${DEVICE_NAME} Program` }),
      [MODE_SENSOR]: st(MODE_SENSOR, un ? "unavailable" : v.mode, { friendly_name: `${DEVICE_NAME} Mode` }),
      [CONNECTED]: st(CONNECTED, un ? "off" : "on", { device_class: "connectivity", friendly_name: `${DEVICE_NAME} Connected` }),
      [RELEASE]: st(RELEASE, "unknown", { friendly_name: `${DEVICE_NAME} Release link` }),
    };
  }

  let hass: HomeAssistant;
  const rebuild = () => {
    hass = { ...hass, states: buildStates() };
    for (const fn of [...subscribers]) fn(hass);
  };

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  function takeFailure(key: string): ServiceError | undefined {
    const f = failures.get(key);
    if (!f) return undefined;
    if (--f.count <= 0) failures.delete(key);
    return f.error;
  }

  const idsOf = (target?: Record<string, unknown>): string[] => {
    const e = target?.entity_id;
    return Array.isArray(e) ? (e as string[]) : typeof e === "string" ? [e] : [];
  };

  function setManual() { view.mode = "manual"; view.program = null; view.scenario = null; view.effect = null; }

  function lightTurnOn(d: Record<string, unknown>) {
    if (view.unavailable) throw { code: "home_assistant_error", message: "The light is not connected" };
    if (typeof d.effect === "string") {
      const idx = EFFECT_LIST.indexOf(d.effect);
      if (idx < 0) throw svcErr(`Effect ${d.effect} is not valid`);
      if (d.effect === "Demo") {
        if (view.mode !== "program") throw svcErr("Demo only works while a schedule is running");
        demoUntil = performance.now() + 24_000;
      } else {
        view.mode = "scene"; view.scenario = idx; view.effect = d.effect; view.program = null;
        view.rgbwPct = [...(SCENE_MIRROR[idx] ?? view.rgbwPct)] as typeof view.rgbwPct;
        demoUntil = null;
      }
    } else if (d.rgbw_color !== undefined || d.brightness !== undefined) {
      if (Array.isArray(d.rgbw_color)) {
        const c = d.rgbw_color as number[];
        view.rgbwPct = [0, 1, 2, 3].map((i) => pct(clamp(Number(c[i] ?? 0), 0, 255))) as LightView["rgbwPct"];
      }
      if (d.brightness !== undefined) view.brightnessPct = Math.max(1, pct(clamp(Number(d.brightness), 0, 255)));
      setManual();
      demoUntil = null;
    }
    view.on = true;
  }

  function selectOption(d: Record<string, unknown>) {
    if (view.unavailable) throw { code: "home_assistant_error", message: "The light is not connected" };
    const o = String(d.option);
    if (!PROGRAM_OPTIONS.includes(o)) throw svcErr(`Option ${o} is not valid`);
    if (o === "manual") setManual();
    else { view.mode = "program"; view.program = PROGRAM_SLUGS.indexOf(o); view.scenario = null; view.effect = null; view.on = true; }
    demoUntil = null;
  }

  async function callService(domain: string, service: string, data: Record<string, unknown> = {}, target?: Record<string, unknown>): Promise<unknown> {
    calls.push({ t: performance.now(), kind: "service", domain, service, data: structuredClone(data), target: target && structuredClone(target) });
    await delay(latency);
    const key = `${domain}.${service}`;
    const fail = takeFailure(key);
    if (fail) throw fail;
    const ids = idsOf(target);
    const merged = { ...data };
    const hits = (id: string) => ids.length === 0 || ids.includes(id);
    if (domain === "light" && service === "turn_on" && hits(LIGHT)) lightTurnOn(merged);
    else if (domain === "light" && service === "turn_off" && hits(LIGHT)) { if (!view.unavailable) { view.on = false; demoUntil = null; } }
    else if (domain === "light" && service === "toggle" && hits(LIGHT)) { if (view.on) { view.on = false; demoUntil = null; } else lightTurnOn(merged); }
    else if (domain === "select" && service === "select_option" && ids.includes(SELECT)) selectOption(merged);
    else if (domain === "button" && ids.includes(RELEASE)) { /* no-op */ }
    else throw { code: "service_not_found", message: `Service ${key} not found` } satisfies ServiceError;
    rebuild();
    return { context: { id: "x" } };
  }

  function progIndex(v: unknown): number {
    if (typeof v === "number" && v >= 0 && v <= 5) return v;
    const i = typeof v === "string" ? PROGRAM_SLUGS.indexOf(v) : -1;
    if (i < 0) throw svcErr(`Unknown program ${String(v)}`);
    return i;
  }
  const notConnected = (): ServiceError => ({ code: "home_assistant_error", message: "The light is not connected" });

  function getProgram(d: Record<string, unknown>): GetProgramResponse {
    const i = progIndex(d.program);
    if (i < 3) return { program: i, slug: PROGRAM_SLUGS[i]!, name: PROGRAM_NAMES[i]!, source: "preset", editable: false, points: sortPts(PRESETS[i]!) };
    if (view.unavailable) throw notConnected();
    return { program: i, slug: PROGRAM_SLUGS[i]!, name: PROGRAM_NAMES[i]!, source: "device", editable: true, points: sortPts(diy[i - 3]!) };
  }

  async function setProgram(d: Record<string, unknown>) {
    const i = progIndex(d.program);
    if (i < 3) throw svcErr("Presets are read-only");
    const pts = d.points;
    if (!Array.isArray(pts)) throw svcErr("points must be a list");
    if (pts.length > 12) throw svcErr("A program holds at most 12 points");
    const seen = new Set<string>();
    for (const raw of pts as Pt[]) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time))) throw svcErr(`Invalid time ${String(raw.time)}`);
      if (seen.has(raw.time)) throw svcErr(`Duplicate time ${raw.time}`);
      seen.add(raw.time);
      for (const ch of ["red", "green", "blue", "white"] as const) {
        const val = raw[ch];
        if (!Number.isInteger(val) || val < 0 || val > 100) throw svcErr(`${ch} must be a whole number from 0 to 100 (got ${String(val)})`);
      }
    }
    if (view.unavailable) throw notConnected();
    await delay(setProgramLatency);
    diy[i - 3] = sortPts(pts as Pt[]);
    return { program: i, name: PROGRAM_NAMES[i]!, count: pts.length, verified: true, points: sortPts(diy[i - 3]!) };
  }

  function setChannel(d: Record<string, unknown>) {
    const keys = ["red", "green", "blue", "white"] as const;
    const given = keys.filter((k) => d[k] !== undefined && d[k] !== null);
    if (given.length === 0) throw svcErr("Give at least one channel");
    for (const k of given) {
      const val = d[k];
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 100) throw svcErr(`${k} must be a whole number from 0 to 100 (got ${String(val)})`);
    }
    if (view.unavailable) throw notConnected();
    keys.forEach((k, i) => { if (given.includes(k)) view.rgbwPct[i] = d[k] as number; });
    setManual();
    demoUntil = null;
    view.on = true;
    rebuild();
    return {};
  }

  function preview(d: Record<string, unknown>) {
    previewLog.push({ t: performance.now(), payload: structuredClone(d) });
    clearTimeout(previewTimer);
    if (d.end === true) previewActive = false;
    else {
      previewActive = true;
      previewTimer = setTimeout(() => { previewActive = false; }, 30_000);
    }
    return {};
  }

  async function callWS<T = unknown>(msg: Record<string, unknown>): Promise<T> {
    const domain = String(msg.domain ?? "");
    const service = String(msg.service ?? "");
    const data = (msg.service_data ?? {}) as Record<string, unknown>;
    calls.push({ t: performance.now(), kind: "ws", domain, service, data: structuredClone(data) });
    if (msg.type !== "call_service") throw { code: "unknown_command", message: `Unknown command ${String(msg.type)}` } satisfies ServiceError;
    const isPreview = domain === "pawfly" && service === "preview";
    await delay(isPreview ? 5 : latency);
    const fail = takeFailure(`${domain}.${service}`);
    if (fail) throw fail;
    if (domain !== "pawfly") throw { code: "service_not_found", message: `Service ${domain}.${service} not found` } satisfies ServiceError;
    let response: unknown;
    switch (service) {
      case "get_program": response = getProgram(data); break;
      case "set_program": response = await setProgram(data); break;
      case "preview": response = preview(data); break;
      case "set_channel": response = setChannel(data); break;
      case "sync_time": case "release_link": response = {}; break;
      default: throw { code: "service_not_found", message: `Service pawfly.${service} not found` } satisfies ServiceError;
    }
    return (msg.return_response ? { context: { id: "x" }, response } : { context: { id: "x" } }) as T;
  }

  hass = {
    states: {}, entities, devices: {
      [DEVICE_ID]: { id: DEVICE_ID, name: DEVICE_NAME, name_by_user: null, manufacturer: "Dongguan PinYing", model: "PY4C-BT-PSTL" },
    },
    themes: { darkMode: true }, language: "en", locale: { language: "en" }, config: { time_zone: "Europe/London" },
    callService: callService as HomeAssistant["callService"],
    callWS: callWS as HomeAssistant["callWS"],
  };

  const controller: MockController = {
    calls,
    previewLog,
    get previewActive() { return previewActive; },
    getState: (): LightView => ({ ...view, rgbwPct: [...view.rgbwPct] as LightView["rgbwPct"] }),
    setScenario(name: Scenario) {
      view.unavailable = name === "unavailable";
      view.on = name !== "off";
      if (name === "scene") { view.mode = "scene"; view.scenario = 2; view.effect = EFFECT_LIST[2]!; view.program = null; view.rgbwPct = [...SCENE_MIRROR[2]!] as typeof view.rgbwPct; }
      else if (name === "program") { view.mode = "program"; view.program = 1; view.scenario = null; view.effect = null; }
      else if (name !== "unavailable") setManual();
      rebuild();
    },
    patchLight(partial: Partial<LightView>) { Object.assign(view, partial); rebuild(); },
    setUnavailable(v: boolean) { view.unavailable = v; rebuild(); },
    setLatency(ms: number) { latency = ms; },
    setProgramPoints(index: number, points: Pt[]) { diy[index - 3] = sortPts(points); },
    failNext(key: string, error: ServiceError, count = 1) { failures.set(key, { error, count }); },
    get demoUntil() { return demoUntil; },
  };
  controller.setScenario(scenario);
  hass = { ...hass, states: buildStates() };

  return {
    hass,
    controller,
    /** Current hass (a new object after every change). */
    current: () => hass,
    subscribe(fn: (h: HomeAssistant) => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
  };
}


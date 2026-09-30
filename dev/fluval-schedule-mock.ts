/** A stand-in for a light whose schedules the card can only READ (the Fluval case): five named
 * emitters, two native programs, no `save`, no `preview`, and an honest note saying why. It exists
 * so the Schedule tab's read-only path (channel-generic chart, values table, program picker,
 * disabled reasons) can be looked at and driven in the dev harness without the real integration. */
import type { ProgramData, ScheduleModel } from "../src/adapters/types.ts";
import type { ChannelDef } from "../src/lib/channels.ts";
import type { SchedulePoint } from "../src/lib/points.ts";

export const FLUVAL_LIKE_CHANNELS: readonly ChannelDef[] = [
  { id: "pink", name: "Pink", short: "PK", colour: "#ff7fb0", light: [1, 0.3, 0.5] },
  { id: "blue", name: "Blue", short: "B", colour: "#3f7bff", light: [0, 0.2, 1] },
  { id: "cold", name: "Cold white", short: "CW", colour: "#dcecff", light: [0.8, 0.9, 1] },
  { id: "white", name: "White", short: "W", colour: "#fffdf5", light: [1, 1, 1] },
  { id: "warm", name: "Warm white", short: "WW", colour: "#ffd9a0", light: [1, 0.8, 0.5] },
];

const p = (time: string, ...levels: number[]): SchedulePoint => ({ minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), levels });

const AUTOMATIC: ProgramData = {
  id: "automatic",
  name: "Automatic",
  editable: false,
  source: "device",
  note: "Sunrise 07:00, sunset 20:30. The light ramps its own sunrise and sunset.",
  points: [p("07:00", 0, 0, 0, 0, 0), p("08:30", 20, 35, 30, 10, 45), p("12:00", 60, 80, 90, 85, 70), p("17:00", 60, 80, 90, 85, 70), p("19:00", 35, 50, 20, 15, 60), p("20:30", 0, 0, 0, 0, 0)],
};

const PROFESSIONAL: ProgramData = {
  id: "professional",
  name: "Professional",
  editable: false,
  source: "device",
  note: "Timed points set in the Fluval app.",
  points: [p("06:00", 0, 0, 0, 0, 0), p("08:00", 10, 40, 10, 0, 20), p("10:00", 45, 70, 60, 50, 40), p("13:00", 70, 90, 100, 90, 60), p("16:00", 50, 75, 70, 60, 50), p("18:30", 25, 45, 10, 5, 55), p("21:00", 0, 12, 0, 0, 0), p("22:30", 0, 0, 0, 0, 0)],
};

export interface FluvalMock {
  schedule(): ScheduleModel;
  /** Make the next `count` reads fail with `message`. */
  failNext(message: string, count?: number): void;
  setRunning(id: string | null): void;
  setReachable(reachable: boolean): void;
  readonly loads: string[];
}

export function createFluvalMock(latencyMs = 250): FluvalMock {
  let running: string | null = null;
  let reachable = true;
  let failure: { message: string; count: number } | null = null;
  const loads: string[] = [];
  const data = new Map([AUTOMATIC, PROFESSIONAL].map((program) => [program.id, program]));

  return {
    loads,
    failNext(message, count = 1) {
      failure = { message, count };
    },
    setRunning(id) {
      running = id;
    },
    setReachable(value) {
      reachable = value;
    },
    schedule: () => ({
      channels: FLUVAL_LIKE_CHANNELS,
      programs: [
        { id: "automatic", name: "Automatic", group: "Fluval schedules", editable: false },
        { id: "professional", name: "Professional", group: "Fluval schedules", editable: false },
      ],
      runningId: running,
      maxPoints: 16,
      load: async (id) => {
        loads.push(id);
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
        if (failure) {
          const { message } = failure;
          if (--failure.count <= 0) failure = null;
          throw new Error(message);
        }
        if (!reachable) throw new Error("The light isn't connected.");
        const program = data.get(id);
        if (!program) throw new Error(`This light has no schedule called ${id}.`);
        return structuredClone(program);
      },
      newProgramPoints: () => [],
      readOnlyNote: "Editing Fluval schedules from this card isn't supported yet. Change them in the Fluval app; this card shows what the light is set to.",
    }),
  };
}

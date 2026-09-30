/** Isolated harness for the Schedule tab: mounts one `<aquarium-schedule-panel>` inside the
 * `ha-card` shim, wired the way the card wires it (a `DeviceModel` from an adapter, a shared
 * `ProgramStore`, toasts through `lu-toast`, activation through the adapter's commands).
 *
 * Query: theme=dark|light|glass-dark|glass-light, width=<px>, state=on|off|unavailable|scene|program,
 * program=<id or index 0-5> (the program to view), edit=1 (open the editor as soon as it can be),
 * latency=<ms> (mock service latency), device=pawfly|fluval (fluval = read-only five-channel light),
 * actions=1 (add sample device actions), active=0 (tab hidden), fail=<n> (the first n program
 * reads fail).
 * `window.__mock` exposes the pieces for scripted checks. */
import "./ha-card-shim.ts";
import "../src/components/lu-toast.ts";
import "../src/components/aquarium-schedule-panel.ts";
import { bindLight } from "../src/adapters/index.ts";
import type { ActionDef, HassRef } from "../src/adapters/types.ts";
import type { LuToast, ToastRequest } from "../src/components/lu-toast.ts";
import type { AquariumSchedulePanel, ScheduleDevice } from "../src/components/aquarium-schedule-panel.ts";
import { describeError } from "../src/lib/errors.ts";
import { ProgramStore } from "../src/lib/program-store.ts";
import { createFluvalMock, type FluvalMock } from "./fluval-schedule-mock.ts";
import { createMockHass, LIGHT, type MockController, type Scenario } from "./mock-hass.ts";
import { applyTheme } from "./themes.ts";

interface HarnessHandle {
  panel: AquariumSchedulePanel;
  store: ProgramStore;
  /** Pawfly device: the stateful fake hass controller (`previewLog`, `calls`, `failNext`, ...). */
  controller: MockController | null;
  fluval: FluvalMock | null;
  hass: () => unknown;
  toasts: ToastRequest[];
  activated: string[];
  actionRuns: string[];
  device: () => ScheduleDevice | null;
}

const SCENARIOS = ["on", "off", "unavailable", "scene", "program"];

function sampleActions(log: string[]): ActionDef[] {
  return [
    { id: "sync", label: "Sync the clock", icon: "clock", run: async () => void log.push("sync") },
    { id: "return", label: "Return to schedule", icon: "refresh", unavailable: "The light is not following a schedule.", run: async () => void log.push("return") },
  ];
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const width = Number(q.get("width")) || 375;
  const state = (SCENARIOS.includes(q.get("state") ?? "") ? q.get("state") : "on") as Scenario;
  const latency = q.get("latency");
  const device = q.get("device") === "fluval" ? "fluval" : "pawfly";
  const failures = Number(q.get("fail")) || 0;
  const themeName = q.get("theme") ?? "dark";
  applyTheme(themeName);

  const wrap = document.getElementById("wrap");
  if (!wrap) throw new Error("harness: #wrap missing");
  wrap.style.cssText = `width:${width}px;max-width:100%`;

  const card = document.createElement("ha-card");
  const frame = document.createElement("div");
  frame.className = "frame";
  const panel = document.createElement("aquarium-schedule-panel");
  const toast = document.createElement("lu-toast") as LuToast;
  frame.append(panel);
  card.append(frame, toast);
  wrap.append(card);

  const toasts: ToastRequest[] = [];
  const activated: string[] = [];
  const actionRuns: string[] = [];
  card.addEventListener("aquarium-toast", (event) => {
    event.stopPropagation();
    const request = (event as CustomEvent<ToastRequest>).detail;
    toasts.push(request);
    toast.enqueue(request);
  });

  let activating = false;
  let read: () => ScheduleDevice | null;
  let controller: MockController | null = null;
  let fluval: FluvalMock | null = null;
  let hassNow: () => unknown = () => null;
  let activate: (id: string) => Promise<void>;

  if (device === "fluval") {
    fluval = createFluvalMock(latency ? Number(latency) : 250);
    const mock = fluval;
    let phase: "on" | "off" | "unavailable" = state === "unavailable" ? "unavailable" : state === "off" ? "off" : "on";
    if (state === "program") mock.setRunning("professional");
    if (failures > 0) mock.failNext("The light did not answer in time.", failures);
    mock.setReachable(phase !== "unavailable");
    read = () => ({
      phase,
      schedule: mock.schedule(),
      running: mock.schedule().runningId === null ? { kind: "manual" } : { kind: "schedule", scheduleId: mock.schedule().runningId },
      actions: q.get("actions") === "1" ? sampleActions(actionRuns) : [],
    });
    activate = async (id) => {
      mock.setRunning(id);
      phase = "on";
    };
    Object.assign(window, {
      __phase: (next: "on" | "off" | "unavailable") => {
        phase = next;
        mock.setReachable(next !== "unavailable");
        update();
      },
    });
  } else {
    const mock = createMockHass({ scenario: state, ...(latency ? { latency: Number(latency) } : {}) });
    controller = mock.controller;
    hassNow = mock.current;
    if (failures > 0) controller.failNext("pawfly.get_program", { code: "home_assistant_error", message: "The light did not answer in time." }, failures);
    const ref: HassRef = { get current() { return mock.current(); } };
    const binding = bindLight(ref, LIGHT);
    if (!binding) throw new Error("harness: the pawfly adapter did not bind the mock light");
    read = () => {
      const model = binding.read();
      return model ? { phase: model.phase, schedule: model.schedule, running: model.running, actions: q.get("actions") === "1" ? sampleActions(actionRuns) : model.actions } : null;
    };
    activate = (id) => binding.commands.activateSchedule(id);
    mock.subscribe(() => update());
  }

  const store = new ProgramStore(
    (id) => {
      const schedule = read()?.schedule;
      return schedule ? schedule.load(id) : Promise.reject(new Error("This light has no schedule."));
    },
    () => update(),
    describeError,
  );

  function update(): void {
    panel.device = read();
    panel.store = store;
    panel.timeZone = "Europe/London";
    panel.active = q.get("active") !== "0";
    panel.activating = activating;
  }

  panel.addEventListener("activate-program", (event) => {
    const id = (event as CustomEvent<{ program: string }>).detail.program;
    activated.push(id);
    activating = true;
    update();
    activate(id)
      .catch((error: unknown) => toast.enqueue({ message: describeError(error), kind: "error" }))
      .finally(() => {
        activating = false;
        update();
      });
  });

  const handle: HarnessHandle = { panel, store, controller, fluval, hass: () => hassNow(), toasts, activated, actionRuns, device: read };
  Object.assign(window, { __mock: handle });
  await customElements.whenDefined("aquarium-schedule-panel");
  update();

  const wanted = q.get("program");
  if (wanted !== null && wanted !== "") {
    const programs = read()?.schedule?.programs ?? [];
    const byIndex = /^\d+$/.test(wanted) ? programs[Number(wanted)] : undefined;
    const id = byIndex?.id ?? wanted;
    if (programs.some((program) => program.id === id)) panel.viewProgram(id);
  }

  if (q.get("edit") === "1") {
    const deadline = performance.now() + 15_000;
    const press = (): void => {
      const buttons = [...(panel.shadowRoot?.querySelectorAll("lu-pill-button") ?? [])];
      const target = buttons.find((button) => ["Edit", "Customise", "Create program"].includes(button.label) && !button.disabled);
      if (target) target.shadowRoot?.querySelector("button")?.click();
      else if (performance.now() < deadline) setTimeout(press, 60);
    };
    press();
  }
}

void main();

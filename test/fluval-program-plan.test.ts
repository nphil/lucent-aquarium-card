import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRAMS_REFRESH_MS, PROGRAMS_RETRY_MS, ProgramPlan, reloadDue, type PlanEnvironment } from "../src/adapters/fluval-program-plan.ts";
import { draftFromProgram, patchProgram, readAutomationPrograms } from "../src/adapters/fluval-programs.ts";
import { describeError } from "../src/lib/errors.ts";
import type { JsonObject } from "../src/lib/json.ts";
import type { HomeAssistant, ProgramConfig } from "../src/types.ts";
import { liveConfig } from "../dev/program-fixture.ts";

const CONFIG: ProgramConfig = { select: "input_select.aquarium_lighting_program", automation: "automation.plant_room_aquarium_co2_lights", started: "input_datetime.aquarium_program_started", reapply: "input_button.aquarium_re_apply_program" };

interface Calls {
  ws: Array<Record<string, unknown>>;
  api: Array<{ method: string; path: string; body: unknown }>;
  services: Array<{ domain: string; service: string; data: unknown; target: unknown }>;
}

/** A fake Home Assistant that keeps the automation like the real one does: the file changes when
 * the write arrives, while the running automation (what `automation/config` shows) only follows
 * after it has been asked `reloadDelay` more times. */
function fake(options: { reloadDelay?: number; api?: boolean; postError?: unknown; wsError?: unknown } = {}) {
  const calls: Calls = { ws: [], api: [], services: [] };
  const state = { running: liveConfig(), written: null as JsonObject | null, pendingReads: 0, wsError: options.wsError };
  const hass = {
    callWS: async (message: Record<string, unknown>) => {
      calls.ws.push(message);
      if (state.wsError) throw state.wsError;
      if (state.written) {
        if (state.pendingReads > 0) state.pendingReads -= 1;
        else state.running = state.written;
      }
      return { config: structuredClone(state.running) };
    },
    callService: async (domain: string, service: string, data: unknown, target: unknown) => {
      calls.services.push({ domain, service, data, target });
    },
    ...(options.api === false
      ? {}
      : {
          callApi: async (method: string, path: string, body: unknown) => {
            calls.api.push({ method, path, body });
            if (options.postError) throw options.postError;
            state.written = body as JsonObject;
            state.pendingReads = options.reloadDelay ?? 0;
            return { result: "ok" };
          },
        }),
  } as unknown as HomeAssistant;
  return { hass, calls, state };
}

function plan(f: ReturnType<typeof fake>, changes: string[] = []) {
  const sleeps: number[] = [];
  const env: PlanEnvironment = { now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) };
  const instance = new ProgramPlan({ current: f.hass }, CONFIG, () => changes.push("changed"), env);
  return { plan: instance, sleeps, changes };
}

const baselineOf = (name: string): JsonObject => {
  const entry = readAutomationPrograms(liveConfig()).entries.get(name);
  assert.ok(entry?.ok);
  return entry.raw;
};
const draftOf = (name: string) => {
  const entry = readAutomationPrograms(liveConfig()).entries.get(name);
  assert.ok(entry?.ok);
  return draftFromProgram(entry.program, 4);
};

// ---- reading ----

test("the programs are read from the automation's own configuration, once, and shared while it loads", async () => {
  const f = fake();
  const { plan: p, changes } = plan(f);
  assert.equal(p.status, "idle");
  const first = p.load();
  const second = p.load();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls.ws, [{ type: "automation/config", entity_id: "automation.plant_room_aquarium_co2_lights" }]);
  assert.equal(p.status, "ready");
  assert.deepEqual([...(p.data?.entries.keys() ?? [])], ["Normal", "Algae Reset", "Blackout"]);
  assert.equal(p.loadedAt, 1_000_000);
  assert.ok(changes.length >= 2, "it tells its owner when loading starts and ends");

  await p.load();
  assert.equal(f.calls.ws.length, 1, "loaded programs are not read again");
  await p.load(true);
  assert.equal(f.calls.ws.length, 2, "unless asked to");
});

test("a non-administrator is told so instead of getting a broken card", async () => {
  const f = fake({ wsError: { code: "unauthorized", message: "Unauthorized" } });
  const { plan: p } = plan(f);
  await p.load();
  assert.deepEqual([p.status, p.data], ["denied", null]);
});

test("a failed read says why and keeps what was known; the next read recovers", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  await p.load();
  f.state.wsError = { code: "not_found", message: "Entity not found" };
  await p.load(true);
  assert.deepEqual([p.status, p.error], ["error", "Entity not found"]);
  assert.ok(p.data, "the earlier programs are still there");
  f.state.wsError = undefined;
  await p.load();
  assert.deepEqual([p.status, p.error], ["ready", null]);
});

test("an automation the card cannot use is an error with the reason", async () => {
  const f = fake();
  delete f.state.running.id;
  const { plan: p } = plan(f);
  await p.load();
  assert.equal(p.status, "error");
  assert.match(p.error ?? "", /no id/);
});

test("an answer that arrives after the plan was disposed changes nothing", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  const pending = p.load();
  p.dispose();
  await pending;
  assert.equal(p.data, null);
  assert.notEqual(p.status, "ready");
});

// ---- keeping a display current ----

test("a card that only shows the programs reads them at the start, when they are stale, and after a failure", () => {
  const at = 1_000_000;
  assert.equal(reloadDue({ status: "idle", settledAt: null }, at), true);
  assert.equal(reloadDue({ status: "ready", settledAt: at }, at + PROGRAMS_REFRESH_MS), false, "still trusted at the limit");
  assert.equal(reloadDue({ status: "ready", settledAt: at }, at + PROGRAMS_REFRESH_MS + 1), true);
  assert.equal(reloadDue({ status: "error", settledAt: at }, at + PROGRAMS_RETRY_MS), false, "not straight away after a failure");
  assert.equal(reloadDue({ status: "error", settledAt: at }, at + PROGRAMS_RETRY_MS + 1), true);
  assert.equal(reloadDue({ status: "loading", settledAt: null }, at), false, "never twice at once");
  assert.equal(reloadDue({ status: "denied", settledAt: at }, at + 10 * PROGRAMS_REFRESH_MS), false, "no point asking a person who may not read them");
});

test("the plan records when each attempt ended, successful or not", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  await p.load();
  assert.deepEqual([p.loadedAt, p.settledAt], [1_000_000, 1_000_000]);
  f.state.wsError = { code: "home_assistant_error", message: "busy" };
  await p.load(true);
  assert.equal(p.settledAt, 1_000_000);
  assert.equal(reloadDue(p, 1_000_000 + PROGRAMS_RETRY_MS + 1), true);
});

// ---- switching and re-applying ----

test("switching a program selects it in the helper", async () => {
  const f = fake();
  await plan(f).plan.select("Blackout");
  assert.deepEqual(f.calls.services, [{ domain: "input_select", service: "select_option", data: { option: "Blackout" }, target: { entity_id: "input_select.aquarium_lighting_program" } }]);
});

test("re-apply presses the button, and says so when there is none", async () => {
  const f = fake();
  await plan(f).plan.reapply();
  assert.deepEqual(f.calls.services, [{ domain: "input_button", service: "press", data: {}, target: { entity_id: "input_button.aquarium_re_apply_program" } }]);
  const none = new ProgramPlan({ current: f.hass }, { select: CONFIG.select, automation: CONFIG.automation }, () => undefined);
  await assert.rejects(none.reapply(), /no re-apply button/);
});

// ---- saving ----

test("saving writes the patched automation, then waits for Home Assistant to reload it before confirming", async () => {
  const f = fake({ reloadDelay: 2 });
  const { plan: p, sleeps } = plan(f);
  await p.load();
  const draft = draftOf("Algae Reset");
  draft.day = [45, 60, 60, 54];
  const result = await p.save("Algae Reset", baselineOf("Algae Reset"), draft);

  assert.deepEqual(result, { confirmed: true });
  assert.equal(f.calls.api.length, 1);
  assert.deepEqual([f.calls.api[0]!.method, f.calls.api[0]!.path], ["POST", "config/automation/config/plant_room_aquarium_co2_lights"]);
  assert.deepEqual(f.calls.api[0]!.body, patchProgram(liveConfig(), "Algae Reset", draft), "exactly the one-program patch of the current configuration");
  assert.equal(sleeps.length, 3, "two reads still saw the old automation, the third saw the new one");
  const saved = p.data?.entries.get("Algae Reset");
  assert.ok(saved?.ok);
  assert.deepEqual(saved.program.schedule.day, [45, 60, 60, 54, 0]);
  assert.equal(p.status, "ready");
});

test("saving starts from the configuration as it is now, so edits made elsewhere in the meantime are kept", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  await p.load();
  f.state.running.description = "Edited in the UI while the sheet was open";
  (f.state.running.triggers as JsonObject[]).push({ trigger: "time", at: "23:00:00", id: "late" });
  const draft = draftOf("Normal");
  draft.maxDays = 5;
  await p.save("Normal", baselineOf("Normal"), draft);
  const body = f.calls.api[0]!.body as JsonObject;
  assert.equal(body.description, "Edited in the UI while the sheet was open");
  assert.equal((body.triggers as JsonObject[]).at(-1)!.id, "late");
});

test("saving refuses to overwrite a program someone else changed since the editor opened", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  await p.load();
  const programs = (f.state.running.variables as JsonObject).programs as JsonObject;
  ((programs.Normal as JsonObject).schedule as JsonObject).sunrise_ramp = 45;
  await assert.rejects(p.save("Normal", baselineOf("Normal"), draftOf("Normal")), /changed somewhere else/);
  assert.equal(f.calls.api.length, 0, "nothing was written");
});

test("changes to OTHER programs since the editor opened do not block the save", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  await p.load();
  const programs = (f.state.running.variables as JsonObject).programs as JsonObject;
  (programs.Blackout as JsonObject).max_days = 2;
  const result = await p.save("Normal", baselineOf("Normal"), { ...draftOf("Normal"), maxDays: 1 });
  assert.deepEqual(result, { confirmed: true });
  const body = ((f.calls.api[0]!.body as JsonObject).variables as JsonObject).programs as JsonObject;
  assert.equal((body.Blackout as JsonObject).max_days, 2, "the other program keeps its newer value");
  assert.equal((body.Normal as JsonObject).max_days, 1);
});

test("a program that has disappeared cannot be saved", async () => {
  const f = fake();
  const { plan: p } = plan(f);
  await assert.rejects(p.save("Vacation", {}, draftOf("Normal")), /no longer has a readable program called Vacation/);
  assert.equal(f.calls.api.length, 0);
});

test("if Home Assistant never shows the change the save is reported as unconfirmed, not as done", async () => {
  const f = fake({ reloadDelay: 999 });
  const { plan: p, sleeps } = plan(f);
  await p.load();
  const result = await p.save("Normal", baselineOf("Normal"), { ...draftOf("Normal"), maxDays: 2 });
  assert.deepEqual(result, { confirmed: false });
  assert.equal(sleeps.length, 6, "it looked several times over a few seconds");
  assert.equal(p.status, "idle", "the programs are read again next time they are needed");
});

test("a refusal from Home Assistant reaches the person in its own words", async () => {
  const f = fake({ postError: { status_code: 400, body: { message: "Message malformed: extra keys not allowed" } } });
  const { plan: p } = plan(f);
  await p.load();
  let caught: unknown;
  await p.save("Normal", baselineOf("Normal"), draftOf("Normal")).catch((error: unknown) => (caught = error));
  assert.equal(describeError(caught), "Message malformed: extra keys not allowed");
});

test("without the REST helper the card says it cannot save", async () => {
  const f = fake({ api: false });
  const { plan: p } = plan(f);
  await assert.rejects(p.save("Normal", baselineOf("Normal"), draftOf("Normal")), /can't save automations/);
});

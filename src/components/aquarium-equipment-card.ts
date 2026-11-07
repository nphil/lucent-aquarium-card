import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { ProgramPlan, reloadDue } from "../adapters/fluval-program-plan.ts";
import { describeRunning, readProgramState, type ProgramState } from "../adapters/fluval-programs.ts";
import type { HassRef } from "../adapters/types.ts";
import { minutesOfDay } from "../lib/clock.ts";
import {
  ROLE_INFO,
  STALE_READING_MS,
  batteryTone,
  co2Note,
  describeAge,
  describeVerdict,
  downsample,
  formatWatts,
  judgeTemperature,
  normaliseRole,
  offCost,
  outletStatus,
  parseHistory,
  readBand,
  readBattery,
  readTemperature,
  readWatts,
  shortNames,
  totalWatts,
  wattsToShow,
  type Co2Note,
  type HistoryPoint,
  type OutletStatus,
} from "../lib/equipment.ts";
import { equipmentConfigError } from "../lib/equipment-config.ts";
import { describeError } from "../lib/errors.ts";
import { icon } from "../lib/icons.ts";
import { OptimisticStore } from "../lib/optimistic.ts";
import { realScheduler } from "../lib/throttle.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { EquipmentCardConfig, EquipmentOutletConfig, HomeAssistant, OutletRole } from "../types.ts";
import type { HistoryState } from "./aquarium-water-hero.ts";
import type { LuToast, ToastRequest } from "./aq-toast.ts";
import "./aq-chip.ts";
import "./aq-notice.ts";
import "./aq-pill-button.ts";
import "./aq-toast.ts";
import "./aquarium-confirm-action.ts";
import "./aquarium-equipment-editor.ts";
import "./aquarium-outlet-tile.ts";
import "./aquarium-sheet.ts";
import "./aquarium-water-hero.ts";
import { entityDisplayName } from "../lib/entity-name.ts";

const DAY_MS = 86_400_000;
/** The minute tick keeps ages ("3 min ago") and the CO2 window current. */
const CLOCK_MS = 60_000;
/** History older than this is fetched again on the next tick. */
const HISTORY_MAX_AGE_MS = 10 * 60_000;
/** After a failed fetch the next try comes this soon. */
const HISTORY_RETRY_MS = 60_000;
/** A switch command not echoed by its state within this long is given up on. */
const PENDING_MS = 8000;
const HISTORY_BUCKETS = 96;

interface HistoryData {
  state: HistoryState;
  points: HistoryPoint[];
}

/** Everything the card knows about one outlet, worked out from the configuration and the states. */
interface OutletView {
  config: EquipmentOutletConfig;
  id: string;
  name: string;
  role: OutletRole;
  critical: boolean;
  state: string | undefined;
  watts: number | null;
  /** Shown as on: the switch's state, or what was just asked for while that is on its way. */
  on: boolean;
  pending: "on" | "off" | "";
  status: OutletStatus;
  note: Co2Note | null;
}

/** The aquarium's equipment: the water temperature (with its comfortable range and the last day)
 * and one tile per switched outlet showing what it is doing and what it draws. Tapping a tile
 * switches it; switching off something the fish depend on, or the light's power, takes a hold.
 * The CO2 outlet says what the lighting-program automation allows it to do.
 *
 * It is written against plain entities (switches, power sensors, a temperature sensor), so it
 * needs no integration of its own. The program settings are optional: with them the CO2 tile knows
 * the running program's window (administrators only can read it). */
export class AquariumEquipmentCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _history: { state: true },
    _confirmId: { state: true },
    _inView: { state: true },
  };

  declare hass: HomeAssistant;
  declare _config: EquipmentCardConfig | undefined;
  declare _history: HistoryData;
  /** The outlet a hold is being asked for, or null. */
  declare _confirmId: string | null;
  declare _inView: boolean;

  private readonly _ref: { current: HomeAssistant } = { current: undefined as unknown as HomeAssistant };
  private readonly _pending = new OptimisticStore<string, boolean>(PENDING_MS, realScheduler);
  private _plan: ProgramPlan | null = null;
  private _planKey = "";
  private _observer: IntersectionObserver | undefined;
  private _clock: number | undefined;
  private _expiry: number | undefined;
  private _historyEntity = "";
  private _historyAt = 0;
  private _historyRunning = false;

  constructor() {
    super();
    this._history = { state: "loading", points: [] };
    this._confirmId = null;
    this._inView = true;
  }

  // ---- Lovelace card API ----

  setConfig(config: EquipmentCardConfig): void {
    const problem = equipmentConfigError(config);
    if (problem) throw new Error(`Aquarium equipment card: ${problem}`);
    this._config = { ...config, outlets: [...(config.outlets ?? [])] };
    this._confirmId = null;
  }

  getCardSize(): number {
    return 8;
  }

  getGridOptions(): { columns: number; min_columns: number } {
    return { columns: 12, min_columns: 6 };
  }

  static getStubConfig(): EquipmentCardConfig {
    return { type: "custom:aquarium-equipment-card", outlets: [] };
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("aquarium-equipment-editor");
  }

  // ---- lifecycle ----

  connectedCallback(): void {
    super.connectedCallback();
    if (typeof IntersectionObserver !== "undefined") {
      this._observer = new IntersectionObserver((entries) => {
        this._inView = entries.some((entry) => entry.isIntersecting);
      });
      this._observer.observe(this);
    }
    document.addEventListener("visibilitychange", this._onVisibility);
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._observer?.disconnect();
    this._observer = undefined;
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.clearInterval(this._clock);
    window.clearTimeout(this._expiry);
    this._clock = undefined;
    this._expiry = undefined;
    this._plan?.dispose();
    this._plan = null;
    this._planKey = "";
    this._historyEntity = "";
  }

  private _onVisibility = (): void => {
    this.requestUpdate();
  };

  private _watchedIds(): string[] {
    const config = this._config;
    if (!config) return [];
    const ids: string[] = [];
    if (config.temperature) ids.push(config.temperature.entity, ...(config.temperature.battery ? [config.temperature.battery] : []));
    for (const outlet of config.outlets ?? []) ids.push(outlet.switch, ...(outlet.power ? [outlet.power] : []));
    if (config.program) ids.push(config.program.select, ...(config.program.started ? [config.program.started] : []));
    return ids;
  }

  /** Home Assistant hands over a new `hass` on every state change anywhere; only re-render for
   * the entities this card shows (plus theme, language and registry changes). */
  protected shouldUpdate(changed: PropertyValues<this>): boolean {
    if (changed.size !== 1 || !changed.has("hass")) return true;
    const previous = changed.get("hass");
    if (!previous || !this.hass) return true;
    if (previous.entities !== this.hass.entities || previous.language !== this.hass.language || previous.user !== this.hass.user) return true;
    if (previous.themes?.darkMode !== this.hass.themes?.darkMode) return true;
    return this._watchedIds().some((id) => previous.states[id] !== this.hass.states[id]);
  }

  protected willUpdate(): void {
    if (!this.hass || !this._config) return;
    this._ref.current = this.hass;
    const program = this._config.program;
    const key = program && program.select && program.automation ? `${program.select}|${program.automation}` : "";
    if (key !== this._planKey) {
      this._plan?.dispose();
      this._plan = key && program ? new ProgramPlan(this._ref, { select: program.select, automation: program.automation, ...(program.started ? { started: program.started } : {}) }, () => this.requestUpdate()) : null;
      this._planKey = key;
    }
  }

  protected updated(): void {
    this._syncClock();
    const plan = this._plan;
    if (plan && this._inView && !document.hidden && reloadDue(plan, Date.now())) void plan.load(plan.status !== "idle");
    const entity = this._config?.temperature?.entity;
    if (entity && this.hass && (entity !== this._historyEntity || Date.now() - this._historyAt > HISTORY_MAX_AGE_MS) && !this._historyRunning && this._inView && !document.hidden) {
      void this._loadHistory(entity);
    }
  }

  private _syncClock(): void {
    const needed = this._inView && !document.hidden && this._config !== undefined;
    if (needed && this._clock === undefined) this._clock = window.setInterval(() => this.requestUpdate(), CLOCK_MS);
    if (!needed && this._clock !== undefined) {
      window.clearInterval(this._clock);
      this._clock = undefined;
    }
  }

  // ---- history ----

  private async _loadHistory(entity: string): Promise<void> {
    this._historyRunning = true;
    const changedEntity = entity !== this._historyEntity;
    this._historyEntity = entity;
    if (changedEntity) this._history = { state: "loading", points: [] };
    const end = Date.now();
    const start = end - DAY_MS;
    try {
      const answer = await this._ref.current.callWS<unknown>({
        type: "history/history_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        entity_ids: [entity],
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: true,
        no_attributes: true,
      });
      if (entity !== this._historyEntity) return;
      const points = downsample(parseHistory(answer, entity), start, end, HISTORY_BUCKETS);
      this._history = { state: points.length > 0 ? "ready" : "empty", points };
      this._historyAt = Date.now();
    } catch {
      if (entity === this._historyEntity) this._history = { state: this._history.points.length > 0 ? this._history.state : "error", points: this._history.points };
      this._historyAt = Date.now() - HISTORY_MAX_AGE_MS + HISTORY_RETRY_MS;
    } finally {
      this._historyRunning = false;
    }
  }

  // ---- intents ----

  private _toast(request: ToastRequest): void {
    this.renderRoot.querySelector<LuToast>("aq-toast")?.enqueue(request);
  }

  private _onToast = (event: CustomEvent<ToastRequest>): void => {
    event.stopPropagation();
    if (event.detail && typeof event.detail.message === "string") this._toast(event.detail);
  };

  private async _switch(view: OutletView, on: boolean): Promise<void> {
    this._pending.set(view.id, on);
    this._armExpiry();
    this.requestUpdate();
    try {
      await this._ref.current.callService("switch", on ? "turn_on" : "turn_off", {}, { entity_id: view.id }, false);
    } catch (error) {
      this._pending.delete(view.id);
      this.requestUpdate();
      this._toast({ message: describeError(error, `Couldn't switch ${view.name} ${on ? "on" : "off"}.`), kind: "error" });
    }
  }

  /** A pending switch that Home Assistant never echoes is dropped after a while: redraw then. */
  private _armExpiry(): void {
    window.clearTimeout(this._expiry);
    this._expiry = window.setTimeout(() => {
      this._pending.prune();
      this.requestUpdate();
    }, PENDING_MS + 100);
  }

  private _press(view: OutletView): void {
    if (view.state === undefined || view.state === "unavailable" || view.state === "unknown") {
      this._toast({ message: `${view.name} is unavailable: Home Assistant can't reach it right now.`, kind: "error" });
      return;
    }
    if (view.pending !== "") return;
    if (view.on) {
      if (offCost(view.role, view.critical)) {
        this._confirmId = view.id;
        return;
      }
      void this._switch(view, false);
      return;
    }
    void this._switch(view, true);
  }

  private _confirmed = (): void => {
    const view = this._views().find((candidate) => candidate.id === this._confirmId);
    this._confirmId = null;
    if (view) void this._switch(view, false);
  };

  // ---- what to show ----

  private _timeZone(): string | undefined {
    return this.hass?.config?.time_zone ?? this.hass?.locale?.time_zone;
  }

  private _programState(): ProgramState | null {
    const program = this._config?.program;
    return program && this.hass ? readProgramState(this.hass.states, { select: program.select, automation: program.automation, ...(program.started ? { started: program.started } : {}) }, this._timeZone()) : null;
  }

  private _views(): OutletView[] {
    const config = this._config;
    const hass = this.hass;
    if (!config || !hass) return [];
    const outlets = config.outlets ?? [];
    const states = hass.states;
    const automatic = outlets.map((outlet) => {
      const role = normaliseRole(outlet.role);
      return entityDisplayName(hass, outlet.switch) ?? ROLE_INFO[role].title;
    });
    // Words every name starts with ("Aquarium ...") are dropped, but only from names nobody wrote.
    const unnamed = outlets.map((outlet, index) => (outlet.name ? null : index)).filter((index): index is number => index !== null);
    const shortened = shortNames(unnamed.map((index) => automatic[index] ?? ""));
    const program = this._programState();
    const active = program?.active ?? null;
    const entry = active ? this._plan?.data?.entries.get(active) : undefined;
    const window = entry?.ok ? { enabled: entry.program.co2Enabled, start: entry.program.co2Start, end: entry.program.co2End } : null;
    const nowMinutes = minutesOfDay(new Date(), this._timeZone());
    const lampIndex = outlets.findIndex((outlet) => normaliseRole(outlet.role) === "light" && outlet.power !== undefined);
    const lamp = lampIndex >= 0 ? readWatts(states[outlets[lampIndex]!.power as string]) : null;
    const light = { checkFrom: entry?.ok ? entry.program.lightCheck : null, watts: lamp };

    return outlets.map((outlet, index) => {
      const role = normaliseRole(outlet.role);
      const critical = outlet.critical === true;
      const state = states[outlet.switch]?.state;
      const watts = outlet.power ? readWatts(states[outlet.power]) : null;
      const serverOn = state === "on";
      const on = this._pending.get(outlet.switch, serverOn);
      const pending = this._pending.peek(outlet.switch);
      const named = outlet.name ?? shortened[unnamed.indexOf(index)] ?? automatic[index] ?? ROLE_INFO[role].title;
      const guarded = outlet.guard === "program";
      return {
        config: outlet,
        id: outlet.switch,
        name: named,
        role,
        critical,
        state,
        watts,
        on,
        pending: pending === undefined ? "" : pending ? "on" : "off",
        status: outletStatus({ role, critical, state, watts }),
        note: guarded ? co2Note({ window, programName: active, nowMinutes, on: serverOn, light }) : null,
      } satisfies OutletView;
    });
  }

  // ---- render ----

  private _renderWater(): TemplateResult | typeof nothing {
    const config = this._config?.temperature;
    if (!config || !this.hass) return nothing;
    const states = this.hass.states;
    const reading = readTemperature(states[config.entity]);
    const band = readBand(config.min, config.max);
    const now = Date.now();
    const verdict = reading && band ? judgeTemperature(reading.value, band) : null;
    const age = reading?.updatedMs != null ? now - reading.updatedMs : null;
    const stale = age !== null && age > STALE_READING_MS;
    const battery = config.battery ? readBattery(states[config.battery]) : null;
    const missing = states[config.entity] === undefined ? `Home Assistant has no ${config.entity}.` : "The thermometer is unavailable, so the water temperature is unknown.";

    const start = now - DAY_MS;
    const recent = this._history.points.filter((point) => point.t >= start);
    const live: HistoryPoint[] = reading && (recent.length === 0 || now - recent[recent.length - 1]!.t > 60_000) ? [...recent, { t: now, v: reading.value }] : recent;
    const values = live.map((point) => point.v);
    const unit = reading?.unit ?? "";
    const historyLabel = values.length > 0 ? `Last 24 hours: ${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)}${unit}` : "No readings from the last 24 hours";
    const historyState: HistoryState = this._history.state;

    return html`<aquarium-water-hero
      .value=${reading?.value ?? null}
      .unit=${unit}
      .band=${band}
      .verdict=${reading && band && verdict ? describeVerdict(verdict, band, unit) : ""}
      tone=${reading ? (verdict?.tone ?? "neutral") : "warning"}
      .problem=${reading ? "" : missing}
      .age=${age === null ? "" : stale ? `Last reading ${describeAge(age)}. Check the thermometer.` : `Updated ${describeAge(age)}`}
      ?stale=${stale}
      .battery=${battery}
      battery-tone=${battery === null ? "neutral" : batteryTone(battery)}
      .history=${live}
      .historyStart=${start}
      .historyEnd=${now}
      history-state=${historyState}
      .historyLabel=${historyLabel}
    ></aquarium-water-hero>`;
  }

  private _renderTile(view: OutletView): TemplateResult {
    const noPowerReading = view.config.power !== undefined && view.watts === null && view.state !== undefined && view.state !== "unavailable" && view.state !== "unknown";
    const note = view.note?.text ?? (noPowerReading ? "No power reading" : "");
    const shown = wattsToShow(view.on, view.watts);
    return html`<aquarium-outlet-tile
      .icon=${ROLE_INFO[view.role].icon}
      .name=${view.name}
      ?on=${view.on}
      ?unavailable=${view.state === undefined || view.state === "unavailable" || view.state === "unknown"}
      .pending=${view.pending}
      .statusLabel=${view.status.label}
      .statusTone=${view.status.tone}
      .detail=${view.status.detail ?? ""}
      .watts=${shown === null ? "" : formatWatts(shown)}
      .note=${note}
      .noteTone=${view.note?.tone ?? "neutral"}
      @outlet-press=${() => this._press(view)}
    ></aquarium-outlet-tile>`;
  }

  private _renderConfirm(views: readonly OutletView[]): TemplateResult | typeof nothing {
    const view = views.find((candidate) => candidate.id === this._confirmId);
    const cost = view ? offCost(view.role, view.critical) : null;
    const open = view !== undefined && cost !== null;
    const name = view?.name ?? "";
    return html`<aquarium-sheet .open=${open} .label=${`Turn off ${name}`} @closed=${() => (this._confirmId = null)} @opened=${this._onConfirmOpened}>
      <div slot="header"><h2 class="sheet-title">Turn off ${name}?</h2></div>
      <p class="sheet-cost" data-tone=${cost?.tone ?? "neutral"}>${icon(cost?.tone === "danger" ? "alert" : "info")}<span>${cost?.text ?? ""}</span></p>
      <div slot="footer" class="sheet-foot">
        <aquarium-confirm-action tone=${cost?.tone ?? "neutral"} label=${`Hold to turn off ${name}`} complete-label="Turning off" confirm-label="Turn off now" icon="power" @confirmed=${this._confirmed}></aquarium-confirm-action>
        <aq-pill-button class="sheet-cancel" variant="quiet" label="Keep it on" @lu-press=${() => (this._confirmId = null)}></aq-pill-button>
      </div>
    </aquarium-sheet>`;
  }

  /** The safe choice gets the focus: leaving a filter running costs nothing. */
  private _onConfirmOpened = (): void => {
    this.renderRoot.querySelector(".sheet-cancel")?.shadowRoot?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  };

  render() {
    if (!this._config) return nothing;
    if (!this.hass) return html`<ha-card><div class="frame"><aq-notice heading="Waiting for Home Assistant" message="The card connects as soon as Home Assistant has loaded."></aq-notice></div></ha-card>`;
    const config = this._config;
    const views = this._views();
    const program = this._programState();
    const now = Date.now();
    const running = program?.active ? describeRunning(program.startedMs, now) : null;
    const total = totalWatts(views.map((view) => view.watts));
    const empty = !config.temperature && views.length === 0;

    return html`<ha-card @aquarium-toast=${this._onToast}>
      <div class="frame">
        ${empty
          ? html`<div class="pad"><aq-notice kind="info" heading="Nothing to show yet" message="Choose the thermometer and the outlets in the card editor."></aq-notice></div>`
          : html`<div class="layout">
              ${config.temperature ? html`<div class="water-wrap">${this._renderWater()}</div>` : nothing}
              <div class="body">
                <header class="head">
                  <h2 class="title">${config.name || "Aquarium equipment"}</h2>
                  ${program?.active || total !== null
                    ? html`<div class="chips">
                        ${program?.active ? html`<aq-chip icon="playlistPlay" label=${program.active}></aq-chip>` : nothing}
                        ${running ? html`<aq-chip icon="calendarClock" label=${running}></aq-chip>` : nothing}
                        ${total !== null ? html`<aq-chip icon="flash" label=${`Drawing ${formatWatts(total)}`}></aq-chip>` : nothing}
                      </div>`
                    : nothing}
                </header>
                ${views.length > 0 ? html`<div class="grid" role="group" aria-label="Outlets">${views.map((view) => this._renderTile(view))}</div>` : html`<aq-notice kind="info" heading="No outlets yet" message="Add the switches of your power strip in the card editor."></aq-notice>`}
              </div>
            </div>`}
      </div>
      ${this._renderConfirm(views)}
      <aq-toast></aq-toast>
    </ha-card>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; }
      ha-card { position: relative; display: block; overflow: hidden; color: var(--lu-ink); font-family: var(--lu-font); }
      .frame { container-type: inline-size; }
      .pad { padding: var(--lu-space-4); }
      .layout { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
      .water-wrap { display: flex; flex-direction: column; min-width: 0; }
      .water-wrap aquarium-water-hero { flex: 1 1 auto; }
      .body { display: grid; gap: var(--lu-space-4); min-width: 0; align-content: start; padding: var(--lu-space-4) var(--lu-space-3) var(--lu-space-4); }
      .head { display: grid; gap: var(--lu-space-2); min-width: 0; margin-left: var(--lu-space-2); }
      .title { margin: 0; color: var(--lu-ink); font: 600 var(--lu-type-title)/1.25 var(--lu-font); letter-spacing: -0.01em; overflow-wrap: anywhere; }
      .chips { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); min-width: 0; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(136px, 1fr)); gap: var(--lu-space-3); min-width: 0; }

      .sheet-title { margin: 0; color: var(--lu-ink); font: 600 var(--lu-type-title)/1.25 var(--lu-font); overflow-wrap: anywhere; }
      .sheet-cost { display: flex; align-items: flex-start; gap: var(--lu-space-3); margin: var(--lu-space-2) 0 var(--lu-space-4); color: var(--lu-ink); font: 400 var(--lu-type-body)/1.5 var(--lu-font); }
      .sheet-cost .icon { flex: none; margin-top: 2px; font-size: 22px; color: var(--lu-ink-2); }
      .sheet-cost[data-tone="danger"] .icon { color: var(--lu-danger); }
      .sheet-foot { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--lu-space-2); }
      .sheet-foot aquarium-confirm-action { flex: 1 1 240px; min-width: 0; }

      @container (min-width: 440px) { .body { padding: var(--lu-space-5) var(--lu-space-4) var(--lu-space-4); } .head { margin-left: 0; } }
      @container (min-width: 720px) {
        .layout { grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); align-items: stretch; }
        .body { padding: var(--lu-space-5); }
      }
    `,
  ];
}

customElements.define("aquarium-equipment-card", AquariumEquipmentCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "aquarium-equipment-card",
  name: "Aquarium equipment",
  description: "Water temperature and the filter, heater, CO2, UV, light and spare outlets of an aquarium.",
  preview: true,
});

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-equipment-card": AquariumEquipmentCard;
  }
}

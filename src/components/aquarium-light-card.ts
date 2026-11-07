import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { bindLight, findSupportedLights } from "../adapters/index.ts";
import type { AdapterBinding, DeviceModel, EffectDef, TankColour } from "../adapters/types.ts";
import { minutesOfDay } from "../lib/clock.ts";
import { DeviceSession } from "../lib/device-session.ts";
import { icon, type IconName } from "../lib/icons.ts";
import { browserStorage } from "../lib/last-known.ts";
import { usableProgram } from "../lib/light-config.ts";
import { nextRovingIndex } from "../lib/roving.ts";
import type { AquariumCardConfig, CardTab, HomeAssistant, ProgramConfig } from "../types.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { ChannelChangeDetail, LevelsSelectDetail } from "./aquarium-colour-panel.ts";
import type { EffectSelectDetail } from "./aquarium-effects-panel.ts";
import type { SliderDetail } from "./aquarium-slider.ts";
import type { LuToast, ToastRequest } from "./aq-toast.ts";
import "./aq-icon-button.ts";
import "./aq-notice.ts";
import "./aq-toast.ts";
import "./aquarium-hero.ts";
import "./aquarium-colour-panel.ts";
import "./aquarium-effects-panel.ts";
import "./aquarium-schedule-panel.ts";
import "./aquarium-program-panel.ts";
import "./aquarium-card-editor.ts";
import { entityDisplayName } from "../lib/entity-name.ts";

interface TabInfo {
  id: CardTab;
  label: string;
  icon: IconName;
}

const ALL_TABS: readonly TabInfo[] = [
  { id: "colour", label: "Colour", icon: "palette" },
  { id: "effects", label: "Effects", icon: "effects" },
  { id: "schedule", label: "Schedule", icon: "clock" },
  { id: "program", label: "Program", icon: "playlistPlay" },
];

function isTab(value: unknown): value is CardTab {
  return ALL_TABS.some((tab) => tab.id === value);
}

/** The aquarium light card: a calm tank-glow hero with status chips, power and master brightness,
 * then the light's modes - Colour, Effects and Schedule - as tabs.
 *
 * It is written once against the capability model in `adapters/types.ts`. The configured light's
 * registry platform picks an adapter (`pawfly`, `fluvalble`) that turns that integration's
 * entities and services into the model and back; whatever a light cannot do is absent from its
 * model and the UI simply does not offer it. */
export class AquariumLightCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _tab: { state: true },
    _visited: { state: true },
    _inView: { state: true },
    _demoUntil: { state: true },
  };

  declare hass: HomeAssistant;
  declare _config: AquariumCardConfig | undefined;
  declare _tab: CardTab | undefined;
  declare _visited: Set<CardTab>;
  declare _inView: boolean;
  declare _demoUntil: number | null;

  private readonly _ref: { current: HomeAssistant } = { current: undefined as unknown as HomeAssistant };
  private _binding: AdapterBinding | null = null;
  private _unbind: (() => void) | undefined;
  private _boundEntity = "";
  private _boundRegistry: HomeAssistant["entities"] | undefined;
  private _server: DeviceModel | null = null;
  /** Everything that belongs to the light being controlled; replaced whenever the light changes. */
  private _session: DeviceSession | undefined;
  private _observer: IntersectionObserver | undefined;
  private _clockTimer: number | undefined;
  private _demoTimer: number | undefined;
  private _lastPhase = "";

  constructor() {
    super();
    this._tab = undefined;
    this._visited = new Set();
    this._inView = true;
    this._demoUntil = null;
  }

  // ---- Lovelace card API ----

  setConfig(config: AquariumCardConfig): void {
    if (!config || !config.entity) {
      throw new Error("Aquarium light card: choose a light in the card editor (entity: light.your_aquarium_light).");
    }
    this._config = { ...config };
    if (isTab(config.tab)) this._tab = config.tab;
  }

  getCardSize(): number {
    return 12;
  }

  getGridOptions(): { columns: number; min_columns: number } {
    return { columns: 12, min_columns: 6 };
  }

  static getStubConfig(hass: HomeAssistant): AquariumCardConfig {
    return { type: "custom:aquarium-light-card", entity: findSupportedLights(hass)[0] ?? "" };
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("aquarium-card-editor");
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
    // A card that was moved re-binds its light on the next update.
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    // The session goes first: a drag still waiting is sent while the light's binding is installed.
    this._endSession(false);
    this._unbind?.();
    this._unbind = undefined;
    this._binding = null;
    this._boundEntity = "";
    this._observer?.disconnect();
    this._observer = undefined;
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.clearInterval(this._clockTimer);
    window.clearInterval(this._demoTimer);
    this._clockTimer = undefined;
    this._demoTimer = undefined;
  }

  private _onVisibility = (): void => {
    this.requestUpdate();
  };

  /** Home Assistant hands over a new `hass` on every state change anywhere; only re-render for
   * the entities this light reads (plus theme, language and registry changes). */
  protected shouldUpdate(changed: PropertyValues<this>): boolean {
    if (changed.size !== 1 || !changed.has("hass")) return true;
    const previous = changed.get("hass");
    if (!previous || !this.hass || !this._binding) return true;
    if (previous.entities !== this.hass.entities || previous.language !== this.hass.language) return true;
    if (previous.themes?.darkMode !== this.hass.themes?.darkMode) return true;
    return [...this._binding.watch, ...this._programIds()].some((id) => previous.states[id] !== this.hass.states[id]);
  }

  /** The lighting-program settings, when both entities that make them work are named. */
  private _programConfig(): ProgramConfig | undefined {
    return usableProgram(this._config?.program);
  }

  /** The helpers the Program tab shows, whose changes must re-render the card. */
  private _programIds(): string[] {
    const program = this._programConfig();
    return program ? [program.select, program.started, program.reapply].filter((id): id is string => typeof id === "string" && id !== "") : [];
  }

  protected willUpdate(): void {
    if (!this.hass || !this._config?.entity) return;
    this._ref.current = this.hass;
    this._ensureBinding(this._config.entity);
    this._server = this._binding?.read() ?? null;
    const session = this._session;
    // Saved colours are put back once the light's channels are known (some lights learn them late).
    if (session && this._server) session.memory.restore(session.controller, this._server.channels.length);
    this._ensureRunningProgramLoaded();
    const tabs = this._tabs(this._server);
    if (this._tab === undefined && this._server && this._server.phase !== "loading") {
      const running = this._server.phase === "on" ? this._server.running.kind : "manual";
      const preferred: CardTab = running === "effect" ? "effects" : running === "schedule" ? (tabs.some((tab) => tab.id === "program") ? "program" : "schedule") : "colour";
      this._tab = tabs.some((tab) => tab.id === preferred) ? preferred : (tabs[0]?.id ?? "colour");
    }
    const shown = this._shownTab(tabs);
    if (!this._visited.has(shown)) this._visited = new Set([...this._visited, shown]);
  }

  protected updated(): void {
    this._syncClock();
    const session = this._session;
    if (session) session.memory.persist(session.controller.lastKnown, this._server?.phase === "on");
  }

  /** The tab on screen: the chosen one when this light offers it (channel names arrive late for
   * some lights), else the first it does offer. */
  private _shownTab(tabs: readonly TabInfo[]): CardTab {
    return tabs.some((tab) => tab.id === this._tab) ? (this._tab as CardTab) : (tabs[0]?.id ?? "colour");
  }

  private _ensureBinding(entity: string): void {
    const registry = this.hass.entities;
    if (this._binding && this._boundEntity === entity && this._boundRegistry === registry) return;
    const next = bindLight(this._ref, entity);
    const identity = next ? `${next.key}|${entity}` : "";
    this._boundEntity = entity;
    this._boundRegistry = registry;
    // Another light: finish with the old one first, while its binding is still installed, so a
    // drag still waiting for its turn reaches the light it was made on and never the new one.
    if (this._session && this._session.identity !== identity) this._endSession(true);
    this._unbind?.();
    this._binding = next;
    this._unbind = next?.connect?.(() => this.requestUpdate());
    if (!next) return;
    if (this._session) this._session.rebind(next);
    else this._session = this._createSession(next, identity, entity);
  }

  private _createSession(binding: AdapterBinding, identity: string, entity: string): DeviceSession {
    return new DeviceSession(
      identity,
      binding,
      {
        changed: () => this.requestUpdate(),
        error: (message) => this._toast({ message, kind: "error" }),
        command: () => this._endDemo(),
      },
      { memoryKey: `aquarium-light-card:last:${entity}`, storage: browserStorage() },
    );
  }

  /** Drop the session of the current light. `resetView` (another light) also forgets which tab was
   * open and which were visited, so the new light starts fresh; a card that is merely moved keeps them. */
  private _endSession(resetView: boolean): void {
    const session = this._session;
    if (!session) return;
    session.dispose();
    this._session = undefined;
    this._server = null;
    this._endDemo();
    this._lastPhase = "";
    if (resetView) {
      const pinned = this._config?.tab;
      this._tab = isTab(pinned) ? pinned : undefined;
      this._visited = new Set();
    }
  }

  /** The tank glow follows the running schedule's live colour, so its points must be loaded whatever
   * tab is open; a link that just came back re-reads a program that failed before. */
  private _ensureRunningProgramLoaded(): void {
    const server = this._server;
    const store = this._session?.store;
    if (!server || !store) return;
    const reconnected = this._lastPhase === "unavailable" && server.phase !== "unavailable";
    this._lastPhase = server.phase;
    const id = server.running.kind === "schedule" ? server.running.scheduleId : null;
    if (server.phase !== "on" || !id) return;
    const entry = store.entry(id);
    if (entry.status === "idle" || (reconnected && entry.status === "error")) void store.load(id, { force: reconnected });
  }

  /** Tabs the light supports: the Colour tab needs channels, Effects needs an effect list. */
  private _tabs(model: DeviceModel | null): TabInfo[] {
    if (!model) return [];
    return ALL_TABS.filter((tab) => {
      if (tab.id === "colour") return model.channels.length > 0;
      if (tab.id === "effects") return model.effects !== null;
      if (tab.id === "schedule") return model.schedule !== null;
      return model.lightingPrograms !== undefined && this._programConfig() !== undefined;
    });
  }

  /** The 30 s tick that moves the live schedule colour; runs only while it can be seen. */
  private _syncClock(): void {
    const needed = this._inView && !document.hidden && this._server?.phase === "on" && this._server.running.kind === "schedule";
    if (needed && this._clockTimer === undefined) this._clockTimer = window.setInterval(() => this.requestUpdate(), 30_000);
    if (!needed && this._clockTimer !== undefined) {
      window.clearInterval(this._clockTimer);
      this._clockTimer = undefined;
    }
  }

  // ---- Demo (a transient the light never reports) ----

  private _startDemo(durationMs: number): void {
    this._demoUntil = Date.now() + durationMs;
    window.clearInterval(this._demoTimer);
    this._demoTimer = window.setInterval(() => {
      if (this._demoUntil !== null && Date.now() >= this._demoUntil) this._endDemo();
      else this.requestUpdate();
    }, 250);
  }

  private _endDemo(): void {
    if (this._demoUntil === null) return;
    this._demoUntil = null;
    window.clearInterval(this._demoTimer);
    this._demoTimer = undefined;
  }

  // ---- intents from children ----

  private _toast(request: ToastRequest): void {
    this.renderRoot.querySelector<LuToast>("aq-toast")?.enqueue(request);
  }

  private _onToast = (event: CustomEvent<ToastRequest>): void => {
    event.stopPropagation();
    if (event.detail && typeof event.detail.message === "string") this._toast(event.detail);
  };

  private _selectTab(id: CardTab, focus = false): void {
    this._tab = id;
    if (focus) void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`#tab-${id}`)?.focus());
  }

  private _onTabKey(event: KeyboardEvent, tabs: readonly TabInfo[]): void {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") return;
    const current = tabs.findIndex((tab) => tab.id === this._tab);
    const next = nextRovingIndex(event.key, current < 0 ? 0 : current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    this._selectTab(tabs[next]!.id, true);
  }

  private _onMoreInfo = (): void => {
    if (!this._config?.entity) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: this._config.entity }, bubbles: true, composed: true }));
  };

  private _title(model: DeviceModel | null): string {
    return this._config?.name || (this.hass ? entityDisplayName(this.hass, this._config?.entity) : undefined) || model?.name || "Aquarium light";
  }

  private _timeZone(): string | undefined {
    return this.hass?.config?.time_zone ?? this.hass?.locale?.time_zone;
  }

  /** What the tank should show: the running scene's or schedule's live colour when the light's own
   * status colour is not what it is doing, else the (optimistic) manual levels, else the light's
   * own colour. */
  private _tank(model: DeviceModel): TankColour | null {
    if (model.phase !== "on") return null;
    const id = model.running.kind === "schedule" ? model.running.scheduleId : null;
    const program = id && this._session ? this._session.store.entry(id).data : null;
    const live = model.live(program, minutesOfDay(new Date(), this._timeZone()));
    if (live) return live;
    return model.levels ? { levels: model.levels } : model.tank;
  }

  private _runningEffect(model: DeviceModel): EffectDef | null {
    const id = model.running.kind === "effect" ? model.running.effectId : null;
    return id ? (model.effects?.effects.find((effect) => effect.id === id) ?? null) : null;
  }

  // ---- render ----

  render() {
    if (!this._config) return nothing;
    if (!this.hass) return html`<ha-card><div class="frame"><aq-notice heading="Waiting for Home Assistant" message="The card connects as soon as Home Assistant has loaded."></aq-notice></div></ha-card>`;
    const session = this._session;
    if (!this._binding || !session) {
      const platform = this.hass.entities?.[this._config.entity ?? ""]?.platform;
      const message = platform ? `Lights from the ${platform} integration are not supported yet.` : `${this._config.entity} is not a light this card can control. Pick a supported aquarium light in the card editor.`;
      return html`<ha-card><div class="frame"><aq-notice kind="error" heading="Light not supported" message=${message}></aq-notice></div></ha-card>`;
    }
    if (!this._server && Object.keys(this.hass.states).length > 0) {
      return html`<ha-card><div class="frame"><aq-notice kind="error" heading="Light not found" message=${`Home Assistant has no state for ${this._config.entity}. Check the card configuration or that the integration is loaded.`}></aq-notice></div></ha-card>`;
    }

    const controller = session.controller;
    const display = this._server ? controller.display(this._server) : null;
    const unavailable = !display || display.phase === "unavailable" || display.phase === "loading";
    const tabs = this._tabs(display);
    const tab = this._shownTab(tabs);
    const demo = display?.effects?.demo ?? null;
    const demoRemaining = this._demoUntil === null ? null : Math.max(0, this._demoUntil - Date.now());
    const ambient = this._inView && !document.hidden && display?.phase === "on";
    const running = display ? this._runningEffect(display) : null;

    return html`<ha-card @aquarium-toast=${this._onToast}>
      <div class="frame">
        <div class="layout">
          <div class="hero-wrap">
            <aquarium-hero .model=${display} .tank=${display ? this._tank(display) : null} .motion=${running?.motion ?? null} .motionTank=${running?.motionTank ?? null} .ambient=${ambient} ?power-pending=${controller.powerPending} .demo=${demoRemaining !== null}
              @power-toggle=${() => controller.setPower(display?.phase !== "on")}
              @more-info=${this._onMoreInfo}
              @brightness-input=${(event: CustomEvent<SliderDetail>) => controller.setBrightness(event.detail.value, false)}
              @brightness-change=${(event: CustomEvent<SliderDetail>) => controller.setBrightness(event.detail.value, true)}></aquarium-hero>
          </div>
          <div class="body">
            <h2 class="title">${this._title(display)}</h2>
            ${tabs.length > 1
              ? html`<div class="tabs" role="tablist" aria-label="Light mode" style=${`--tabs:${tabs.length}`} @keydown=${(event: KeyboardEvent) => this._onTabKey(event, tabs)}>
                  ${tabs.map(
                    (info) => html`<button type="button" role="tab" id=${`tab-${info.id}`} class="tab" aria-selected=${info.id === tab ? "true" : "false"} aria-controls=${`panel-${info.id}`} tabindex=${info.id === tab ? "0" : "-1"} @click=${() => this._selectTab(info.id)}>
                      ${icon(info.icon)}<span class="tab-label">${info.label}</span>
                    </button>`,
                  )}
                </div>`
              : nothing}
            ${display ? this._renderPanels(session, display, unavailable, demo?.durationMs ?? 0, demoRemaining, tab) : nothing}
          </div>
        </div>
      </div>
      <aq-toast></aq-toast>
    </ha-card>`;
  }

  private _renderPanels(session: DeviceSession, display: DeviceModel, unavailable: boolean, demoMs: number, demoRemaining: number | null, tab: CardTab) {
    const controller = session.controller;
    return html`
      <div class="panel" role="tabpanel" id="panel-colour" aria-labelledby="tab-colour" ?hidden=${tab !== "colour"}>
        ${tab === "colour" && display.channels.length > 0
          ? html`<aquarium-colour-panel .model=${display} ?disabled=${unavailable}
              @channel-change=${(event: CustomEvent<ChannelChangeDetail>) => controller.setChannel(event.detail.index, event.detail.value, event.detail.commit)}
              @levels-select=${(event: CustomEvent<LevelsSelectDetail>) => controller.setLevels(event.detail.levels, true)}></aquarium-colour-panel>`
          : nothing}
      </div>
      <div class="panel" role="tabpanel" id="panel-effects" aria-labelledby="tab-effects" ?hidden=${tab !== "effects"}>
        ${tab === "effects" && display.effects
          ? html`<aquarium-effects-panel .model=${display} ?disabled=${unavailable} ?selection-pending=${controller.selectionPending} .demoRemainingMs=${demoRemaining}
              @effect-select=${(event: CustomEvent<EffectSelectDetail>) => void controller.selectEffect(event.detail.id)}
              @demo-start=${() => void controller.playDemo().then((started) => started && this._startDemo(demoMs))}
              @open-schedule=${() => this._selectTab("schedule", true)}></aquarium-effects-panel>`
          : nothing}
      </div>
      <div class="panel" role="tabpanel" id="panel-schedule" aria-labelledby="tab-schedule" ?hidden=${tab !== "schedule"}>
        ${this._visited.has("schedule") && display.schedule
          ? keyed(
              session.identity,
              html`<aquarium-schedule-panel .device=${display} .store=${session.store} .timeZone=${this._timeZone()} .active=${tab === "schedule"} .activating=${controller.selectionPending}
                @activate-program=${(event: CustomEvent<{ program: string }>) => void controller.activateSchedule(event.detail.program)}></aquarium-schedule-panel>`,
            )
          : nothing}
      </div>
      <div class="panel" role="tabpanel" id="panel-program" aria-labelledby="tab-program" ?hidden=${tab !== "program"}>
        ${this._visited.has("program") && display.lightingPrograms && this._programConfig()
          ? html`<aquarium-program-panel .hass=${this.hass} .hassRef=${this._ref} .config=${this._programConfig()} .channels=${display.lightingPrograms.channels} .timeZone=${this._timeZone()} .active=${tab === "program"}></aquarium-program-panel>`
          : nothing}
      </div>
    `;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; }
      ha-card { position: relative; display: block; overflow: hidden; color: var(--lu-ink); font-family: var(--lu-font); }
      .frame { container-type: inline-size; }
      .layout { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
      .hero-wrap { min-width: 0; }
      .hero-wrap aquarium-hero { --hero-radius: 0; }
      .body { display: grid; gap: var(--lu-space-4); min-width: 0; align-content: start; padding: var(--lu-space-4) var(--lu-space-3) var(--lu-space-3); }
      .title { display: -webkit-box; min-width: 0; margin: 0 0 calc(var(--lu-space-1) * -1) var(--lu-space-2); overflow: hidden; color: var(--lu-ink); font: 600 var(--lu-type-title)/1.25 var(--lu-font); letter-spacing: -0.01em; overflow-wrap: anywhere; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .tabs { display: grid; grid-template-columns: repeat(var(--tabs, 3), minmax(0, 1fr)); gap: var(--lu-space-1); padding: var(--lu-space-1); background: var(--lu-well); border-radius: var(--lu-radius-control); box-shadow: var(--lu-inset); }
      .tab { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-width: 0; min-height: 52px; padding: var(--lu-space-2) var(--lu-space-1); border: 1px solid transparent; border-radius: calc(var(--lu-radius-control) - 4px); color: var(--lu-ink-2); background-color: transparent; font: 600 var(--lu-type-label)/1.2 var(--lu-font); cursor: pointer; transition: background-color var(--lu-motion-focus) var(--lu-ease), color var(--lu-motion-focus) var(--lu-ease); }
      .tab .icon { font-size: 20px; }
      .tab-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tab:hover:not([aria-selected="true"]) { background-color: var(--lu-hover-wash); }
      .tab[aria-selected="true"] { color: var(--lu-ink); background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
      .tab[aria-selected="true"]::after { content: ""; position: absolute; left: 50%; bottom: 3px; width: 16px; height: 3px; transform: translateX(-50%); border-radius: var(--lu-radius-pill); background: var(--lu-accent); }
      .tab[aria-selected="true"]:focus-visible::after { display: none; }
      .panel { min-width: 0; }
      [hidden] { display: none !important; }
      @container (max-width: 359px) { .tab { padding-inline: 2px; font-size: 13px; } }
      @container (min-width: 440px) { .tab { flex-direction: row; gap: var(--lu-space-2); min-height: var(--lu-target); } .tab[aria-selected="true"]::after { display: none; } .body { padding: var(--lu-space-5) var(--lu-space-4) var(--lu-space-4); } }
      @container (min-width: 720px) {
        .layout { grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); align-items: stretch; }
        .hero-wrap { display: grid; }
        .hero-wrap aquarium-hero { --hero-aspect: auto; --hero-height: 100%; }
        .body { padding: var(--lu-space-5); }
      }
      @media (prefers-reduced-motion: reduce) { .tab { transition: none; } }
    `,
  ];
}

customElements.define("aquarium-light-card", AquariumLightCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "aquarium-light-card",
  name: "Aquarium light",
  description: "Colour, effects, schedules and lighting programs for Pawfly and Fluval aquarium lights.",
  preview: true,
});

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-light-card": AquariumLightCard;
  }
}

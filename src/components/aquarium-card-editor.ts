import { LitElement, css, html, nothing } from "lit";
import { findSupportedLights } from "../adapters/index.ts";
import { cleanLightConfig, formFromLightConfig, PROGRAM_KEYS, type LightFormData } from "../lib/light-config.ts";
import { DraftSync } from "../lib/draft-sync.ts";
import { FLUVAL_PLATFORM } from "../adapters/fluval-data.ts";
import type { AquariumCardConfig, CardTab, HomeAssistant, ProgramConfig } from "../types.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

interface SchemaField {
  name: string;
  required?: boolean;
  selector?: Record<string, unknown>;
  type?: "expandable";
  title?: string;
  schema?: SchemaField[];
}

const TAB_OPTIONS: Array<{ value: "auto" | CardTab; label: string }> = [
  { value: "auto", label: "Follow the light (colour, effects or schedule)" },
  { value: "colour", label: "Colour" },
  { value: "effects", label: "Effects" },
  { value: "schedule", label: "Schedule" },
  { value: "program", label: "Program (Fluval lighting programs)" },
];

const PROGRAM_FIELDS: SchemaField[] = [
  { name: "select", required: true, selector: { entity: { filter: [{ domain: "input_select" }] } } },
  { name: "automation", required: true, selector: { entity: { filter: [{ domain: "automation" }] } } },
  { name: "started", selector: { entity: { filter: [{ domain: "input_datetime" }] } } },
  { name: "reapply", selector: { entity: { filter: [{ domain: "input_button" }] } } },
];

const BASE_SCHEMA: SchemaField[] = [
  { name: "entity", required: true, selector: { entity: { filter: [{ domain: "light", integration: ["pawfly", "fluvalble"] }] } } },
  { name: "name", selector: { text: {} } },
  { name: "tab", selector: { select: { mode: "dropdown", options: TAB_OPTIONS } } },
];

const PROGRAM_SCHEMA: SchemaField = { name: "program", type: "expandable", title: "Lighting programs", schema: PROGRAM_FIELDS };

const LABELS: Record<string, string> = {
  entity: "Aquarium light",
  name: "Name (optional)",
  tab: "Tab shown first",
  program: "Lighting programs",
  select: "Program helper (input_select)",
  automation: "Automation that owns the programs",
  started: "Start time helper (input_datetime)",
  reapply: "Re-apply button (input_button)",
};

const HELPERS: Record<string, string> = {
  name: "Shown as the card title. Leave empty to use the device name.",
  select: "Its options are the programs; its state is the running one.",
  automation: "Its variables.programs hold each program's light schedule and CO2 window.",
  started: "Stamped when the program changed: gives \"running 5 days\".",
  reapply: "Pressing it makes the automation write the running program to the light again.",
};


/** Visual editor for `aquarium-light-card`: the light (an entity picker limited to supported
 * lights), an optional title, which tab opens first and, for a Fluval light, the entities behind
 * its lighting programs. Everything else is discovered from the light through its adapter. */
export class AquariumCardEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
  };

  declare hass: HomeAssistant;
  declare _config: AquariumCardConfig | undefined;

  /** The form and the configuration made from it (see `DraftSync`). */
  private _sync: DraftSync<LightFormData, AquariumCardConfig> | undefined;

  setConfig(config: AquariumCardConfig): void {
    if (!this._sync) this._sync = new DraftSync(formFromLightConfig, cleanLightConfig, config);
    else this._sync.receive(config);
    this._config = config;
  }

  private _isFluval(): boolean {
    const entity = this._config?.entity;
    return entity !== undefined && this.hass?.entities?.[entity]?.platform === FLUVAL_PLATFORM;
  }

  private _schema(): SchemaField[] {
    return this._isFluval() ? [...BASE_SCHEMA, PROGRAM_SCHEMA] : BASE_SCHEMA;
  }

  private _data(): LightFormData {
    return this._sync?.draft ?? { tab: "auto" };
  }

  private _apply(data: LightFormData): void {
    if (!this._config || !this._sync) return;
    const next = this._sync.edit(data, this._config);
    this._config = next;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
  }

  private _onFormChanged = (event: CustomEvent<{ value: LightFormData }>): void => {
    event.stopPropagation();
    this._apply({ ...this._data(), ...event.detail.value });
  };

  private _label = (field: SchemaField): string => LABELS[field.name] ?? field.name;
  private _helper = (field: SchemaField): string | undefined => HELPERS[field.name];

  render() {
    if (!this._config) return nothing;
    if (customElements.get("ha-form")) {
      return html`<ha-form .hass=${this.hass} .data=${this._data()} .schema=${this._schema()} .computeLabel=${this._label} .computeHelper=${this._helper} @value-changed=${this._onFormChanged}></ha-form>`;
    }
    return this._renderFallback();
  }

  private _entityChoices(domain: string): string[] {
    return Object.keys(this.hass?.states ?? {}).filter((id) => id.startsWith(`${domain}.`));
  }

  private _programSelect(key: (typeof PROGRAM_KEYS)[number], domain: string, data: LightFormData) {
    const current = data.program?.[key] ?? "";
    const choices = this._entityChoices(domain);
    const options = current && !choices.includes(current) ? [current, ...choices] : choices;
    return html`<label>
      <span>${LABELS[key]}</span>
      <select .value=${current} @change=${(event: Event) => this._apply({ ...data, program: { ...data.program, [key]: (event.target as HTMLSelectElement).value } })}>
        <option value="">${key === "select" || key === "automation" ? "Choose…" : "None"}</option>
        ${options.map((id) => html`<option value=${id} ?selected=${id === current}>${this.hass.states[id]?.attributes.friendly_name ?? id}</option>`)}
      </select>
      <small>${HELPERS[key]}</small>
    </label>`;
  }

  /** Plain controls for a page without Home Assistant's form elements (they load lazily). */
  private _renderFallback() {
    const lights = this.hass ? findSupportedLights(this.hass) : [];
    const data = this._data();
    return html`<div class="editor">
      <label>
        <span>${LABELS.entity}</span>
        <select .value=${data.entity ?? ""} @change=${(event: Event) => this._apply({ ...data, entity: (event.target as HTMLSelectElement).value })}>
          <option value="">Choose a light…</option>
          ${lights.map((id) => html`<option value=${id} ?selected=${id === data.entity}>${this.hass.states[id]?.attributes.friendly_name ?? id}</option>`)}
        </select>
      </label>
      <label>
        <span>${LABELS.name}</span>
        <input type="text" .value=${data.name ?? ""} @change=${(event: Event) => this._apply({ ...data, name: (event.target as HTMLInputElement).value })} />
        <small>${HELPERS.name}</small>
      </label>
      <label>
        <span>${LABELS.tab}</span>
        <select .value=${data.tab} @change=${(event: Event) => this._apply({ ...data, tab: (event.target as HTMLSelectElement).value as LightFormData["tab"] })}>
          ${TAB_OPTIONS.map((option) => html`<option value=${option.value} ?selected=${option.value === data.tab}>${option.label}</option>`)}
        </select>
      </label>
      ${this._isFluval()
        ? html`<fieldset>
            <legend>${LABELS.program}</legend>
            ${this._programSelect("select", "input_select", data)} ${this._programSelect("automation", "automation", data)} ${this._programSelect("started", "input_datetime", data)} ${this._programSelect("reapply", "input_button", data)}
          </fieldset>`
        : nothing}
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; color: var(--lu-ink); font-family: var(--lu-font); }
      .editor { display: grid; gap: var(--lu-space-4); padding: var(--lu-space-2) 0; }
      fieldset { display: grid; gap: var(--lu-space-4); margin: 0; padding: var(--lu-space-3) var(--lu-space-4) var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); }
      legend { padding: 0 var(--lu-space-2); color: var(--lu-ink); font: 600 var(--lu-type-label)/1.3 var(--lu-font); }
      label { display: grid; gap: var(--lu-space-1); color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.3 var(--lu-font); }
      small { color: var(--lu-ink-2); font: 400 var(--lu-type-caption)/1.4 var(--lu-font); }
      select, input { width: 100%; min-height: var(--lu-target); padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); color: var(--lu-ink); background: var(--lu-card); font: 400 var(--lu-type-body)/1.3 var(--lu-font); }
    `,
  ];
}

customElements.define("aquarium-card-editor", AquariumCardEditor);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-card-editor": AquariumCardEditor;
  }
}

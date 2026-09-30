import { LitElement, css, html, nothing } from "lit";
import { OUTLET_ROLES, ROLE_INFO } from "../lib/equipment.ts";
import { DraftSync } from "../lib/draft-sync.ts";
import { cleanEquipmentConfig, formFromEquipmentConfig, type EquipmentFormData } from "../lib/equipment-config.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { EquipmentCardConfig, EquipmentOutletConfig, HomeAssistant, OutletRole } from "../types.ts";

interface SchemaField {
  name: string;
  required?: boolean;
  selector?: Record<string, unknown>;
  type?: "expandable" | "grid";
  title?: string;
  schema?: SchemaField[];
}

const ROLE_OPTIONS = OUTLET_ROLES.map((role) => ({ value: role, label: ROLE_INFO[role].title }));

const SCHEMA: SchemaField[] = [
  { name: "name", selector: { text: {} } },
  {
    name: "temperature",
    type: "expandable",
    title: "Water temperature",
    schema: [
      { name: "entity", selector: { entity: { filter: [{ domain: "sensor", device_class: "temperature" }] } } },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "min", selector: { number: { mode: "box", step: "any" } } },
          { name: "max", selector: { number: { mode: "box", step: "any" } } },
        ],
      },
      { name: "battery", selector: { entity: { filter: [{ domain: "sensor", device_class: "battery" }] } } },
    ],
  },
  {
    name: "outlets",
    selector: {
      object: {
        multiple: true,
        label_field: "switch",
        description_field: "role",
        fields: {
          switch: { label: "Switch", required: true, selector: { entity: { filter: [{ domain: "switch" }] } } },
          power: { label: "Power sensor (W)", selector: { entity: { filter: [{ domain: "sensor", device_class: "power" }] } } },
          role: { label: "What is plugged in", selector: { select: { mode: "dropdown", options: ROLE_OPTIONS } } },
          name: { label: "Name (optional)", selector: { text: {} } },
          critical: { label: "Critical: switching it off needs a hold", selector: { boolean: {} } },
          guard: { label: "Who decides when it runs", selector: { select: { mode: "dropdown", options: [{ value: "program", label: "A lighting program" }] } } },
        },
      },
    },
  },
  {
    name: "program",
    type: "expandable",
    title: "Lighting programs (the CO2 tile shows the running program's window)",
    schema: [
      { name: "select", selector: { entity: { filter: [{ domain: "input_select" }] } } },
      { name: "automation", selector: { entity: { filter: [{ domain: "automation" }] } } },
      { name: "started", selector: { entity: { filter: [{ domain: "input_datetime" }] } } },
    ],
  },
];

const LABELS: Record<string, string> = {
  name: "Name (optional)",
  temperature: "Water temperature",
  entity: "Temperature sensor",
  min: "Comfortable from",
  max: "Comfortable up to",
  battery: "Thermometer battery sensor",
  outlets: "Outlets",
  switch: "Switch",
  power: "Power sensor",
  role: "What is plugged in",
  critical: "Critical: switching it off needs a hold",
  guard: "Who decides when it runs",
  program: "Lighting programs",
  select: "Program helper (input_select)",
  automation: "Automation that owns the programs",
  started: "Start time helper (input_datetime)",
};

const HELPERS: Record<string, string> = {
  name: "Shown as the card title.",
  min: "In the sensor's own unit. Outside the range the reading warns.",
  outlets: "One entry per outlet of the power strip.",
  critical: "For the filter and heater: the fish depend on them.",
  guard: "For the CO2 outlet.",
};

/** Visual editor for `aquarium-equipment-card`: the thermometer and its comfortable range, the
 * outlets (switch, power sensor, what is plugged in) and, optionally, the lighting-program
 * helpers that let the CO2 tile show its window. */
export class AquariumEquipmentEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
  };

  declare hass: HomeAssistant;
  declare _config: EquipmentCardConfig | undefined;

  /** The form and the configuration made from it (see `DraftSync`). */
  private _sync: DraftSync<EquipmentFormData, EquipmentCardConfig> | undefined;

  setConfig(config: EquipmentCardConfig): void {
    if (!this._sync) this._sync = new DraftSync(formFromEquipmentConfig, cleanEquipmentConfig, config);
    else this._sync.receive(config);
    this._config = config;
  }

  private _data(): EquipmentFormData {
    return this._sync?.draft ?? {};
  }

  private _apply(data: EquipmentFormData): void {
    if (!this._config || !this._sync) return;
    const next = this._sync.edit(data, this._config);
    this._config = next;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
  }

  private _onFormChanged = (event: CustomEvent<{ value: EquipmentFormData }>): void => {
    event.stopPropagation();
    this._apply({ ...this._data(), ...event.detail.value });
  };

  private _label = (field: SchemaField): string => LABELS[field.name] ?? field.name;
  private _helper = (field: SchemaField): string | undefined => HELPERS[field.name];

  render() {
    if (!this._config) return nothing;
    if (customElements.get("ha-form")) {
      return html`<ha-form .hass=${this.hass} .data=${this._data()} .schema=${SCHEMA} .computeLabel=${this._label} .computeHelper=${this._helper} @value-changed=${this._onFormChanged}></ha-form>`;
    }
    return this._renderFallback();
  }

  // ---- plain controls for a page without Home Assistant's form elements ----

  private _ids(domain: string): string[] {
    return Object.keys(this.hass?.states ?? {}).filter((id) => id.startsWith(`${domain}.`));
  }

  private _picker(label: string, domain: string, value: string | undefined, onChange: (value: string) => void, empty = "None") {
    const ids = this._ids(domain);
    const options = value && !ids.includes(value) ? [value, ...ids] : ids;
    return html`<label>
      <span>${label}</span>
      <select .value=${value ?? ""} @change=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}>
        <option value="">${empty}</option>
        ${options.map((id) => html`<option value=${id} ?selected=${id === value}>${this.hass.states[id]?.attributes.friendly_name ?? id}</option>`)}
      </select>
    </label>`;
  }

  private _patchOutlet(data: EquipmentFormData, index: number, change: Partial<EquipmentOutletConfig>): void {
    const outlets = [...(data.outlets ?? [])];
    outlets[index] = { ...(outlets[index] as EquipmentOutletConfig), ...change };
    this._apply({ ...data, outlets });
  }

  private _renderFallback() {
    const data = this._data();
    const temperature = data.temperature ?? {};
    const program = data.program ?? {};
    return html`<div class="editor">
      <label>
        <span>${LABELS.name}</span>
        <input type="text" .value=${data.name ?? ""} @change=${(event: Event) => this._apply({ ...data, name: (event.target as HTMLInputElement).value })} />
      </label>
      <fieldset>
        <legend>${LABELS.temperature}</legend>
        ${this._picker(LABELS.entity!, "sensor", temperature.entity, (value) => this._apply({ ...data, temperature: { ...temperature, entity: value } }), "Choose a sensor…")}
        <div class="pair">
          <label><span>${LABELS.min}</span><input type="number" step="any" .value=${String(temperature.min ?? "")} @change=${(event: Event) => this._apply({ ...data, temperature: { ...temperature, min: (event.target as HTMLInputElement).valueAsNumber } })} /></label>
          <label><span>${LABELS.max}</span><input type="number" step="any" .value=${String(temperature.max ?? "")} @change=${(event: Event) => this._apply({ ...data, temperature: { ...temperature, max: (event.target as HTMLInputElement).valueAsNumber } })} /></label>
        </div>
        ${this._picker(LABELS.battery!, "sensor", temperature.battery, (value) => this._apply({ ...data, temperature: { ...temperature, battery: value } }))}
      </fieldset>
      <fieldset>
        <legend>${LABELS.outlets}</legend>
        ${(data.outlets ?? []).map(
          (outlet, index) => html`<div class="outlet">
            ${this._picker(LABELS.switch!, "switch", outlet.switch, (value) => this._patchOutlet(data, index, { switch: value }), "Choose a switch…")}
            ${this._picker(LABELS.power!, "sensor", outlet.power, (value) => this._patchOutlet(data, index, { power: value }))}
            <label>
              <span>${LABELS.role}</span>
              <select .value=${outlet.role ?? ""} @change=${(event: Event) => this._patchOutlet(data, index, { role: ((event.target as HTMLSelectElement).value || undefined) as OutletRole | undefined })}>
                <option value="">Other</option>
                ${ROLE_OPTIONS.map((option) => html`<option value=${option.value} ?selected=${option.value === outlet.role}>${option.label}</option>`)}
              </select>
            </label>
            <label class="check"><input type="checkbox" .checked=${outlet.critical === true} @change=${(event: Event) => this._patchOutlet(data, index, { critical: (event.target as HTMLInputElement).checked })} /><span>${LABELS.critical}</span></label>
            <label class="check"><input type="checkbox" .checked=${outlet.guard === "program"} @change=${(event: Event) => this._patchOutlet(data, index, { guard: (event.target as HTMLInputElement).checked ? "program" : undefined })} /><span>A lighting program decides when it runs</span></label>
            <button type="button" class="remove" @click=${() => this._apply({ ...data, outlets: (data.outlets ?? []).filter((_, i) => i !== index) })}>Remove this outlet</button>
          </div>`,
        )}
        <button type="button" class="add" @click=${() => this._apply({ ...data, outlets: [...(data.outlets ?? []), { switch: this._ids("switch")[0] ?? "switch.example" }] })}>Add an outlet</button>
      </fieldset>
      <fieldset>
        <legend>${LABELS.program}</legend>
        ${this._picker(LABELS.select!, "input_select", program.select, (value) => this._apply({ ...data, program: { ...program, select: value } }))}
        ${this._picker(LABELS.automation!, "automation", program.automation, (value) => this._apply({ ...data, program: { ...program, automation: value } }))}
        ${this._picker(LABELS.started!, "input_datetime", program.started, (value) => this._apply({ ...data, program: { ...program, started: value } }))}
      </fieldset>
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; color: var(--lu-ink); font-family: var(--lu-font); }
      .editor { display: grid; gap: var(--lu-space-4); padding: var(--lu-space-2) 0; }
      fieldset { display: grid; gap: var(--lu-space-3); margin: 0; padding: var(--lu-space-3) var(--lu-space-4) var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); }
      legend { padding: 0 var(--lu-space-2); font: 600 var(--lu-type-label)/1.3 var(--lu-font); }
      label { display: grid; gap: var(--lu-space-1); color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.3 var(--lu-font); }
      .check { display: flex; align-items: center; gap: var(--lu-space-2); min-height: var(--lu-target); }
      .pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--lu-space-3); }
      .outlet { display: grid; gap: var(--lu-space-3); padding-bottom: var(--lu-space-3); border-bottom: 1px solid var(--lu-edge); }
      select, input[type="text"], input[type="number"] { width: 100%; min-height: var(--lu-target); padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); color: var(--lu-ink); background: var(--lu-card); font: 400 var(--lu-type-body)/1.3 var(--lu-font); }
      input[type="checkbox"] { width: 20px; height: 20px; }
      button.add, button.remove { min-height: var(--lu-target); padding: 0 var(--lu-space-4); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-pill); background: var(--lu-glass-raised); color: var(--lu-ink); font: 600 var(--lu-type-label)/1.2 var(--lu-font); cursor: pointer; }
      button.remove { color: var(--lu-danger); background: transparent; }
    `,
  ];
}

customElements.define("aquarium-equipment-editor", AquariumEquipmentEditor);

declare global {
  interface HTMLElementTagNameMap {
    "aquarium-equipment-editor": AquariumEquipmentEditor;
  }
}

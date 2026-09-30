import { LitElement, css, html, nothing } from "lit";
import { findSupportedLights } from "../adapters/index.ts";
import type { AquariumCardConfig, CardTab, HomeAssistant } from "../types.ts";
import { CONTROL_CSS, TOKENS_CSS } from "../styles/tokens.ts";

interface SchemaField {
  name: string;
  required?: boolean;
  selector: Record<string, unknown>;
}

const TAB_OPTIONS: Array<{ value: "auto" | CardTab; label: string }> = [
  { value: "auto", label: "Follow the light (colour, effects or schedule)" },
  { value: "colour", label: "Colour" },
  { value: "effects", label: "Effects" },
  { value: "schedule", label: "Schedule" },
];

const SCHEMA: SchemaField[] = [
  { name: "entity", required: true, selector: { entity: { filter: [{ domain: "light", integration: ["pawfly", "fluvalble"] }] } } },
  { name: "name", selector: { text: {} } },
  { name: "tab", selector: { select: { mode: "dropdown", options: TAB_OPTIONS } } },
];

const LABELS: Record<string, string> = {
  entity: "Aquarium light",
  name: "Name (optional)",
  tab: "Tab shown first",
};

const HELPERS: Record<string, string> = {
  name: "Shown as the card title. Leave empty to use the device name.",
};

interface FormData {
  entity?: string;
  name?: string;
  tab: "auto" | CardTab;
}

/** Visual editor for `aquarium-light-card`: the light (an entity picker limited to supported
 * lights), an optional title, and which tab opens first. Everything else is discovered from the
 * light through its adapter. */
export class AquariumCardEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
  };

  declare hass: HomeAssistant;
  declare _config: AquariumCardConfig | undefined;

  setConfig(config: AquariumCardConfig): void {
    this._config = config;
  }

  private _data(): FormData {
    const config = this._config;
    return { entity: config?.entity, name: config?.name, tab: config?.tab ?? "auto" };
  }

  private _apply(data: FormData): void {
    if (!this._config) return;
    const { entity, name, tab } = data;
    const next: AquariumCardConfig = { ...this._config, entity: entity || undefined, name: name || undefined, tab: tab === "auto" ? undefined : tab };
    for (const key of ["entity", "name", "tab"] as const) if (next[key] === undefined) delete next[key];
    this._config = next;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
  }

  private _onFormChanged = (event: CustomEvent<{ value: FormData }>): void => {
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
        <select .value=${data.tab} @change=${(event: Event) => this._apply({ ...data, tab: (event.target as HTMLSelectElement).value as FormData["tab"] })}>
          ${TAB_OPTIONS.map((option) => html`<option value=${option.value} ?selected=${option.value === data.tab}>${option.label}</option>`)}
        </select>
      </label>
    </div>`;
  }

  static styles = [
    TOKENS_CSS,
    CONTROL_CSS,
    css`
      :host { display: block; min-width: 0; color: var(--lu-ink); font-family: var(--lu-font); }
      .editor { display: grid; gap: var(--lu-space-4); padding: var(--lu-space-2) 0; }
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

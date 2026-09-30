/** The equipment card's configuration: what makes one usable, and the clean-up the visual editor
 * applies to what its form holds. Pure, so both are tested without a browser. */

import type { EquipmentCardConfig, EquipmentOutletConfig, EquipmentTemperatureConfig, OutletRole, ProgramConfig } from "../types.ts";
import { OUTLET_ROLES } from "./equipment.ts";

/** Why this configuration cannot be used, in words for the person editing it; null when it can. */
export function equipmentConfigError(config: unknown): string | null {
  if (!config || typeof config !== "object") return "the configuration is missing.";
  const { outlets, temperature } = config as { outlets?: unknown; temperature?: unknown };
  if (outlets !== undefined) {
    if (!Array.isArray(outlets)) return "outlets must be a list.";
    for (const [index, outlet] of outlets.entries()) {
      const id = outlet && typeof outlet === "object" ? (outlet as { switch?: unknown }).switch : undefined;
      if (typeof id !== "string" || !id.startsWith("switch.")) return `outlet ${index + 1} needs a switch entity (switch.something).`;
    }
  }
  if (temperature !== undefined) {
    const entity = temperature && typeof temperature === "object" ? (temperature as { entity?: unknown }).entity : undefined;
    if (typeof entity !== "string" || entity === "") return "temperature needs an entity (sensor.something).";
  }
  return null;
}

/** What the editor's form holds. */
export interface EquipmentFormData {
  name?: string;
  temperature?: Partial<EquipmentTemperatureConfig>;
  outlets?: EquipmentOutletConfig[];
  program?: Partial<ProgramConfig>;
}

/** The form for a configuration. */
export function formFromEquipmentConfig(config: EquipmentCardConfig): EquipmentFormData {
  return { name: config.name, temperature: { ...config.temperature }, outlets: (config.outlets ?? []).map((outlet) => ({ ...outlet })), program: { ...config.program } };
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The card's configuration out of what the form holds: empty fields are left out, and a block
 * that cannot work yet (a thermometer without a sensor, programs without the helper and the
 * automation) is left out until it can, so the card behind the editor keeps working while it is
 * filled in. Keys the form knows nothing about (`grid_options`, `visibility`, ...) are kept. */
export function cleanEquipmentConfig(data: EquipmentFormData, base: EquipmentCardConfig): EquipmentCardConfig {
  // Written in reading order (type, name, temperature, outlets, program), then whatever else the
  // person keeps in the YAML, so the editor never shuffles their configuration.
  const { type, name: _name, temperature: _temperature, outlets: _outlets, program: _program, ...rest } = base;
  const next: EquipmentCardConfig = { type };

  const name = text(data.name);
  if (name) next.name = name;

  const temperature = data.temperature;
  const entity = text(temperature?.entity);
  if (entity) {
    const cleaned: EquipmentTemperatureConfig = { entity };
    const min = num(temperature?.min);
    const max = num(temperature?.max);
    const battery = text(temperature?.battery);
    if (min !== undefined) cleaned.min = min;
    if (max !== undefined) cleaned.max = max;
    if (battery) cleaned.battery = battery;
    next.temperature = cleaned;
  }

  next.outlets = (data.outlets ?? [])
    .filter((outlet) => outlet && text(outlet.switch) !== undefined)
    .map((outlet) => {
      const cleaned: EquipmentOutletConfig = { switch: outlet.switch };
      const power = text(outlet.power);
      const role = text(outlet.role);
      const outletName = text(outlet.name);
      if (power) cleaned.power = power;
      if (role && (OUTLET_ROLES as readonly string[]).includes(role)) cleaned.role = role as OutletRole;
      if (outletName) cleaned.name = outletName;
      if (outlet.critical === true) cleaned.critical = true;
      if (outlet.guard === "program") cleaned.guard = "program";
      return cleaned;
    });

  const program = data.program;
  const select = text(program?.select);
  const automation = text(program?.automation);
  if (select && automation) {
    const cleaned: ProgramConfig = { select, automation };
    const started = text(program?.started);
    if (started) cleaned.started = started;
    next.program = cleaned;
  }
  return Object.assign(next, rest);
}

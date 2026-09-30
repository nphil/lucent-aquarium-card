/** The light card's configuration and the form the visual editor shows for it. Pure, so the
 * clean-up is tested without a browser. */

import type { AquariumCardConfig, CardTab, ProgramConfig } from "../types.ts";

/** What the editor's form holds. */
export interface LightFormData {
  entity?: string;
  name?: string;
  tab: "auto" | CardTab;
  program?: Partial<ProgramConfig>;
}

export const PROGRAM_KEYS = ["select", "automation", "started", "reapply"] as const;

export function formFromLightConfig(config: AquariumCardConfig): LightFormData {
  return { entity: config.entity, name: config.name, tab: config.tab ?? "auto", program: { ...config.program } };
}

/** The card's configuration out of what the form holds: empty fields are left out, and keys the
 * form knows nothing about (`grid_options`, `visibility`, ...) are kept. A half-filled program
 * block is kept as it is (the card ignores it until both the helper and the automation are named),
 * so nothing typed is lost. */
export function cleanLightConfig(data: LightFormData, base: AquariumCardConfig): AquariumCardConfig {
  // Written in reading order (type, entity, name, tab, program), then whatever else the person
  // keeps in the YAML, so the editor never shuffles their configuration.
  const { type, entity: _entity, name: _name, tab: _tab, program: _program, ...rest } = base;
  const next: AquariumCardConfig = { type };
  if (data.entity) next.entity = data.entity;
  if (data.name) next.name = data.name;
  if (data.tab !== "auto") next.tab = data.tab;
  const program: Partial<ProgramConfig> = {};
  for (const key of PROGRAM_KEYS) {
    const value = data.program?.[key];
    if (typeof value === "string" && value !== "") program[key] = value;
  }
  if (Object.keys(program).length > 0) next.program = program as ProgramConfig;
  return Object.assign(next, rest);
}

/** The lighting-program settings when the card can use them: both the helper and the automation. */
export function usableProgram(program: Partial<ProgramConfig> | undefined): ProgramConfig | undefined {
  return program && typeof program.select === "string" && program.select !== "" && typeof program.automation === "string" && program.automation !== "" ? (program as ProgramConfig) : undefined;
}

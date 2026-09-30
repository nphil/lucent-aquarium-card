/** The supported lights. The card picks an adapter from the entity registry's `platform` for the
 * configured entity; adding a light means adding an adapter here. */

import type { HomeAssistant } from "../types.ts";
import { fluvalAdapter } from "./fluval.ts";
import { pawflyAdapter } from "./pawfly.ts";
import type { AdapterBinding, AquariumAdapter, HassRef } from "./types.ts";

export const ADAPTERS: readonly AquariumAdapter[] = [pawflyAdapter, fluvalAdapter];

export function adapterForPlatform(platform: string | undefined): AquariumAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.platform === platform);
}

/** Bind the configured light through the adapter of its integration; null when no adapter
 * claims it (an unsupported platform, or the entity is not in the registry). */
export function bindLight(ref: HassRef, entityId: string): AdapterBinding | null {
  const platform = ref.current.entities?.[entityId]?.platform;
  return adapterForPlatform(platform)?.bind(ref, entityId) ?? null;
}

/** Every supported light in the registry, for the card editor and the stub config. */
export function findSupportedLights(hass: HomeAssistant): string[] {
  return ADAPTERS.flatMap((adapter) => adapter.findLights(hass));
}

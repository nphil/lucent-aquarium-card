import type { HomeAssistant } from "../types.ts";

/**
 * The name Home Assistant's own cards show for an entity: device name plus entity name, the same
 * words the `friendly_name` attribute carries. Asks `hass.formatEntityName` (2026.4+) so the card
 * keeps following Home Assistant's naming, and falls back to `friendly_name` (which Home
 * Assistant plans to deprecate) and then to the registry name. `undefined` when nothing is known.
 */
export function entityDisplayName(hass: Pick<HomeAssistant, "states" | "entities" | "formatEntityName">, entityId: string | undefined): string | undefined {
  if (!entityId) return undefined;
  const state = hass.states[entityId];
  if (state && typeof hass.formatEntityName === "function") {
    try {
      const name = hass.formatEntityName(state, [{ type: "device" }, { type: "entity" }], { separator: " " });
      if (typeof name === "string" && name !== "") return name;
    } catch {
      // fall back to the attribute below
    }
  }
  const friendly = state?.attributes.friendly_name;
  if (typeof friendly === "string" && friendly !== "") return friendly;
  return hass.entities?.[entityId]?.name ?? undefined;
}

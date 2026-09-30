/** The aquarium automation as Home Assistant returns it from `automation/config`, trimmed to what
 * the harness and the tests need: its three real programs in `variables.programs`, some of its triggers and
 * actions (so patching can be shown to leave them alone), and its top-level keys in the order
 * Home Assistant stores them. */

import type { JsonObject } from "../src/lib/json.ts";

export function liveConfig(): JsonObject {
  return {
    id: "plant_room_aquarium_co2_lights",
    alias: "Plant Room Aquarium - CO2 & Lights",
    description: "Aquarium lighting program drives everything.",
    triggers: [
      { trigger: "time", at: "07:30:00", id: "co2_window_start" },
      { trigger: "time", at: "08:00:00", id: "co2_window_start" },
      { trigger: "time", at: "09:15:00", id: "light_check" },
      { trigger: "time", at: "14:00:00", id: "co2_window_end" },
      { trigger: "time_pattern", minutes: "/15", id: "reconcile" },
      { trigger: "state", entity_id: "input_select.aquarium_lighting_program", id: "program_changed" },
    ],
    conditions: [],
    actions: [
      { variables: { program: "{{ states('input_select.aquarium_lighting_program') }}", p: "{{ programs[program] if program in programs else programs['Normal'] }}" } },
      { choose: [{ conditions: [{ condition: "trigger", id: ["program_changed"] }], sequence: [{ action: "script.turn_on", target: { entity_id: "script.aquarium_apply_lighting_program" }, data: { variables: { program: "{{ program }}", schedule: "{{ p.schedule }}" } } }] }] },
    ],
    mode: "queued",
    max: 10,
    variables: {
      programs: {
        Normal: {
          co2_enabled: true,
          co2_start: "08:00",
          co2_end: "14:00",
          light_check: "09:15",
          review_every_days: 0,
          max_days: 0,
          schedule: {
            sunrise: "08:30",
            sunrise_ramp: 30,
            sunset: "15:30",
            sunset_ramp: 30,
            sleep: "22:00",
            day: { channel_1: 68, channel_2: 100, channel_3: 100, channel_4: 90, channel_5: 0 },
            night: { channel_1: 0, channel_2: 0, channel_3: 5, channel_4: 0, channel_5: 0 },
          },
          summary: "light 08:30-15:30 at full day levels, CO2 08:00-14:00",
        },
        "Algae Reset": {
          co2_enabled: true,
          co2_start: "07:30",
          co2_end: "14:00",
          light_check: "09:15",
          review_every_days: 7,
          max_days: 0,
          schedule: {
            sunrise: "08:30",
            sunrise_ramp: 30,
            sunset: "15:30",
            sunset_ramp: 30,
            sleep: "22:00",
            day: { channel_1: 40, channel_2: 60, channel_3: 60, channel_4: 54, channel_5: 0 },
            night: { channel_1: 0, channel_2: 0, channel_3: 5, channel_4: 0, channel_5: 0 },
          },
          summary: "light 08:30-15:30 at ~60% intensity, CO2 07:30-14:00 (90 min lead). Do 2x50% water changes a week and remove algae by hand",
        },
        Blackout: {
          co2_enabled: false,
          co2_start: "00:00",
          co2_end: "00:00",
          light_check: "09:15",
          review_every_days: 1,
          max_days: 3,
          schedule: {
            sunrise: "08:30",
            sunrise_ramp: 30,
            sunset: "15:30",
            sunset_ramp: 30,
            sleep: "22:00",
            day: { channel_1: 0, channel_2: 0, channel_3: 0, channel_4: 0, channel_5: 0 },
            night: { channel_1: 0, channel_2: 0, channel_3: 0, channel_4: 0, channel_5: 0 },
          },
          summary: "light fully off and CO2 disabled - cover the tank. Ends AUTOMATICALLY after 72 h (reverts to Algae Reset).",
        },
      },
    },
  };
}

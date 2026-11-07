# Aquarium cards

Two Lovelace cards for an aquarium in Home Assistant, built on the Lucent design language: they follow your HA theme (flat or glass, light or dark) and work from 320 px phones to wide dashboards. One file, `aquarium-light-card.js`, registers both.

| Card | What it does |
|---|---|
| `aquarium-light-card` | Colour, effects, schedules and (for a Fluval) lighting programs of a Bluetooth aquarium light |
| `aquarium-equipment-card` | Water temperature and the filter, heater, CO2, UV, light and spare outlets |

## Install

Home Assistant 2026.11 and newer: add `nphil/lucent-aquarium-card` from the built-in Marketplace (it is a public GitHub repository with a `hacs.json`). Before 2026.11: HACS → Frontend → custom repository `nphil/lucent-aquarium-card` (type Dashboard). Either way the resource is added for you and both cards appear in the card picker.

Works on Home Assistant 2026.10 and 2026.11. Card names follow Home Assistant's own naming (`hass.formatEntityName`, falling back to `friendly_name`).

## Light card

Supported lights (the card picks the right behaviour from the entity's integration):

| Integration | Colour | Effects | Schedule |
|---|---|---|---|
| [`pawfly`](https://github.com/nphil/ha-pawfly) (Pawfly / PinYing PY4C) | RGBW + brightness | 8 scenes + 24 h demo | 3 presets + DIY 1-3 editor with live preview |
| [`fluvalble`](https://github.com/nphil/fluvalble) (Fluval Bluetooth) | per channel | native effects | Automatic / Professional, read-only; lighting programs (below) |

```yaml
type: custom:aquarium-light-card
entity: light.plant_room_aquarium_accent_light
# tab: colour | effects | schedule | program   (optional start tab)
```

### Fluval lighting programs

If you run named lighting programs (for example Normal, Algae Reset and Blackout) from one automation, the card can show them, switch between them and edit them. It only needs the entities you already have:

```yaml
type: custom:aquarium-light-card
entity: light.plant_room_aquarium_light
program:
  select: input_select.aquarium_lighting_program      # its options are the programs; its state is the running one
  automation: automation.plant_room_aquarium_co2_lights   # holds the programs
  started: input_datetime.aquarium_program_started    # optional: gives "Running 5 days" and "Ends in 62 h"
  reapply: input_button.aquarium_re_apply_program     # optional: the Re-apply button
```

The automation keeps the programs in its top-level `variables.programs`. Each program is a light schedule (exactly the payload of `fluvalble.set_native_auto_schedule`) plus a CO2 window:

```yaml
variables:
  programs:
    Algae Reset:
      co2_enabled: true
      co2_start: "07:30"
      co2_end: "14:00"
      light_check: "09:15"        # optional: from here CO2 also needs the lamp drawing power
      review_every_days: 7        # 0 = no reminders
      max_days: 0                 # 0 = runs until you switch
      summary: "Light at about 60%, CO2 from 07:30"
      schedule:
        sunrise: "08:30"
        sunrise_ramp: 30
        sunset: "15:30"
        sunset_ramp: 30
        sleep: "22:00"
        day:   { channel_1: 40, channel_2: 60, channel_3: 60, channel_4: 54, channel_5: 0 }
        night: { channel_1: 0,  channel_2: 0,  channel_3: 5,  channel_4: 0,  channel_5: 0 }
```

With the `program` block the card gets a **Program** tab:

- Pick a program to look at: the running one is marked **Active**, with how long it has run and, for a program with a time limit, how long is left.
- Each program shows its summary, its CO2 window and its 24 h light curve, drawn exactly as the light will run it.
- **Re-apply** presses the button: the automation writes the running program to the light again.
- **Switching** program takes a press-and-hold (or a tap and a confirm), because it changes the light's schedule and the CO2 window: "Light and CO2 switch to Blackout."
- **Edit program** opens a sheet with the times, ramps, day and night levels per channel (named as the light reports them), the CO2 window, reminders, time limit and summary, with a live preview of the day. Saving takes a hold. Editing the running program also presses Re-apply, so the light gets it straight away.

Saving changes only that one program inside the automation's configuration (through Home Assistant's own automation editor endpoint); everything else in the automation is left exactly as it was. The card refuses to overwrite a program that was changed somewhere else while the sheet was open, and confirms that Home Assistant holds the new values before it says so. Programs are never renamed, added or removed from the card.

Reading and editing programs needs a Home Assistant **administrator** (Home Assistant only lets administrators read an automation's configuration). Other users see the running program and can switch and re-apply, with a note.

## Equipment card

```yaml
type: custom:aquarium-equipment-card
name: Plant room aquarium          # optional
temperature:
  entity: sensor.aquarium_temperature_sensor_temperature
  min: 74                          # the comfortable range, in the sensor's own unit
  max: 80
  battery: sensor.aquarium_temperature_sensor_battery   # optional
outlets:
  - { switch: switch.aquarium_canister_filter, power: sensor.aquarium_canister_filter_power, role: filter, critical: true }
  - { switch: switch.aquarium_water_heater, power: sensor.aquarium_water_heater_power, role: heater, critical: true }
  - { switch: switch.aquarium_co2, power: sensor.aquarium_co2_power, role: co2, guard: program }
  - { switch: switch.aquarium_uv_lamp, power: sensor.aquarium_uv_lamp_power, role: uv }
  - { switch: switch.aquarium_light_outlet, power: sensor.aquarium_light_outlet_power, role: light }
  - { switch: switch.aquarium_spare_outlet, power: sensor.aquarium_spare_outlet_power, role: spare }
program:                           # optional: the same block as the light card
  select: input_select.aquarium_lighting_program
  automation: automation.plant_room_aquarium_co2_lights
  started: input_datetime.aquarium_program_started
```

- **Water temperature** is the hero: a big reading, a plain-words verdict, a band that shows where it sits against the comfortable range (warning outside it, danger well outside), the last 24 hours as a line, and a warning when the thermometer has been silent for two hours.
- **Outlets** are tiles with the icon of what is plugged in (`role`: `filter`, `heater`, `co2`, `uv`, `light`, `spare`), its state, what it draws right now and an honest status: *Running*, *Heating* / *Idle* (a heater waiting on its thermostat), *Lamp on*, *On, no draw* (switched on but drawing nothing), *Off*, *Off, still drawing* (a fault worth seeing), *Unavailable*.
- **Tap** a tile to switch it. Switching off a `critical` outlet takes a hold in the danger colour with the consequence ("Fish need the filter running"); switching off the light outlet takes a hold too ("The Fluval loses power and the tank goes dark"). Escape or *Keep it on* changes nothing.
- **`guard: program`** (for the CO2 outlet) shows what the lighting-program automation allows: *Running until 14:00*, *Next: 07:30–14:00*, *Held off: waiting for the lamp to draw power*, and a warning when CO2 is on outside its window because the automation will switch it off again. The window is read from the running program, which needs an administrator; without it the tile still says CO2 is guarded.

## Develop

`npm ci && npx tsc --noEmit && bun test test/ && npm run build` → `dist/aquarium-light-card.js` (committed, HACS serves it).

`npm run harness` serves a fake-hass harness on port 4180 (`HARNESS_PORT` to change it). Query parameters: `theme=dark|light|glass-dark|glass-light`, `width=<px>`, `latency=<ms>`, `at=HH:MM` (pretend it is that time), and per card:

- Light card: `light=fluval|pawfly`, `tab=colour|effects|schedule|program`, `state=on|off|unavailable|effect`, `mode=manual|automatic|professional`, and for lighting programs `programs=0`, `admin=0`, `program=<name>`, `pstart=<hours ago>`, `reload=<ms>`, `fail=read|save`.
- Equipment card: `card=equipment`, `temp=<°F>`, `tempstate=unavailable`, `stale=<hours>`, `battery=<%>`, `unavailable=<roles>`, `on=<roles>`, `programs=0`, `admin=0`, `fail=history|switch`.

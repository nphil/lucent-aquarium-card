# Aquarium Light Card

A Lovelace card for Bluetooth aquarium lights in Home Assistant, built on the Lucent design language: it follows your HA theme (flat or glass, light or dark) and works from 320 px phones to wide dashboards.

Supported lights (the card picks the right behaviour from the entity's integration):

| Integration | Colour | Effects | Schedule |
|---|---|---|---|
| [`pawfly`](https://github.com/nphil/ha-pawfly) (Pawfly / PinYing PY4C) | RGBW + brightness | 8 scenes + 24 h demo | 3 presets + DIY 1-3 editor with live preview |
| [`fluvalble`](https://github.com/nphil/fluvalble) (Fluval Bluetooth) | per channel | native effects | Automatic / Professional, read-only |

## Install

HACS → Frontend → custom repository `nphil/lucent-aquarium-card` (type Dashboard), then:

```yaml
type: custom:aquarium-light-card
entity: light.plant_room_aquarium_accent_light
# tab: colour | effects | schedule   (optional start tab)
```

## Develop

`npm ci && npx tsc --noEmit && bun test && npm run build` → `dist/aquarium-light-card.js`. `npm run harness` serves a fake-hass harness on port 4180.

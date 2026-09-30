/** Lucent v2 structural tokens for a Home Assistant card (the single token layer).
 *
 * Home Assistant is the host: its theme supplies every colour, font and the outer `ha-card`
 * material, and this layer only maps them onto Lucent's role names (`--lu-*`). Components read
 * these tokens and never a raw colour, radius or duration. The only literal colours in the card
 * are CONTENT: the LED channel colours and the tank glow, which depict the light itself.
 * Adapted from `/data/agent/managed-skills/design-language/languages/lucent/ha.css`.
 */
import { css } from "lit";

export const TOKENS_CSS = css`
  :host {
    /* Roles resolved from the active HA theme */
    --lu-accent: var(--primary-color);
    --lu-accent-ink: var(--text-primary-color, var(--primary-text-color));
    --lu-ink: var(--primary-text-color);
    --lu-ink-2: var(--secondary-text-color, var(--primary-text-color));
    --lu-ink-3: var(--disabled-text-color, var(--secondary-text-color));
    --lu-positive: var(--success-color, var(--primary-color));
    --lu-warning: var(--warning-color, var(--primary-color));
    --lu-danger: var(--error-color, var(--primary-color));
    --lu-info: var(--info-color, var(--primary-color));
    --lu-canvas: var(--primary-background-color);
    --lu-card: var(--ha-card-background, var(--card-background-color));
    --lu-edge: var(--ha-card-border-color, var(--divider-color));

    /* Surfaces derived from the theme's own ink so they read on dark, light and glass hosts */
    --lu-tile: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    --lu-glass-raised: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
    --lu-edge-raised: color-mix(in srgb, var(--primary-text-color) 22%, transparent);
    --lu-well: color-mix(in srgb, var(--primary-text-color) 9%, transparent);
    --lu-well-edge: color-mix(in srgb, var(--primary-text-color) 14%, transparent);
    --lu-track-off: color-mix(in srgb, var(--primary-text-color) 16%, transparent);
    --lu-track-readable: color-mix(in srgb, var(--primary-text-color) 60%, transparent);
    --lu-accent-soft: color-mix(in srgb, var(--primary-color) 18%, transparent);
    --lu-accent-wash: color-mix(in srgb, var(--primary-color) 12%, transparent);
    --lu-scrim: color-mix(in srgb, var(--primary-background-color) 62%, transparent);
    --lu-hover-wash: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    --lu-focus-wash: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
    --lu-selected-wash: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
    --lu-disabled-opacity: 0.55;

    /* Light: one source, upper left */
    --lu-shade: color-mix(in srgb, #000 26%, transparent);
    --lu-light: color-mix(in srgb, #fff 9%, transparent);
    --lu-highlight-rest: inset 0 1px 0 color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    --lu-highlight-raised: inset 0 1px 0 color-mix(in srgb, var(--primary-text-color) 18%, transparent);
    --lu-shadow-rest: var(--ha-card-box-shadow, none);
    --lu-shadow-raised: 2px 2px 4px var(--lu-shade);
    --lu-shadow-overlay: 0 18px 48px color-mix(in srgb, #000 38%, transparent);
    --lu-inset: inset 2px 2px 4px var(--lu-shade), inset -1px -1px 2px var(--lu-light);
    --lu-focus-landing: inset 0 -3px 0 0 var(--lu-ink);

    /* Space: four-pixel grid */
    --lu-space-1: 4px;
    --lu-space-2: 8px;
    --lu-space-3: 12px;
    --lu-space-4: 16px;
    --lu-space-5: 20px;
    --lu-space-6: 24px;
    --lu-space-7: 32px;
    --lu-space-8: 40px;

    /* Shape stays concentric with the host card's radius */
    --lu-radius-sheet: var(--ha-card-border-radius, 28px);
    --lu-radius-card: var(--ha-card-border-radius, 24px);
    --lu-radius-tile: max(calc(var(--lu-radius-card) - 4px), 8px);
    --lu-radius-row: max(calc(var(--lu-radius-card) - 6px), 8px);
    --lu-radius-control: max(calc(var(--lu-radius-card) - 10px), 6px);
    --lu-radius-pill: 999px;
    --lu-target: 48px;

    /* Type: host font, Lucent HA-profile scale (card headings sit one step below panel headings) */
    --lu-font: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, inherit));
    --lu-type-display: 40px;
    --lu-type-title: 20px;
    --lu-type-body: 16px;
    --lu-type-label: 14px;
    --lu-type-caption: 12px;

    /* Motion: settling durations, not delays */
    --lu-ease: cubic-bezier(0.33, 1, 0.68, 1);
    --lu-ease-press: cubic-bezier(0.2, 0, 0, 1);
    --lu-ease-exit: cubic-bezier(0.4, 0, 1, 1);
    --lu-motion-press: 90ms;
    --lu-motion-label: 120ms;
    --lu-motion-focus: 150ms;
    --lu-motion-card: 180ms;
    --lu-motion-layer: 220ms;
    --lu-motion-exit: 180ms;
    --lu-hold: 1500ms;
    --lu-scale-pressed: 0.97;
    --lu-travel-layer: 16px;
  }

  @media (prefers-reduced-motion: reduce) {
    :host {
      --lu-scale-pressed: 1;
      --lu-travel-layer: 0px;
      --lu-motion-press: 0ms;
      --lu-motion-focus: 0ms;
      --lu-motion-card: 0ms;
      --lu-motion-layer: 120ms;
      --lu-motion-exit: 120ms;
    }
  }
`;

/** Shared control behaviour: focus lands as light on the control, never as a coloured outline
 * (Lucent v2). Forced-colours mode gets the system outline back, because legibility wins. */
export const CONTROL_CSS = css`
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  button {
    font: inherit;
    color: inherit;
    -webkit-tap-highlight-color: transparent;
  }
  .fx:focus-visible,
  button:focus-visible,
  [role="radio"]:focus-visible,
  [role="tab"]:focus-visible,
  [role="slider"]:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    background-image: linear-gradient(var(--lu-focus-wash), var(--lu-focus-wash));
    box-shadow: var(--lu-focus-landing);
  }
  @media (forced-colors: active) {
    .fx:focus-visible,
    button:focus-visible,
    [role="radio"]:focus-visible,
    [role="tab"]:focus-visible,
    [role="slider"]:focus-visible {
      outline-color: Highlight;
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
`;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Looks shared by the Schedule tab and its editor: the exclusive-choice tray (program picker,
 * point chips, "Save to") and the inline status strip. Colours come only from `--lu-*` tokens. */
import { css } from "lit";

/** Lucent "segmented" control: a shallow well holding radio options. The chosen option is a raised
 * control with a small accent bar (never a row-sized accent fill); focus is the shared landing
 * light from `CONTROL_CSS`, so selected and focused stay two different things. */
export const SEGMENT_CSS = css`
  .tray { display: grid; gap: var(--lu-space-1); padding: var(--lu-space-1); border: 1px solid var(--lu-well-edge); border-radius: var(--lu-radius-control); background: var(--lu-well); box-shadow: var(--lu-inset); }
  .seg { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; min-height: var(--lu-target); padding: 4px var(--lu-space-2); border: 1px solid transparent; border-radius: max(calc(var(--lu-radius-control) - 4px), 6px); background-color: transparent; color: var(--lu-ink-2); font: 500 var(--lu-type-label)/1.2 var(--lu-font); text-align: center; overflow-wrap: anywhere; cursor: pointer; transition: background-color var(--lu-motion-focus) var(--lu-ease), transform var(--lu-motion-press) var(--lu-ease-press); }
  .seg:hover { background-color: var(--lu-hover-wash); }
  .seg[aria-checked="true"] { color: var(--lu-ink); font-weight: 600; background-color: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
  .seg[aria-checked="true"]::before { content: ""; position: absolute; left: 5px; top: 50%; width: 3px; height: 16px; margin-top: -8px; border-radius: 2px; background: var(--lu-accent); }
  .seg:active { transform: scale(var(--lu-scale-pressed)); }
`;

/** A short inline message with an action, on a reading-grade surface (Undo, confirmations). */
export const STRIP_CSS = css`
  .strip { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-2) var(--lu-space-3); padding: var(--lu-space-2) var(--lu-space-2) var(--lu-space-2) var(--lu-space-4); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-tile); background: linear-gradient(var(--lu-card), var(--lu-card)), var(--lu-canvas); box-shadow: var(--lu-highlight-rest); color: var(--lu-ink); font: 500 var(--lu-type-label)/1.35 var(--lu-font); }
  .strip-text { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
  .strip-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: var(--lu-space-2); margin-left: auto; }
  @media (prefers-reduced-motion: no-preference) { .strip { animation: strip-in var(--lu-motion-layer) var(--lu-ease) both; } }
  @keyframes strip-in { from { opacity: 0; transform: translateY(6px); } }
`;

/** Pure charge/drain/complete state machine behind the hold-to-confirm control (saving a DIY
 * program overwrites what is on the light). `holdTick` is driven by a `requestAnimationFrame`
 * loop in the button component; every other function is a plain reducer so the gesture's timing
 * rules are unit-testable without a DOM, a timer, or a pointer event.
 */

export type HoldPhase = "idle" | "charging" | "draining" | "completed";

export interface HoldState {
  readonly phase: HoldPhase;
  /** Milliseconds charged so far (or, while draining, milliseconds still left to drain). */
  readonly elapsedMs: number;
}

export interface HoldConfig {
  /** How long a press must be held to complete. */
  readonly durationMs: number;
  /** How long a full-charge drain back to zero takes on early release; a partial charge drains
   * proportionally faster. */
  readonly drainMs: number;
}

export const HOLD_IDLE: HoldState = { phase: "idle", elapsedMs: 0 };
/** Lucent: a hold-to-confirm for overwrite actions lasts 1500 ms. */
export const DEFAULT_HOLD_CONFIG: HoldConfig = { durationMs: 1500, drainMs: 400 };
/** A press let go inside this window is a tap: the route to the ordinary confirmation. */
export const TAP_MAX_MS = 350;

/** Starts a fresh charge; any prior progress is discarded. */
export function holdPress(): HoldState {
  return { phase: "charging", elapsedMs: 0 };
}

/** Advances the clock by `deltaMs`. Charging that reaches the duration settles into `completed`
 * (clamped, never overshooting); draining that reaches zero settles into `idle`. */
export function holdTick(state: HoldState, deltaMs: number, config: HoldConfig): HoldState {
  if (state.phase === "charging") {
    const elapsedMs = state.elapsedMs + deltaMs;
    if (elapsedMs >= config.durationMs) return { phase: "completed", elapsedMs: config.durationMs };
    return { phase: "charging", elapsedMs };
  }
  if (state.phase === "draining") {
    const elapsedMs = state.elapsedMs - deltaMs;
    if (elapsedMs <= 0) return HOLD_IDLE;
    return { phase: "draining", elapsedMs };
  }
  return state;
}

/** Released before completion: `charging` -> `draining` from wherever the charge had reached. */
export function holdRelease(state: HoldState): HoldState {
  if (state.phase !== "charging") return state;
  return { phase: "draining", elapsedMs: state.elapsedMs };
}

/** True when releasing `state` now counts as a tap rather than an abandoned hold. */
export function isTapRelease(state: HoldState): boolean {
  return state.phase === "charging" && state.elapsedMs < TAP_MAX_MS;
}

/** 0..1 visual fill for the current state. */
export function holdProgress(state: HoldState, config: HoldConfig): number {
  if (state.phase === "completed") return 1;
  if (state.phase === "idle") return 0;
  return Math.max(0, Math.min(1, state.elapsedMs / config.durationMs));
}

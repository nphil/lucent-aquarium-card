/** Channel model and colour math shared by every light. Pure: no DOM, no Lit.
 *
 * A light has N independent LED channels (Pawfly: red, green, blue, white; a Fluval: five named
 * emitters such as Pink, Blue, Cold White). Every level in the card is a percent (0-100) in an
 * array aligned with a `ChannelDef[]`; the adapter for each integration supplies the definitions
 * and converts to and from whatever its entities speak.
 */

export interface ChannelDef {
  /** Stable key, unique within a light. */
  id: string;
  name: string;
  /** One or two letters for compact legends. */
  short: string;
  /** Literal channel colour. Content, not chrome: it depicts the LED, so it ignores the HA theme. */
  colour: string;
  /** What one unit of this channel adds to the screen (linear light, 0-1 per RGB component): the
   * tank glow and colour swatches are the sum over channels. */
  light: readonly [number, number, number];
}

/** Levels in percent, one per channel of the light's `ChannelDef[]`. */
export type Levels = readonly number[];

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampPercent(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

export function zeroLevels(count: number): number[] {
  return new Array<number>(count).fill(0);
}

export function levelsEqual(a: Levels, b: Levels): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** A copy of `levels` with channel `index` set to `value` (clamped to whole percent). */
export function withLevel(levels: Levels, index: number, value: number): number[] {
  return levels.map((level, i) => (i === index ? clampPercent(value) : level));
}

/** 0-255 byte -> percent, as Home Assistant colour attributes carry channels. */
export function byteToPercent(byte: number): number {
  return Math.round((clamp(byte, 0, 255) * 100) / 255);
}

export function percentToByte(percent: number): number {
  return Math.round((clamp(percent, 0, 100) * 255) / 100);
}

/** HA brightness 1-255 -> percent 1-100. */
export function brightnessToPercent(brightness: number): number {
  return Math.round(clamp((clamp(brightness, 1, 255) * 100) / 255, 1, 100));
}

/** Percent 1-100 -> HA brightness 1-255. */
export function percentToBrightness(percent: number): number {
  return Math.round(clamp((clamp(percent, 1, 100) * 255) / 100, 1, 255));
}

/** Perceptual curve for the glow: 10% LED power looks far brighter than 10% screen alpha. */
const GLOW_GAMMA = 0.6;

export interface Glow {
  /** Hue-preserving display colour, 0-255 per channel. */
  rgb: [number, number, number];
  /** 0 (dark) - 1 (full). Combines the mix peak and the master brightness. */
  intensity: number;
}

/** The colour the tank glow should show for `levels` at a master brightness. Additive: every
 * channel contributes its `light` vector; the result keeps the mix's hue by normalising to its
 * peak, while `intensity` carries how bright it is. */
export function glowFor(levels: Levels, channels: readonly ChannelDef[], brightnessPercent: number, on = true): Glow {
  if (!on) return { rgb: [0, 0, 0], intensity: 0 };
  const lin = [0, 0, 0];
  channels.forEach((channel, index) => {
    const level = clamp(levels[index] ?? 0, 0, 100) / 100;
    for (let c = 0; c < 3; c++) lin[c]! += level * channel.light[c]!;
  });
  const peak = Math.max(...lin);
  if (peak <= 0.0001) return { rgb: [0, 0, 0], intensity: 0 };
  const rgb = lin.map((v) => Math.round((v / peak) * 255)) as [number, number, number];
  const level = Math.min(1, peak) * (clamp(brightnessPercent, 0, 100) / 100);
  return { rgb, intensity: Math.round(Math.pow(level, GLOW_GAMMA) * 1000) / 1000 };
}

export function cssRgb(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** Space-separated triple for `rgb(var(--x) / alpha)` composition. */
export function cssRgbTriple(rgb: readonly [number, number, number]): string {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]}`;
}

/** Screen swatch colour for a mix at full master brightness, dimmed by the mix's own peak so a
 * 30% mix does not look identical to a 100% one. */
export function swatchColour(levels: Levels, channels: readonly ChannelDef[]): string {
  const glow = glowFor(levels, channels, 100);
  if (glow.intensity <= 0) return "rgb(24, 26, 30)";
  const k = 0.35 + 0.65 * glow.intensity;
  return cssRgb(glow.rgb.map((v) => Math.round(v * k)) as [number, number, number]);
}

/** "Red 10%, Green 20%, ..." for an accessible name. */
export function levelsLabel(levels: Levels, channels: readonly ChannelDef[]): string {
  return channels.map((channel, index) => `${channel.name.toLowerCase()} ${Math.round(levels[index] ?? 0)}%`).join(", ");
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { brightnessToPercent, byteToPercent, clampPercent, glowFor, levelsEqual, levelsLabel, percentToBrightness, percentToByte, swatchColour, withLevel } from "../src/lib/channels.ts";
import { PAWFLY_CHANNELS } from "../src/adapters/pawfly-data.ts";

test("every percent survives the byte round trip the backend uses", () => {
  for (let percent = 0; percent <= 100; percent++) {
    assert.equal(byteToPercent(percentToByte(percent)), percent, `percent ${percent}`);
  }
});

test("every master brightness percent survives the HA brightness round trip", () => {
  for (let percent = 1; percent <= 100; percent++) {
    assert.equal(brightnessToPercent(percentToBrightness(percent)), percent, `percent ${percent}`);
  }
  assert.equal(percentToBrightness(100), 255);
  assert.equal(percentToBrightness(1), 3);
  assert.equal(brightnessToPercent(1), 1);
});

test("clampPercent rounds, clamps and tolerates NaN", () => {
  assert.equal(clampPercent(49.6), 50);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(250), 100);
  assert.equal(clampPercent(Number.NaN), 0);
});

test("withLevel replaces one channel and leaves the input alone", () => {
  const before = [10, 20, 30, 40];
  assert.deepEqual(withLevel(before, 2, 250), [10, 20, 100, 40]);
  assert.deepEqual(before, [10, 20, 30, 40]);
  assert.ok(levelsEqual([1, 2], [1, 2]));
  assert.ok(!levelsEqual([1, 2], [1, 2, 3]));
});

test("the tank glow keeps the mix's hue and carries brightness in intensity", () => {
  const white = glowFor([0, 0, 0, 100], PAWFLY_CHANNELS, 100);
  assert.deepEqual(white.rgb, [255, 255, 255]);
  assert.ok(white.intensity > 0.9);

  const red = glowFor([100, 0, 0, 0], PAWFLY_CHANNELS, 100);
  assert.deepEqual(red.rgb, [255, 0, 0]);

  // Red plus white is a warm white: red stays the strongest channel.
  const warm = glowFor([100, 0, 0, 100], PAWFLY_CHANNELS, 100);
  assert.equal(warm.rgb[0], 255);
  assert.ok(warm.rgb[1] < 255 && warm.rgb[1] === warm.rgb[2]);

  // Dimming changes intensity but not the colour.
  const dim = glowFor([100, 0, 0, 0], PAWFLY_CHANNELS, 30);
  assert.deepEqual(dim.rgb, red.rgb);
  assert.ok(dim.intensity < red.intensity);
  assert.ok(glowFor([100, 0, 0, 0], PAWFLY_CHANNELS, 60).intensity > dim.intensity);
});

test("a dark mix or a light that is off glows nothing", () => {
  assert.equal(glowFor([0, 0, 0, 0], PAWFLY_CHANNELS, 100).intensity, 0);
  assert.equal(glowFor([100, 100, 100, 100], PAWFLY_CHANNELS, 100, false).intensity, 0);
});

test("the glow works for any number of channels and ignores levels beyond them", () => {
  const five = [
    { id: "a", name: "A", short: "A", colour: "#f00", light: [1, 0, 0] as const },
    { id: "b", name: "B", short: "B", colour: "#0f0", light: [0, 1, 0] as const },
    { id: "c", name: "C", short: "C", colour: "#00f", light: [0, 0, 1] as const },
    { id: "d", name: "D", short: "D", colour: "#fff", light: [1, 1, 1] as const },
    { id: "e", name: "E", short: "E", colour: "#ff0", light: [1, 1, 0] as const },
  ];
  assert.deepEqual(glowFor([0, 0, 0, 0, 100], five, 100).rgb, [255, 255, 0]);
  assert.deepEqual(glowFor([0, 100], five.slice(0, 2), 100, true).rgb, [0, 255, 0]);
  assert.deepEqual(glowFor([100, 0, 0, 0, 0, 100], five.slice(0, 1), 100).rgb, [255, 0, 0]);
});

test("swatches and labels describe a mix in words and colour", () => {
  assert.equal(swatchColour([0, 0, 0, 0], PAWFLY_CHANNELS), "rgb(24, 26, 30)");
  assert.notEqual(swatchColour([100, 0, 0, 0], PAWFLY_CHANNELS), swatchColour([30, 0, 0, 0], PAWFLY_CHANNELS));
  assert.equal(levelsLabel([10, 20, 30, 40], PAWFLY_CHANNELS), "red 10%, green 20%, blue 30%, white 40%");
});

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/utils/constants.js";

test("default settings pass validation unchanged", () => {
  assert.deepEqual(sanitizeSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
});

test("unknown keys are dropped", () => {
  const clean = sanitizeSettings({ enabled: false, __proto__: { x: 1 }, injected: "<script>", constructor: 1 });
  assert.deepEqual(clean, { enabled: false });
});

test("values of the wrong type or out of range are dropped", () => {
  const clean = sanitizeSettings({
    enabled: "yes",
    fontSize: "gigantic",
    theme: "dark-glass; background: url(x)",
    chunkTargetSeconds: Number.NaN,
    chunkMaxSeconds: 9999,
    autoHideSeconds: "4",
    task: "delete",
    sourceLanguage: "ru<script>"
  });
  assert.deepEqual(clean, {});
});

test("valid partial updates survive", () => {
  const update = { fontSize: "xlarge", theme: "pure-white", showDualSubtitles: true, chunkMaxSeconds: 10 };
  assert.deepEqual(sanitizeSettings(update), update);
});

test("non-object input yields an empty object", () => {
  for (const input of [null, undefined, 42, "settings", true]) {
    assert.deepEqual(sanitizeSettings(input), {});
  }
});

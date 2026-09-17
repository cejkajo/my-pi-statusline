import assert from "node:assert/strict";
import test from "node:test";
import { getCacheHitDisplay } from "../cache-hit.ts";

test("hides missing usage and empty prompts, even with output tokens", () => {
  assert.equal(getCacheHitDisplay(undefined), undefined);
  assert.equal(getCacheHitDisplay({ input: 0, output: 500, cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("includes cache writes in the prompt denominator and excludes output", () => {
  assert.deepEqual(getCacheHitDisplay({ input: 10, output: 10000, cacheRead: 970, cacheWrite: 20 }), {
    percent: 97,
    color: "success",
  });
});

test("colours by unrounded cache-hit thresholds and renders integer percentages", () => {
  for (const [cacheRead, percent, color] of [
    [0, 0, "error"],
    [599, 60, "error"],
    [600, 60, "warning"],
    [899, 90, "warning"],
    [900, 90, "success"],
    [1000, 100, "success"],
  ] as const) {
    assert.deepEqual(getCacheHitDisplay({ input: 1000 - cacheRead, output: 0, cacheRead, cacheWrite: 0 }), {
      percent,
      color,
    });
  }
});

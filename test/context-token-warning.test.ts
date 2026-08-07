import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_DANGER_USED_TOKENS,
  getContextTokenColor,
} from "../context-token-warning.ts";

test("keeps used context at 150k in the normal token color", () => {
  assert.equal(CONTEXT_DANGER_USED_TOKENS, 150_000);
  assert.equal(getContextTokenColor(150_000), "tokens");
});

test("colors used context above 150k as an error", () => {
  assert.equal(getContextTokenColor(150_001), "contextError");
  assert.equal(getContextTokenColor(183_000), "contextError");
});

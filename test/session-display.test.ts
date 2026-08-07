import assert from "node:assert/strict";
import test from "node:test";
import { getSessionDisplay } from "../session-display.ts";

test("shows the latest prompt instead of a stale session name", () => {
  assert.equal(
    getSessionDisplay("looks like status bar is broken", "no, not working", "019f8ead1234"),
    "no, not working",
  );
});

test("normalizes whitespace in the latest prompt", () => {
  assert.equal(getSessionDisplay("session", "  newest\n  prompt  ", "019f8ead1234"), "newest prompt");
});

test("falls back from prompt to session name, short ID, and new", () => {
  assert.equal(getSessionDisplay("named session", "  ", "019f8ead1234"), "named session");
  assert.equal(getSessionDisplay(undefined, undefined, "019f8ead1234"), "019f8ead");
  assert.equal(getSessionDisplay(undefined, undefined, undefined), "new");
});

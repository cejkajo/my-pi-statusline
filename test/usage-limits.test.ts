import assert from "node:assert/strict";
import test from "node:test";
import usageLimits, {
  normalizeWindows,
  renderUsageLimits,
  severityColor,
  shouldApplyHeaderLimits,
} from "../usage-limits.ts";

function usageWindow(usedPercent: number, windowMinutes: number | null) {
  return { usedPercent, windowMinutes, resetsAt: null };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function renderPlain(limits: NonNullable<ReturnType<typeof normalizeWindows>>): string {
  return stripAnsi(renderUsageLimits(limits));
}

test("collapses duplicate weekly Codex windows", () => {
  const limits = normalizeWindows(
    usageWindow(6, 10080),
    usageWindow(0, 10080),
  );

  assert.ok(limits);
  assert.equal(renderPlain(limits), "wk 94%");
});

test("keeps the more restrictive equal-duration window", () => {
  const limits = normalizeWindows(
    usageWindow(6, 10080),
    usageWindow(12, 10080),
  );

  assert.ok(limits);
  assert.equal(renderPlain(limits), "wk 88%");
});

test("preserves Anthropic 5-hour and weekly windows", () => {
  const limits = normalizeWindows(
    usageWindow(20, 300),
    usageWindow(30, 10080),
  );

  assert.ok(limits);
  assert.equal(renderPlain(limits), "5h 80% · wk 70%");
});

test("classifies a lone Codex weekly window as long", () => {
  const limits = normalizeWindows(usageWindow(6, 10080), null);

  assert.ok(limits);
  assert.equal(renderPlain(limits), "wk 94%");
});

test("does not let Codex headers overwrite successful direct API data", () => {
  assert.equal(shouldApplyHeaderLimits("openai-codex", true), false);
});

test("uses Codex headers when direct API data is unavailable", () => {
  assert.equal(shouldApplyHeaderLimits("openai-codex", false), true);
});

test("continues using Anthropic utilization headers", () => {
  assert.equal(shouldApplyHeaderLimits("anthropic", true), true);
});

test("uses Catppuccin green above 20% remaining", () => {
  assert.equal(severityColor(21), "\x1b[38;2;166;227;161m");
});

test("uses Catppuccin red at or below 20% remaining", () => {
  assert.equal(severityColor(20), "\x1b[38;2;243;139;168m");
  assert.equal(severityColor(0), "\x1b[38;2;243;139;168m");
});

test("publishes provider response updates through Pi's supported status API", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const published: Array<string | undefined> = [];
  usageLimits({
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
  } as any);

  const ctx = {
    model: { provider: "anthropic" },
    ui: {
      setStatus(key: string, value: string | undefined) {
        assert.equal(key, "usage-limits");
        published.push(value);
      },
    },
  };

  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("after_provider_response")?.({
    status: 200,
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.18",
      "anthropic-ratelimit-unified-7d-utilization": "0.36",
    },
  }, ctx);

  assert.equal(published[0], undefined);
  assert.equal(stripAnsi(published.at(-1) ?? ""), "5h 82% · wk 64%");
});

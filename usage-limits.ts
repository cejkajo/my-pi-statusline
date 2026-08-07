/**
 * pi-usage-limits - subscription usage status extension.
 *
 * Shows remaining subscription usage limits (short ~5h window + long ~weekly
 * window) in the statusline via ctx.ui.setStatus("usage-limits", ...).
 *
 * OpenAI Codex usage is fetched from ChatGPT's private /wham/usage endpoint.
 * Provider response headers remain a fallback for SSE transport and 429s.
 * Anthropic usage is read from its unified utilization response headers.
 *
 * Notes:
 * - Values appear after the first successful usage fetch/provider response.
 * - Plain OpenAI API keys have no subscription windows - the segment stays hidden.
 * - The private provider fields and endpoint are undocumented and may change.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Normalized shape (provider-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

interface UsageLimitWindow {
  usedPercent: number; // 0-100, finite
  windowMinutes: number | null;
  resetsAt: Date | null;
}

interface UsageLimits {
  short: UsageLimitWindow | null; // ~5h window
  long: UsageLimitWindow | null; // ~7d window
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header access + defensive parsing
// ─────────────────────────────────────────────────────────────────────────────

type HeaderSource = unknown;

function headerGetter(headers: HeaderSource): (name: string) => string | null {
  if (headers instanceof Map) {
    return (name) => {
      const value = headers.get(name.toLowerCase()) ?? headers.get(name);
      return typeof value === "string" ? value : null;
    };
  }
  if (typeof (headers as { get?: unknown })?.get === "function") {
    return (name) => {
      const value = (headers as { get(n: string): unknown }).get(name);
      return typeof value === "string" ? value : null;
    };
  }
  if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, unknown>;
    return (name) => {
      const value = record[name.toLowerCase()] ?? record[name];
      return typeof value === "string" ? value : null;
    };
  }
  return () => null;
}

function parsePercent(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function parseAnthropicUtilization(value: string | null): number | null {
  const utilization = parsePercent(value);
  if (utilization === null) return null;
  // Anthropic currently sends utilization as a 0.0-1.0 fraction. Accept a
  // future 0-100 representation too, since these headers are undocumented.
  return utilization <= 1 ? utilization * 100 : utilization;
}

function parsePositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Unix seconds/milliseconds first, then RFC 3339 / ISO. */
function parseResetTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const timestamp = Number(trimmed);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const date = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

function parseResetAfterSeconds(value: string | null, now = Date.now()): Date | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return new Date(now + seconds * 1000);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function parseUnknownResetTimestamp(value: unknown): Date | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  return parseResetTimestamp(String(value));
}

function parseUnknownResetAfterSeconds(value: unknown): Date | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  return parseResetAfterSeconds(String(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider parsers - accept either or both usage windows
// ─────────────────────────────────────────────────────────────────────────────

function normalizeSingleWindow(window: UsageLimitWindow): UsageLimits {
  // Current Codex plans may expose only a weekly window. Classify a lone
  // window by duration instead of assuming primary always means short.
  return window.windowMinutes !== null && window.windowMinutes >= 2880
    ? { short: null, long: window, updatedAt: Date.now() }
    : { short: window, long: null, updatedAt: Date.now() };
}

export function normalizeWindows(
  primary: UsageLimitWindow | null,
  secondary: UsageLimitWindow | null,
): UsageLimits | null {
  if (!primary && !secondary) return null;

  if (primary && secondary) {
    if (
      primary.windowMinutes !== null
      && primary.windowMinutes === secondary.windowMinutes
    ) {
      // Some Codex responses expose the same quota window twice. Keep the
      // more restrictive value instead of rendering duplicate labels.
      return normalizeSingleWindow(
        primary.usedPercent >= secondary.usedPercent ? primary : secondary,
      );
    }

    // Smaller window = short. Fall back to primary=short when minutes are missing.
    if (
      primary.windowMinutes !== null
      && secondary.windowMinutes !== null
      && primary.windowMinutes > secondary.windowMinutes
    ) {
      return { short: secondary, long: primary, updatedAt: Date.now() };
    }
    return { short: primary, long: secondary, updatedAt: Date.now() };
  }

  return normalizeSingleWindow(primary ?? secondary!);
}

function parseCodexHeaderReset(get: (name: string) => string | null, prefix: string): Date | null {
  return parseResetAfterSeconds(get(`${prefix}-reset-after-seconds`))
    ?? parseResetTimestamp(get(`${prefix}-reset-at`) ?? get(`${prefix}-resets-at`));
}

function parseCodexHeaders(get: (name: string) => string | null): UsageLimits | null {
  const primaryPct = parsePercent(get("x-codex-primary-used-percent"));
  const secondaryPct = parsePercent(get("x-codex-secondary-used-percent"));
  if (primaryPct === null || secondaryPct === null) return null;

  const primary: UsageLimitWindow = {
    usedPercent: primaryPct,
    windowMinutes: parsePositiveInt(get("x-codex-primary-window-minutes")),
    resetsAt: parseCodexHeaderReset(get, "x-codex-primary"),
  };
  const secondary: UsageLimitWindow = {
    usedPercent: secondaryPct,
    windowMinutes: parsePositiveInt(get("x-codex-secondary-window-minutes")),
    resetsAt: parseCodexHeaderReset(get, "x-codex-secondary"),
  };

  return normalizeWindows(primary, secondary);
}

function parseAnthropicHeaders(get: (name: string) => string | null): UsageLimits | null {
  const shortPct = parseAnthropicUtilization(get("anthropic-ratelimit-unified-5h-utilization"));
  const longPct = parseAnthropicUtilization(get("anthropic-ratelimit-unified-7d-utilization"));
  if (shortPct === null || longPct === null) return null;

  return {
    short: {
      usedPercent: shortPct,
      windowMinutes: 300,
      resetsAt: parseResetTimestamp(
        get("anthropic-ratelimit-unified-5h-reset") ?? get("anthropic-ratelimit-unified-reset"),
      ),
    },
    long: {
      usedPercent: longPct,
      windowMinutes: 10080,
      resetsAt: parseResetTimestamp(get("anthropic-ratelimit-unified-7d-reset")),
    },
    updatedAt: Date.now(),
  };
}

function parseUsageLimits(headers: HeaderSource): UsageLimits | null {
  const get = headerGetter(headers);
  return parseCodexHeaders(get) ?? parseAnthropicHeaders(get);
}

function parseCodexApiWindow(value: unknown): UsageLimitWindow | null {
  const window = record(value);
  if (!window) return null;

  const usedPercent = finiteNumber(window.used_percent ?? window.usedPercent);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;

  const windowSeconds = finiteNumber(window.limit_window_seconds ?? window.windowSeconds);
  const windowMinutes = finiteNumber(window.window_minutes ?? window.windowMinutes);
  const normalizedMinutes = windowSeconds !== null && windowSeconds > 0
    ? Math.round(windowSeconds / 60)
    : windowMinutes !== null && windowMinutes > 0
      ? Math.round(windowMinutes)
      : null;
  const resetsAt = parseUnknownResetTimestamp(window.reset_at ?? window.resetAt)
    ?? parseUnknownResetAfterSeconds(window.reset_after_seconds ?? window.resetAfterSeconds);

  return { usedPercent, windowMinutes: normalizedMinutes, resetsAt };
}

function parseCodexUsageResponse(value: unknown): UsageLimits | null {
  const payload = record(value);
  const rateLimit = record(payload?.rate_limit ?? payload?.rateLimit);
  if (!rateLimit) return null;

  const primary = parseCodexApiWindow(rateLimit.primary_window ?? rateLimit.primaryWindow);
  const secondary = parseCodexApiWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow);
  return normalizeWindows(primary, secondary);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[38;2;166;227;161m";
const ANSI_RED = "\x1b[38;2;243;139;168m";

export function severityColor(remainingPercent: number): string {
  return remainingPercent <= 20 ? ANSI_RED : ANSI_GREEN;
}

function windowLabel(window: UsageLimitWindow, fallback: string): string {
  const minutes = window.windowMinutes;
  if (minutes === null) return fallback;
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "wk";
  if (minutes >= 2880) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function renderWindow(window: UsageLimitWindow, fallbackLabel: string): string {
  const remainingPercent = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
  return `${windowLabel(window, fallbackLabel)} ${severityColor(remainingPercent)}${remainingPercent}%${ANSI_RESET}`;
}

export function renderUsageLimits(limits: UsageLimits): string {
  const windows: string[] = [];
  if (limits.short) windows.push(renderWindow(limits.short, "5h"));
  if (limits.long) windows.push(renderWindow(limits.long, "wk"));
  return windows.join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_KEY = "usage-limits";
const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_REFRESH_TTL_MS = 60_000;
const CODEX_REQUEST_TIMEOUT_MS = 10_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function extractCodexAccountId(token: string): string | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;

  try {
    const payload = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    const claims = record(record(decoded)?.[OPENAI_AUTH_CLAIM]);
    return typeof claims?.chatgpt_account_id === "string" ? claims.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

async function fetchCodexUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<UsageLimits | null> {
  if (ctx.model?.provider !== "openai-codex") return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) return null;

  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${auth.apiKey}`,
    "user-agent": "pi-usage-limits/1",
  };
  const accountId = extractCodexAccountId(auth.apiKey);
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const response = await fetch(CODEX_USAGE_ENDPOINT, { headers, signal });
  if (!response.ok) {
    throw new Error(`Codex usage request failed with HTTP ${response.status}`);
  }

  return parseCodexUsageResponse(await response.json());
}

export function shouldApplyHeaderLimits(provider: string | undefined, hasCodexApiUsage: boolean): boolean {
  return provider !== "openai-codex" || !hasCodexApiUsage;
}

export default function usageLimits(pi: ExtensionAPI) {
  let lastRendered: string | null = null;
  let lastCodexRefreshAt = 0;
  let hasCodexApiUsage = false;
  let generation = 0;
  let requestController: AbortController | null = null;
  let refreshInFlight: Promise<void> | null = null;

  function publish(ctx: ExtensionContext, text: string | null) {
    ctx.ui.setStatus(STATUS_KEY, text ?? undefined);
  }

  function applyLimits(ctx: ExtensionContext, limits: UsageLimits) {
    const rendered = renderUsageLimits(limits);
    if (rendered === lastRendered) return;
    lastRendered = rendered;
    publish(ctx, rendered);
  }

  async function refreshCodex(ctx: ExtensionContext, force = false): Promise<void> {
    if (ctx.model?.provider !== "openai-codex") return;
    if (!force && lastCodexRefreshAt > 0 && Date.now() - lastCodexRefreshAt < CODEX_REFRESH_TTL_MS) return;
    if (refreshInFlight) return refreshInFlight;

    const refreshGeneration = generation;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), CODEX_REQUEST_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;

    const refresh = (async () => {
      try {
        const limits = await fetchCodexUsage(ctx, signal);
        if (!limits || refreshGeneration !== generation || signal.aborted) return;
        lastCodexRefreshAt = Date.now();
        hasCodexApiUsage = true;
        applyLimits(ctx, limits);
      } catch (error) {
        // Usage display is best-effort. Keep the last good header/API value and
        // retry after the next settled turn instead of disrupting the session.
        if (!signal.aborted) {
          console.debug("[usage-limits] Codex usage refresh failed:", error);
        }
      } finally {
        clearTimeout(timeout);
        if (requestController === controller) requestController = null;
      }
    })();

    refreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (refreshInFlight === refresh) refreshInFlight = null;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    generation++;
    requestController?.abort();
    requestController = null;
    refreshInFlight = null;
    lastRendered = null;
    lastCodexRefreshAt = 0;
    hasCodexApiUsage = false;
    publish(ctx, null);
    void refreshCodex(ctx);
  });

  pi.on("session_shutdown", async () => {
    generation++;
    requestController?.abort();
    requestController = null;
    refreshInFlight = null;
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.model?.provider === "openai-codex") {
      await refreshCodex(ctx, true);
      return;
    }

    lastRendered = null;
    lastCodexRefreshAt = 0;
    hasCodexApiUsage = false;
    publish(ctx, null);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshCodex(ctx);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    // Accept 2xx and 429 - a 429 still carries fresh utilization data, and
    // that is exactly when the limits are most interesting.
    const status = typeof event.status === "number" ? event.status : null;
    if (status !== null && status !== 429 && (status < 200 || status >= 300)) return;

    if (!shouldApplyHeaderLimits(ctx.model?.provider, hasCodexApiUsage)) return;

    const limits = parseUsageLimits(event.headers);
    if (!limits) return;

    applyLimits(ctx, limits);
  });
}

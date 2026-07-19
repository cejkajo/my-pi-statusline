import { hostname as osHostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { BuiltinStatusLineSegmentId, RenderedSegment, SegmentContext, SemanticColor, StatusLineSegment, StatusLineSegmentId } from "./types.ts";
import { normalizeCompactExtensionStatus, normalizeExtensionStatusValue } from "./powerline-config.ts";
import { fg, applyColor } from "./theme.ts";
import { getIcons, SEP_DOT, getThinkingText } from "./icons.ts";

function color(ctx: SegmentContext, semantic: SemanticColor, text: string): string {
  return fg(ctx.theme, semantic, text, ctx.colors);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function getTelegramConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? join(home, ".pi", "agent", "telegram.json") : "";
}

function hasTelegramConfig(): boolean {
  const configPath = getTelegramConfigPath();
  if (!configPath || !existsSync(configPath)) return false;

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return typeof parsed?.botToken === "string"
      && /^\d+:[A-Za-z0-9_-]+$/.test(parsed.botToken)
      && (typeof parsed?.allowedUserId === "number" || typeof parsed?.allowedUserId === "string");
  } catch {
    return false;
  }
}

function getConnectedTelegramStatus(statuses: ReadonlyMap<string, string>): boolean | null {
  const telegramKeys = ["telegram", "telegram-bridge", "telegram_bridge"];
  for (const key of telegramKeys) {
    const value = statuses.get(key);
    if (!value) continue;

    const normalized = normalizeExtensionStatusValue(value).toLowerCase();
    if (!normalized) continue;
    if (/disconnect|offline|disabled|error|failed|not connected/.test(normalized)) return false;
    return true;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function iconPrefix(icon: string): string {
  return icon ? `${icon} ` : "";
}

function truncateFromStartToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  let result = "";
  for (const char of [...text].reverse()) {
    const next = `${char}${result}`;
    if (visibleWidth(next) > maxWidth - 1) break;
    result = next;
  }
  return `…${result}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

const modelSegment: StatusLineSegment = {
  id: "model",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.model ?? {};

    let modelName = ctx.model?.name || ctx.model?.id || "no-model";
    // Strip "Claude " prefix for brevity
    if (modelName.startsWith("Claude ")) {
      modelName = modelName.slice(7);
    }

    let content = withIcon(icons.model, modelName);

    if (opts.showThinkingLevel !== false && ctx.model?.reasoning) {
      const level = ctx.thinkingLevel || "off";
      if (level !== "off") {
        const thinkingText = getThinkingText(level);
        if (thinkingText) {
          content += `${SEP_DOT}${thinkingText}`;
        }
      }
    }

    return { content: color(ctx, "model", content), visible: true };
  },
};

const shellModeSegment: StatusLineSegment = {
  id: "shell_mode",
  render(ctx) {
    if (!ctx.shellModeActive) {
      return { content: "", visible: false };
    }

    const shellName = ctx.shellName ?? "shell";
    const state = ctx.shellRunning ? "run" : "idle";
    const cwd = ctx.shellCwd ? basename(ctx.shellCwd) : null;
    const parts = [shellName, state];
    if (cwd) {
      parts.push(cwd);
    }

    return { content: color(ctx, "shellMode", parts.join(SEP_DOT)), visible: true };
  },
};

const pathSegment: StatusLineSegment = {
  id: "path",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.path ?? {};
    const mode = opts.mode ?? "basename";

    let pwd = ctx.shellModeActive && ctx.shellCwd ? ctx.shellCwd : process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE;

    if (mode === "basename") {
      // Just the last directory component (cross-platform)
      pwd = basename(pwd) || pwd;
    } else {
      // Abbreviate home directory for abbreviated/full modes
      if (home && pwd.startsWith(home)) {
        pwd = `~${pwd.slice(home.length)}`;
      }

      // Strip /work/ prefix (common in containers)
      if (pwd.startsWith("/work/")) {
        pwd = pwd.slice(6);
      }

      // Truncate if too long (only for abbreviated mode)
      if (mode === "abbreviated") {
        const maxLen = opts.maxLength ?? 40;
        if (pwd.length > maxLen) {
          pwd = `…${pwd.slice(-(maxLen - 1))}`;
        }
      }
    }

    const prefix = iconPrefix(icons.folder);
    const maxWidth = ctx.options.path?.maxWidth;
    if (typeof maxWidth === "number") {
      const textMaxWidth = Math.max(0, Math.floor(maxWidth) - visibleWidth(prefix));
      pwd = truncateFromStartToWidth(pwd, textMaxWidth);
    }

    const content = `${prefix}${pwd}`;
    // Gondolin extension sets the "gondolin" status only while its VM is running.
    // In the VM: configured path colour (blue). On the host: error colour (red) as a warning.
    const inGondolinVm = Boolean(ctx.extensionStatuses.get("gondolin"));
    return {
      content: inGondolinVm ? color(ctx, "path", content) : applyColor(ctx.theme, "error", content),
      visible: true,
    };
  },
};

const gitSegment: StatusLineSegment = {
  id: "git",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.git ?? {};
    const { branch, staged, unstaged, untracked } = ctx.git;

    if (!branch || opts.showBranch === false) return { content: "", visible: false };

    const changes = [
      opts.showStaged !== false && staged > 0 ? `+${staged}` : "",
      opts.showUnstaged !== false && unstaged > 0 ? `~${unstaged}` : "",
      opts.showUntracked !== false && untracked > 0 ? `?${untracked}` : "",
    ].filter(Boolean);
    const branchContent = color(ctx, "gitClean", withIcon(icons.branch, branch));
    const changesContent = changes.length > 0
      ? ` ${color(ctx, "gitDirty", changes.join(" "))}`
      : "";

    return {
      content: `${branchContent}${changesContent}`,
      visible: true,
    };
  },
};

const thinkingSegment: StatusLineSegment = {
  id: "thinking",
  render(ctx) {
    const level = ctx.thinkingLevel || "off";

    const levelText: Record<string, string> = {
      off: "off",
      minimal: "min",
      low: "low",
      medium: "med",
      high: "high",
      xhigh: "xhigh",
    };
    const label = levelText[level] || level;
    const content = label;

    if (level === "high") {
      return { content: color(ctx, "thinkingHigh", content), visible: true };
    }

    if (level === "xhigh") {
      return { content: color(ctx, "thinkingXhigh", content), visible: true };
    }

    if (level === "minimal") {
      return { content: color(ctx, "thinkingMinimal", content), visible: true };
    }
    if (level === "low") {
      return { content: color(ctx, "thinkingLow", content), visible: true };
    }
    if (level === "medium") {
      return { content: color(ctx, "thinkingMedium", content), visible: true };
    }

    return { content: color(ctx, "thinking", content), visible: true };
  },
};

const subagentsSegment: StatusLineSegment = {
  id: "subagents",
  render() {
    // Note: pi-mono doesn't have subagent tracking built-in
    // This would require extension state management
    // For now, return not visible
    return { content: "", visible: false };
  },
};

const tokenInSegment: StatusLineSegment = {
  id: "token_in",
  render(ctx) {
    const icons = getIcons();
    const { input } = ctx.usageStats;
    if (!input) return { content: "", visible: false };

    const content = withIcon(icons.input, formatTokens(input));
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const tokenOutSegment: StatusLineSegment = {
  id: "token_out",
  render(ctx) {
    const icons = getIcons();
    const { output } = ctx.usageStats;
    if (!output) return { content: "", visible: false };

    const content = withIcon(icons.output, formatTokens(output));
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const tokenTotalSegment: StatusLineSegment = {
  id: "token_total",
  render(ctx) {
    const icons = getIcons();
    const { input, output, cacheRead, cacheWrite } = ctx.usageStats;
    const total = input + output + cacheRead + cacheWrite;
    if (!total) return { content: "", visible: false };

    const content = withIcon(icons.tokens, formatTokens(total));
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const costSegment: StatusLineSegment = {
  id: "cost",
  render(ctx) {
    const { cost } = ctx.usageStats;

    if (!cost) {
      return { content: "", visible: false };
    }

    const costDisplay = `$${cost.toFixed(2)}`;
    return { content: color(ctx, "cost", costDisplay), visible: true };
  },
};

const CONTEXT_DANGER_USED_PERCENT = 20;

function colorContextUsage(ctx: SegmentContext, text: string, usedPercent: number): string {
  return usedPercent > CONTEXT_DANGER_USED_PERCENT
    ? color(ctx, "contextError", text)
    : applyColor(ctx.theme, "success", text);
}

const contextPctSegment: StatusLineSegment = {
  id: "context_pct",
  render(ctx) {
    if (ctx.customCompactionEnabled) return { content: "", visible: false };

    const pct = ctx.contextPercent;
    const text = `${pct.toFixed(1)}%`;
    return { content: colorContextUsage(ctx, text, pct), visible: true };
  },
};

const contextUsageSegment: StatusLineSegment = {
  id: "context_usage",
  render(ctx) {
    if (ctx.customCompactionEnabled) return { content: "", visible: false };

    const { contextTokens: tokens, contextWindow: window, contextPercent: pct } = ctx;
    if (!window) return { content: "", visible: false };

    const icons = getIcons();
    const tokenText = withIcon(icons.context, `${formatTokens(tokens)}/${formatTokens(window)}`);
    const percentText = `${pct.toFixed(1)}%`;

    return {
      content: `${color(ctx, "tokens", tokenText)} ${colorContextUsage(ctx, percentText, pct)}`,
      visible: true,
    };
  },
};

const contextTotalSegment: StatusLineSegment = {
  id: "context_total",
  render(ctx) {
    if (ctx.customCompactionEnabled) return { content: "", visible: false };

    const icons = getIcons();
    const window = ctx.contextWindow;
    if (!window) return { content: "", visible: false };

    return {
      content: color(ctx, "context", withIcon(icons.context, formatTokens(window))),
      visible: true,
    };
  },
};

const timeSpentSegment: StatusLineSegment = {
  id: "time_spent",
  render(ctx) {
    const icons = getIcons();
    const elapsed = Date.now() - ctx.sessionStartTime;
    if (elapsed < 1000) return { content: "", visible: false };

    return { content: withIcon(icons.time, formatDuration(elapsed)), visible: true };
  },
};

const timeSegment: StatusLineSegment = {
  id: "time",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.time ?? {};
    const now = new Date();

    let hours = now.getHours();
    let suffix = "";
    if (opts.format === "12h") {
      suffix = hours >= 12 ? "pm" : "am";
      hours = hours % 12 || 12;
    }

    const mins = now.getMinutes().toString().padStart(2, "0");
    let timeStr = `${hours}:${mins}`;
    if (opts.showSeconds) {
      timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
    }
    timeStr += suffix;

    return { content: withIcon(icons.time, timeStr), visible: true };
  },
};

export function getSessionDisplay(
  sessionName: string | undefined,
  lastUserPrompt: string | undefined,
  sessionId: string | undefined,
): string {
  return sessionName?.trim()
    || lastUserPrompt?.replace(/\s+/g, " ").trim()
    || sessionId?.slice(0, 8)
    || "new";
}

const sessionSegment: StatusLineSegment = {
  id: "session",
  render(ctx) {
    const icons = getIcons();
    const rawDisplay = getSessionDisplay(ctx.sessionName, ctx.lastUserPrompt, ctx.sessionId);
    const maxWidth = Math.max(0, ctx.options.session?.maxWidth ?? 72);
    const prefix = iconPrefix(icons.session);
    const displayMaxWidth = Math.max(0, maxWidth - visibleWidth(prefix));
    const display = displayMaxWidth === 0
      ? ""
      : visibleWidth(rawDisplay) > displayMaxWidth
        ? `${truncateToWidth(rawDisplay, Math.max(0, displayMaxWidth - 1), "")}${applyColor(ctx.theme, "muted", "…")}`
        : rawDisplay;
    const stashStatus = ctx.options.session?.showStash === false ? "" : normalizeExtensionStatusValue(ctx.extensionStatuses.get("stash") ?? "");
    const stashSuffix = stashStatus ? `${color(ctx, "session", " | ")}${color(ctx, "model", stashStatus)}` : "";

    return { content: `${color(ctx, "session", `${prefix}${display}`)}${stashSuffix}`, visible: true };
  },
};

const hostnameSegment: StatusLineSegment = {
  id: "hostname",
  render() {
    const icons = getIcons();
    const name = osHostname().split(".")[0];
    return { content: withIcon(icons.host, name), visible: true };
  },
};

const telegramSegment: StatusLineSegment = {
  id: "telegram",
  render(ctx) {
    const connected = getConnectedTelegramStatus(ctx.extensionStatuses) ?? hasTelegramConfig();
    if (!connected) return { content: "", visible: false };

    return { content: applyColor(ctx.theme, "success", getIcons().telegram), visible: true };
  },
};

const cacheReadSegment: StatusLineSegment = {
  id: "cache_read",
  render(ctx) {
    const { cacheRead } = ctx.usageStats;
    if (!cacheRead) return { content: "", visible: false };

    return { content: color(ctx, "tokens", formatTokens(cacheRead)), visible: true };
  },
};

const cacheWriteSegment: StatusLineSegment = {
  id: "cache_write",
  render(ctx) {
    const icons = getIcons();
    const { cacheWrite } = ctx.usageStats;
    if (!cacheWrite) return { content: "", visible: false };

    const parts = [icons.cache, icons.output, formatTokens(cacheWrite)].filter(Boolean);
    const content = parts.join(" ");
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const extensionStatusesSegment: StatusLineSegment = {
  id: "extension_statuses",
  render(ctx) {
    const statuses = ctx.extensionStatuses;
    if (!statuses || statuses.size === 0) return { content: "", visible: false };

    // Join compact statuses with a separator
    // Skip: empty strings, notification-style ("[...") shown above editor,
    // and strings that are only ANSI codes with no visible text.
    // Also skip statuses explicitly elevated into dedicated custom segments.
    const parts: string[] = [];
    for (const [statusKey, value] of statuses.entries()) {
      if (statusKey === "vim-mode" || statusKey === "vim-pending") continue;
      if (ctx.hiddenExtensionStatusKeys.has(statusKey)) continue;
      const normalized = value ? normalizeCompactExtensionStatus(value) : null;
      if (normalized) {
        parts.push(normalized);
      }
    }

    if (parts.length === 0) return { content: "", visible: false };

    // Statuses already have their own styling applied by the extensions
    const content = parts.join(` ${SEP_DOT} `);
    return { content, visible: true };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export const SEGMENTS: Record<BuiltinStatusLineSegmentId, StatusLineSegment> = {
  model: modelSegment,
  shell_mode: shellModeSegment,
  path: pathSegment,
  git: gitSegment,
  thinking: thinkingSegment,
  subagents: subagentsSegment,
  token_in: tokenInSegment,
  token_out: tokenOutSegment,
  token_total: tokenTotalSegment,
  cost: costSegment,
  context_pct: contextPctSegment,
  context_usage: contextUsageSegment,
  context_total: contextTotalSegment,
  time_spent: timeSpentSegment,
  time: timeSegment,
  session: sessionSegment,
  hostname: hostnameSegment,
  telegram: telegramSegment,
  cache_read: cacheReadSegment,
  cache_write: cacheWriteSegment,
  extension_statuses: extensionStatusesSegment,
};

function renderCustomSegment(id: `custom:${string}`, ctx: SegmentContext): RenderedSegment {
  const customItemId = id.slice("custom:".length);
  const custom = ctx.customItemsById.get(customItemId);
  if (!custom) return { content: "", visible: false };

  const rawStatus = ctx.extensionStatuses.get(custom.statusKey);
  const normalizedStatus = rawStatus ? normalizeExtensionStatusValue(rawStatus) : null;
  if (!normalizedStatus) {
    return custom.hideWhenMissing ? { content: "", visible: false } : { content: custom.prefix ?? custom.id, visible: true };
  }

  let content = normalizedStatus;
  if (custom.prefix) {
    content = `${custom.prefix}${SEP_DOT}${content}`;
  }
  if (custom.color) {
    content = applyColor(ctx.theme, custom.color, stripAnsi(content));
  }

  return { content, visible: true };
}

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
  if (id.startsWith("custom:")) {
    return renderCustomSegment(id, ctx);
  }

  const segment = SEGMENTS[id];
  if (!segment) {
    return { content: "", visible: false };
  }
  return segment.render(ctx);
}

import {
  copyToClipboard,
  type ExtensionAPI,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type SelectItem, SelectList, truncateToWidth, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId } from "./types.js";
import type { PowerlineConfig } from "./powerline-config.js";
import { BashTranscriptStore } from "./bash-mode/transcript.ts";
import {
  BashCompletionEngine,
  BashAutocompleteProvider,
  getOneOffBashCommandContext,
  ModeAwareAutocompleteProvider,
  OneOffBashAutocompleteProvider,
} from "./bash-mode/completion.ts";
import { BashModeEditor } from "./bash-mode/editor.ts";
import { ManagedShellSession } from "./bash-mode/shell-session.ts";
import { matchHistoryEntries, readGlobalShellHistory, readProjectHistory, appendProjectHistory } from "./bash-mode/history.ts";
import type { BashModeSettings } from "./bash-mode/types.ts";
import { getPreset, PRESETS } from "./presets.js";
import { getNotificationExtensionStatuses } from "./extension-status.js";
import { collectHiddenExtensionStatusKeys, mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions, nextPowerlineSettingWithPreset, parsePowerlineConfig } from "./powerline-config.js";
import { getSeparator } from "./separators.js";
import { renderSegment } from "./segments.js";
import { getSessionDisplay } from "./session-display.ts";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { ansi, getFgAnsiCode } from "./colors.js";
import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "./welcome.js";
import { createRenderScheduler } from "./render-scheduler.ts";
import { readCoreContextUsage } from "./context-usage.ts";
import { createFooterComponent } from "./footer-component.ts";
import { getDefaultColors } from "./theme.js";
import {
  isSupportedSuperShortcut,
  matchesConfiguredShortcut,
  shortcutConflictKey,
  shortcutUsesSuper,
} from "./shortcuts.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

let config: PowerlineConfig = {
  preset: "default",
  customItems: [],
  mouseScroll: true,
  fixedEditor: true,
};

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
let customCompactionEnabled = false;

interface PowerlineShortcuts {
  stashHistory: string;
  copyEditor: string;
  cutEditor: string;
  editorStart: string;
  editorEnd: string;
}

type PowerlineShortcutKey = keyof PowerlineShortcuts;

const STASH_HISTORY_LIMIT = 12;
const PROJECT_PROMPT_HISTORY_LIMIT = 50;
const STASH_PREVIEW_WIDTH = 72;
const DEFAULT_SHORTCUTS: PowerlineShortcuts = {
  stashHistory: "ctrl+alt+h",
  copyEditor: "ctrl+alt+c",
  cutEditor: "ctrl+alt+x",
  editorStart: "super+shift+up",
  editorEnd: "super+shift+down",
};
const DEFAULT_BASH_MODE_SETTINGS: BashModeSettings = {
  toggleShortcut: "ctrl+shift+b",
  transcriptMaxLines: 2000,
  transcriptMaxBytes: 512 * 1024,
};
const SHORTCUT_KEYS: PowerlineShortcutKey[] = [
  "stashHistory",
  "copyEditor",
  "cutEditor",
  "editorStart",
  "editorEnd",
];
const APP_RESERVED_SHORTCUTS = [
  "escape",
  "ctrl+c",
  "ctrl+d",
  "ctrl+z",
  "shift+tab",
  "ctrl+p",
  "shift+ctrl+p",
  "ctrl+l",
  "ctrl+o",
  "shift+ctrl+o",
  "ctrl+t",
  "ctrl+n",
  "ctrl+g",
  "alt+enter",
  "alt+up",
  "alt+down",
  "ctrl+v",
  "alt+v",
  "shift+l",
  "shift+t",
  "ctrl+s",
  "ctrl+r",
  "ctrl+backspace",
  "ctrl+a",
  "ctrl+x",
  "ctrl+u",
] as const;
const EXTRA_RESERVED_SHORTCUTS = ["alt+s"] as const;
const SHORTCUT_MODIFIER_ORDER = ["ctrl", "alt", "super", "shift"] as const;
const SHORTCUT_MODIFIERS = new Set(SHORTCUT_MODIFIER_ORDER);
const SHORTCUT_NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const SHORTCUT_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const PROMPT_HISTORY_LIMIT = 100;
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_STATUS_RENDER_MS = 250;
const PROMPT_HISTORY_TRACKED = Symbol.for("powerlinePromptHistoryTracked");
const PROMPT_HISTORY_STATE_KEY = Symbol.for("powerlinePromptHistoryState");

type PromptHistoryState = { savedPromptHistory: string[] };
type SessionAssistantUsage = AssistantMessage["usage"];

function getUsageTokenTotal(usage: SessionAssistantUsage): number {
  const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function hasSessionAssistantUsage(value: unknown): value is SessionAssistantUsage {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.input !== "number" ||
    typeof value.output !== "number" ||
    typeof value.cacheRead !== "number" ||
    typeof value.cacheWrite !== "number"
  ) {
    return false;
  }

  return isRecord(value.cost) && typeof value.cost.total === "number";
}

function isSessionAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value)
    && value.role === "assistant"
    && hasSessionAssistantUsage(value.usage)
    && (value.stopReason === undefined || typeof value.stopReason === "string");
}

function isPromptHistoryState(value: unknown): value is PromptHistoryState {
  return isRecord(value)
    && Array.isArray(value.savedPromptHistory)
    && value.savedPromptHistory.every((entry) => typeof entry === "string");
}

function getPromptHistoryState(): PromptHistoryState {
  const existing = Reflect.get(globalThis, PROMPT_HISTORY_STATE_KEY);
  if (isPromptHistoryState(existing)) {
    return existing;
  }

  const state: PromptHistoryState = { savedPromptHistory: [] };
  Reflect.set(globalThis, PROMPT_HISTORY_STATE_KEY, state);
  return state;
}

function readPromptHistory(editor: any): string[] {
  const history = editor?.history;
  if (!Array.isArray(history)) return [];

  const normalized: string[] = [];
  for (const entry of history) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (normalized.length > 0 && normalized[normalized.length - 1] === trimmed) continue;
    normalized.push(trimmed);
    if (normalized.length >= PROMPT_HISTORY_LIMIT) break;
  }

  return normalized;
}

function snapshotPromptHistory(editor: any): void {
  const history = readPromptHistory(editor);
  if (history.length > 0) {
    getPromptHistoryState().savedPromptHistory = [...history];
  }
}

function restorePromptHistory(editor: any): void {
  const { savedPromptHistory } = getPromptHistoryState();
  if (!savedPromptHistory.length || typeof editor?.addToHistory !== "function") return;

  for (let i = savedPromptHistory.length - 1; i >= 0; i--) {
    editor.addToHistory(savedPromptHistory[i]);
  }
}

function trackPromptHistory(editor: any): void {
  if (!editor || typeof editor.addToHistory !== "function") return;
  if (editor[PROMPT_HISTORY_TRACKED]) {
    snapshotPromptHistory(editor);
    return;
  }

  const originalAddToHistory = editor.addToHistory.bind(editor);
  editor.addToHistory = (text: string) => {
    originalAddToHistory(text);
    snapshotPromptHistory(editor);
  };
  editor[PROMPT_HISTORY_TRACKED] = true;
  snapshotPromptHistory(editor);
}

function getSettingsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function getGlobalCompactionPolicyPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "compaction-policy.json");
}

function getCustomCompactionExtensionPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "extensions", "pi-custom-compaction");
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] = isRecord(baseValue) && isRecord(overrideValue)
      ? mergeSettings(baseValue, overrideValue)
      : overrideValue;
  }

  return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }

    return parsed;
  } catch (error) {
    // Settings are user-edited input. Log and keep the extension running with defaults
    // instead of crashing the UI during startup.
    console.debug(`[powerline-footer] Failed to read settings from ${settingsPath}:`, error);
    return {};
  }
}

function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Refusing to write settings to non-object file at ${settingsPath}`);
      return null;
    }

    return parsed;
  } catch (error) {
    // Do not overwrite malformed user settings with partial data. Surface the failure
    // through the command handler so the user can fix the file intentionally.
    console.debug(`[powerline-footer] Failed to parse settings at ${settingsPath}:`, error);
    return null;
  }
}

function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return false;
    return parsed.enabled;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to read compaction policy from ${configPath}:`, error);
    return false;
  }
}

function detectCustomCompactionEnabled(cwd: string): boolean {
  if (!existsSync(getCustomCompactionExtensionPath())) return false;

  const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
  if (projectSetting !== undefined) return projectSetting;

  return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStashHistoryPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "powerline-footer", "stash-history.json");
}

function getSessionsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "sessions");
}

function getProjectSessionsPath(cwd: string): string {
  const projectKey = cwd
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[\\/]+/g, "-");

  return join(getSessionsPath(), `--${projectKey}--`);
}

function getPromptHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    parts.push(block.text);
  }

  return parts.join("\n").replace(/\s+/g, " ").trim();
}

function readRecentProjectPrompts(cwd: string, limit: number): string[] {
  const sessionsPath = getProjectSessionsPath(cwd);
  if (!existsSync(sessionsPath)) {
    return [];
  }

  const promptEntries: { text: string; timestamp: number }[] = [];
  const fileNames = readdirSync(sessionsPath)
    .filter((fileName) => fileName.endsWith(".jsonl"));

  for (const fileName of fileNames) {
    const filePath = join(sessionsPath, fileName);
    const lines = readFileSync(filePath, "utf-8").split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"type":"message"') || !line.includes('"role":"user"')) {
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse session file ${filePath}: ${message}`, { cause: error });
      }

      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") {
        continue;
      }

      const text = getPromptHistoryText(entry.message.content);
      if (!hasNonWhitespaceText(text)) {
        continue;
      }

      const timestamp = typeof entry.message.timestamp === "number"
        ? entry.message.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : 0;

      promptEntries.push({ text, timestamp: Number.isFinite(timestamp) ? timestamp : 0 });
    }
  }

  promptEntries.sort((a, b) => b.timestamp - a.timestamp);

  const prompts: string[] = [];
  const seen = new Set<string>();
  for (const entry of promptEntries) {
    if (seen.has(entry.text)) {
      continue;
    }

    seen.add(entry.text);
    prompts.push(entry.text);
    if (prompts.length >= limit) {
      return prompts;
    }
  }

  return prompts;
}

function normalizeStashHistoryEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    if (!hasNonWhitespaceText(entry)) {
      continue;
    }

    if (history[history.length - 1] === entry) {
      continue;
    }

    history.push(entry);
    if (history.length >= STASH_HISTORY_LIMIT) {
      break;
    }
  }

  return history;
}

function readPersistedStashHistory(): string[] {
  const stashHistoryPath = getStashHistoryPath();

  try {
    if (!existsSync(stashHistoryPath)) {
      return [];
    }

    const parsed = JSON.parse(readFileSync(stashHistoryPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Ignoring invalid stash history at ${stashHistoryPath}`);
      return [];
    }

    return normalizeStashHistoryEntries(parsed.history);
  } catch (error) {
    console.debug(`[powerline-footer] Failed to read stash history from ${stashHistoryPath}:`, error);
    return [];
  }
}

function persistStashHistory(history: string[]): void {
  const stashHistoryPath = getStashHistoryPath();
  const payload = {
    version: 1,
    history: history.slice(0, STASH_HISTORY_LIMIT),
  };

  try {
    mkdirSync(dirname(stashHistoryPath), { recursive: true });
    writeFileSync(stashHistoryPath, JSON.stringify(payload, null, 2) + "\n");
  } catch (error) {
    console.debug(`[powerline-footer] Failed to persist stash history to ${stashHistoryPath}:`, error);
  }
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
  return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

function writePowerlineSetting(cwd: string, update: (existingPowerlineSetting: unknown) => unknown): boolean {
  const globalSettingsPath = getSettingsPath();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalSettings = readWritableSettingsFile(globalSettingsPath);
  const projectSettings = readWritableSettingsFile(projectSettingsPath);

  if (globalSettings === null || projectSettings === null) {
    return false;
  }

  const writeToProject = Object.prototype.hasOwnProperty.call(projectSettings, "powerline");
  const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
  const settings = writeToProject ? projectSettings : globalSettings;

  settings.powerline = update(settings.powerline);

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to persist powerline setting to ${settingsPath}:`, error);
    return false;
  }
}

function writePowerlinePresetSetting(preset: StatusLinePreset, cwd: string = process.cwd()): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithPreset(existingPowerlineSetting, preset)
  ));
}

function writePowerlineOptionSetting(
  cwd: string,
  updates: Partial<Pick<PowerlineConfig, "mouseScroll" | "fixedEditor">>,
  currentPreset: StatusLinePreset,
): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithOptions(existingPowerlineSetting, updates, currentPreset)
  ));
}

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

function isValidPreset(value: unknown): value is StatusLinePreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRESETS, value);
}

function normalizePreset(value: unknown): StatusLinePreset | null {
  if (typeof value !== "string") {
    return null;
  }

  const preset = value.trim().toLowerCase();
  return isValidPreset(preset) ? preset : null;
}

function hasNonWhitespaceText(text: string): boolean {
  return text.trim().length > 0;
}

function getCurrentEditorText(ctx: any, editor: any): string {
  return editor?.getExpandedText?.() ?? ctx.ui.getEditorText();
}

function buildStashPreview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  return truncateToWidth(compact, maxWidth, "…");
}

function pushStashHistory(history: string[], text: string): boolean {
  if (!hasNonWhitespaceText(text)) return false;
  if (history[0] === text) return false;

  history.unshift(text);
  if (history.length > STASH_HISTORY_LIMIT) {
    history.length = STASH_HISTORY_LIMIT;
  }

  return true;
}

function normalizeShortcut(value: string): string {
  const parts = value.trim().toLowerCase().split("+");
  if (parts.length <= 1) return parts[0] ?? "";

  const modifierRank = new Map(SHORTCUT_MODIFIER_ORDER.map((modifier, index) => [modifier, index]));
  const modifiers = parts.slice(0, -1).sort((a, b) => (modifierRank.get(a) ?? 99) - (modifierRank.get(b) ?? 99));
  return [...modifiers, parts[parts.length - 1]].join("+");
}

function reservedShortcuts(): Set<string> {
  const shortcuts = new Set<string>([
    ...EXTRA_RESERVED_SHORTCUTS,
    ...APP_RESERVED_SHORTCUTS,
  ].map(normalizeShortcut));

  for (const definition of Object.values(TUI_KEYBINDINGS)) {
    const defaultKeys = definition.defaultKeys;
    const keys = defaultKeys === undefined ? [] : Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys];
    for (const key of keys) {
      shortcuts.add(normalizeShortcut(key));
    }
  }

  return shortcuts;
}

function isValidShortcutKeyPart(keyPart: string): boolean {
  const lowerKeyPart = keyPart.toLowerCase();

  if (/^[a-z0-9]$/i.test(keyPart)) return true;
  if (/^f([1-9]|1[0-2])$/i.test(keyPart)) return true;
  if (SHORTCUT_NAMED_KEYS.has(lowerKeyPart)) return true;

  return SHORTCUT_SYMBOL_KEYS.has(keyPart);
}

function parseShortcutOverride(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const parts = trimmed.split("+");
  if (parts.some((part) => part.length === 0)) {
    return null;
  }

  const modifierParts = parts.slice(0, -1).map((part) => {
    const modifier = part.toLowerCase();
    return modifier === "cmd" || modifier === "command" ? "super" : modifier;
  });
  if (new Set(modifierParts).size !== modifierParts.length) {
    return null;
  }

  for (const modifier of modifierParts) {
    if (!SHORTCUT_MODIFIERS.has(modifier)) {
      return null;
    }
  }

  const keyPart = parts[parts.length - 1];
  if (!isValidShortcutKeyPart(keyPart)) {
    return null;
  }

  const normalizedKey = SHORTCUT_SYMBOL_KEYS.has(keyPart) ? keyPart : keyPart.toLowerCase();
  const normalizedShortcut = normalizeShortcut([...modifierParts, normalizedKey].join("+"));
  if (shortcutUsesSuper(normalizedShortcut) && !isSupportedSuperShortcut(normalizedShortcut)) {
    return null;
  }

  return normalizedShortcut;
}

function shortcutUsageKey(shortcut: string): string {
  return shortcutConflictKey(normalizeShortcut(shortcut));
}

function findShortcutReplacement(key: PowerlineShortcutKey, used: Set<string>): string | null {
  const preferred = DEFAULT_SHORTCUTS[key];
  if (!used.has(shortcutUsageKey(preferred))) {
    return preferred;
  }

  for (const shortcutKey of SHORTCUT_KEYS) {
    const candidate = DEFAULT_SHORTCUTS[shortcutKey];
    if (!used.has(shortcutUsageKey(candidate))) {
      return candidate;
    }
  }

  return null;
}

function resolveShortcutConfig(settings: Record<string, unknown>): PowerlineShortcuts {
  const resolved: PowerlineShortcuts = { ...DEFAULT_SHORTCUTS };
  const shortcutSettings = settings.powerlineShortcuts;

  if (isRecord(shortcutSettings)) {
    for (const key of SHORTCUT_KEYS) {
      const override = parseShortcutOverride(shortcutSettings[key]);
      if (override) {
        resolved[key] = override;
      }
    }
  }

  const used = new Set(Array.from(reservedShortcuts(), shortcutUsageKey));

  for (const key of SHORTCUT_KEYS) {
    const configured = resolved[key];
    const configuredUsageKey = shortcutUsageKey(configured);

    if (!used.has(configuredUsageKey)) {
      used.add(configuredUsageKey);
      continue;
    }

    const replacement = findShortcutReplacement(key, used);
    if (!replacement) {
      console.debug(`[powerline-footer] Shortcut conflict for ${key}: "${configured}" is already in use`);
      continue;
    }

    console.debug(
      `[powerline-footer] Shortcut conflict for ${key}: "${configured}" replaced with "${replacement}"`,
    );

    resolved[key] = replacement;
    used.add(shortcutUsageKey(replacement));
  }

  return resolved;
}

function parseBashModeSettings(settings: Record<string, unknown>): BashModeSettings {
  const raw = isRecord(settings.bashMode) ? settings.bashMode : {};

  const configuredToggleShortcut = parseShortcutOverride(raw.toggleShortcut);
  const toggleShortcut = configuredToggleShortcut && !reservedShortcuts().has(shortcutUsageKey(configuredToggleShortcut))
    ? configuredToggleShortcut
    : DEFAULT_BASH_MODE_SETTINGS.toggleShortcut;

  if (configuredToggleShortcut && toggleShortcut !== configuredToggleShortcut) {
    console.debug(
      `[powerline-footer] Bash mode shortcut conflict: "${configuredToggleShortcut}" replaced with "${toggleShortcut}"`,
    );
  }
  const transcriptMaxLines = typeof raw.transcriptMaxLines === "number" && Number.isFinite(raw.transcriptMaxLines)
    ? Math.max(100, Math.floor(raw.transcriptMaxLines))
    : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxLines;
  const transcriptMaxBytes = typeof raw.transcriptMaxBytes === "number" && Number.isFinite(raw.transcriptMaxBytes)
    ? Math.max(16 * 1024, Math.floor(raw.transcriptMaxBytes))
    : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxBytes;

  return {
    toggleShortcut,
    transcriptMaxLines,
    transcriptMaxBytes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

function readVesperVariantColor(key: string, fallback: string): string {
  try {
    const path = join(homedir(), ".config", "vesper-variant.json");
    if (!existsSync(path)) return fallback;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readVesperPanelBg(): string {
  return readVesperVariantColor("panelBg", "#161616");
}

function readVesperPanelFg(): string {
  return readVesperVariantColor("panelFg", "#FEFEFE");
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function powerlineBarBackground(): string {
  const [r, g, b] = hexToRgbTuple(readVesperPanelBg());
  return ansi.getBgAnsi(r, g, b);
}

function joinPowerlineParts(parts: string[], presetDef: ReturnType<typeof getPreset>, bg: string): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;

  // Segment renderers use ANSI resets for their foreground colors, so re-apply
  // the background after each reset.
  const keepBg = (text: string) => text.replaceAll(ansi.reset, `${ansi.reset}${bg}`);
  return parts.map(keepBg).join(`${sepAnsi}${sep}${ansi.reset}${bg}`);
}

/** Build a full-width status-bar string from left and right rendered parts. */
function buildContentFromParts(
  leftParts: string[],
  presetDef: ReturnType<typeof getPreset>,
  width?: number,
  rightParts: string[] = [],
): string {
  if (leftParts.length === 0 && rightParts.length === 0) return "";

  const bg = powerlineBarBackground();
  const left = joinPowerlineParts(leftParts, presetDef, bg);
  const right = joinPowerlineParts(rightParts, presetDef, bg);
  const availableWidth = typeof width === "number" ? width : undefined;

  if (!right) {
    const content = `${left} `;
    const pad = availableWidth ? Math.max(0, availableWidth - visibleWidth(content)) : 0;
    return `${bg}${content}${" ".repeat(pad)}${ansi.reset}`;
  }

  if (!left) {
    const rightContent = `${right} `;
    const pad = availableWidth ? Math.max(0, availableWidth - visibleWidth(rightContent)) : 0;
    return `${bg}${" ".repeat(pad)}${rightContent}${ansi.reset}`;
  }

  const leftContent = `${left}`;
  const rightContent = `${right} `;
  const gap = availableWidth
    ? Math.max(0, availableWidth - visibleWidth(leftContent) - visibleWidth(rightContent))
    : 1;
  return `${bg}${leftContent}${" ".repeat(gap)}${rightContent}${ansi.reset}`;
}

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 */
function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number
): { topContent: string; secondaryContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it

  const mergedSegments = mergeSegmentsWithCustomItems(presetDef, config.customItems);

  const renderIds = (ids: readonly StatusLineSegmentId[]) => {
    const rendered: { id: StatusLineSegmentId; content: string; width: number }[] = [];
    for (const segId of ids) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
        rendered.push({ id: segId, content, width });
      }
    }
    return rendered;
  };

  let leftRendered = renderIds(mergedSegments.leftSegments);
  let rightRendered = renderIds(mergedSegments.rightSegments);
  const secondaryRendered = renderIds(mergedSegments.secondarySegments);

  if (leftRendered.length === 0 && rightRendered.length === 0 && secondaryRendered.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }

  const segmentsWidth = (segments: readonly { width: number }[]) =>
    segments.reduce((sum, seg, idx) => sum + seg.width + (idx > 0 ? sepWidth : 0), 0);
  const fullWidth = () => {
    const leftWidth = segmentsWidth(leftRendered);
    const rightWidth = segmentsWidth(rightRendered);
    if (leftWidth > 0 && rightWidth > 0) return leftWidth + rightWidth + 1;
    if (leftWidth > 0 || rightWidth > 0) return leftWidth + rightWidth + 1;
    return 0;
  };
  const rerenderFlexibleSegment = (
    seg: { id: StatusLineSegmentId; content: string; width: number },
    maxWidth: number,
  ) => {
    const boundedWidth = Math.max(0, Math.floor(maxWidth));
    const flexibleCtx: SegmentContext = {
      ...ctx,
      options: {
        ...ctx.options,
        session: seg.id === "session"
          ? { ...ctx.options.session, maxWidth: boundedWidth, showStash: false }
          : ctx.options.session,
        path: seg.id === "path"
          ? { ...ctx.options.path, maxWidth: boundedWidth }
          : ctx.options.path,
      },
    };
    return renderSegmentWithWidth(seg.id, flexibleCtx);
  };

  // Keep the statusline single-line. Truncate the session title first. Once the
  // session title is completely gone, remove whole metric segments (never partial
  // values like "3…") in priority order: cost, cache, cumulative tokens, then context.
  const sessionIndex = leftRendered.findIndex((seg) => seg.id === "session");
  if (sessionIndex !== -1 && fullWidth() > availableWidth) {
    const current = leftRendered[sessionIndex];
    const targetWidth = Math.max(0, current.width - (fullWidth() - availableWidth));
    const truncated = rerenderFlexibleSegment(current, targetWidth);
    if (truncated.visible) {
      leftRendered = leftRendered.map((seg, idx) => idx === sessionIndex ? { id: current.id, ...truncated } : seg);
    }
  }

  if (fullWidth() > availableWidth) {
    leftRendered = leftRendered.filter((seg) => seg.id !== "session");
  }

  for (const id of [
    "cost",
    "cache_hit",
    "cache_read",
    "cache_write",
    "token_total",
    "token_in",
    "token_out",
    "context_pct",
    "context_total",
    "context_usage",
  ] as const) {
    if (fullWidth() <= availableWidth) break;
    rightRendered = rightRendered.filter((seg) => seg.id !== id);
  }
  while (leftRendered.length > 0 && fullWidth() > availableWidth) {
    leftRendered.pop();
  }

  // Prefer dedicated right-side custom items (for example usage limits) over
  // generic model metadata on very narrow terminals. If the remaining custom
  // item still cannot fit, remove it whole rather than truncating a metric.
  for (const id of ["telegram", "model", "thinking"] as const) {
    if (fullWidth() <= availableWidth) break;
    rightRendered = rightRendered.filter((seg) => seg.id !== id);
  }
  while (rightRendered.length > 0 && fullWidth() > availableWidth) {
    rightRendered.shift();
  }

  const topLeftSegments = leftRendered.map((seg) => seg.content);
  const topRightSegments = rightRendered.map((seg) => seg.content);

  let secondaryWidth = 0;
  const secondarySegments: string[] = [];
  for (const seg of secondaryRendered) {
    const neededWidth = seg.width + (secondarySegments.length > 0 ? sepWidth : 0);
    if (secondaryWidth + neededWidth <= availableWidth) {
      secondarySegments.push(seg.content);
      secondaryWidth += neededWidth;
    } else {
      break;
    }
  }

  return {
    topContent: buildContentFromParts(topLeftSegments, presetDef, availableWidth, topRightSegments),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef, availableWidth),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function powerlineFooter(pi: ExtensionAPI) {
  const startupSettings = readSettings();
  config = parsePowerlineConfig(startupSettings.powerline, PRESET_NAMES);
  let resolvedShortcuts = resolveShortcutConfig(startupSettings);
  let bashModeSettings = parseBashModeSettings(startupSettings);

  let enabled = true;
  let sessionStartTime = Date.now();
  let sessionGeneration = 0;
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let currentThinkingLevel: string | null = null;
  let lastRenderedThinkingLevel: string | null = null;
  let liveAssistantUsage: SessionAssistantUsage | null = null;
  let isStreaming = false;
  let tuiRef: any = null;
  let autocompleteProviderInstalled = false;
  let dismissWelcomeOverlay: (() => void) | null = null;
  let welcomeHeaderActive = false;
  let welcomeOverlayShouldDismiss = false;
  let lastUserPrompt = "";
  let showLastPrompt = true;
  let stashedEditorText: string | null = null;
  let stashedPromptHistory: string[] = readPersistedStashHistory();
  let currentEditor: any = null;
  let inheritedEditorFactory: any = undefined;
  let inheritedEditorCaptured = false;
  let bashModeActive = false;
  let bashTranscript = new BashTranscriptStore(bashModeSettings);
  let bashCompletionEngine = new BashCompletionEngine();
  let shellSession: ManagedShellSession | null = null;

  // Cache for the top and secondary powerline widgets.
  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  let lastLayoutTimestamp = 0;
  let layoutDirty = true;
  let forceNextLayoutRecompute = false;

  const getShellPath = () => process.env.SHELL || "/bin/sh";
  const getShellCwd = () => shellSession?.state.cwd ?? currentCtx?.cwd ?? process.cwd();

  const statusRenderScheduler = createRenderScheduler(() => {
    tuiRef?.requestRender();
  }, STATUS_RENDER_DEBOUNCE_MS);

  const resetLayoutCache = () => {
    lastLayoutResult = null;
    layoutDirty = true;
  };

  const requestStatusRender = (delayMs?: number) => {
    layoutDirty = true;
    statusRenderScheduler.schedule(delayMs);
  };

  const requestImmediateStatusRender = (_options: { deferDuringTyping?: boolean } = {}) => {
    layoutDirty = true;
    forceNextLayoutRecompute = true;
    statusRenderScheduler.cancel();
    statusRenderScheduler.schedule(0);
  };

  const getShellHistoryEntries = (prefix: string): string[] => {
    const project = matchHistoryEntries(
      readProjectHistory(currentCtx?.cwd ?? process.cwd()).map((entry) => entry.command),
      prefix,
      50,
    );
    const global = matchHistoryEntries(readGlobalShellHistory(getShellPath()), prefix, 50);
    return [...new Set([...project, ...global])];
  };

  const ensureShellSession = async (): Promise<ManagedShellSession> => {
    if (!shellSession) {
      shellSession = new ManagedShellSession(
        getShellPath(),
        currentCtx?.cwd ?? process.cwd(),
        bashTranscript,
        requestStatusRender,
        (command, cwd) => appendProjectHistory(currentCtx?.cwd ?? process.cwd(), command, cwd),
      );
    }
    await shellSession.ensureReady();
    return shellSession;
  };

  const runShellCommand = async (command: string, ctx: any): Promise<void> => {
    try {
      const session = await ensureShellSession();
      await session.runCommand(command);
      requestStatusRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to run shell command: ${message}`, "error");
    }
  };

  const setBashModeActive = async (value: boolean, ctx: any): Promise<void> => {
    if (value === bashModeActive) return;
    if (!value && shellSession?.state.running) {
      ctx.ui.notify("Wait for the current shell command to finish before leaving bash mode", "warning");
      return;
    }

    if (value) {
      try {
        const session = await ensureShellSession();
        bashModeActive = true;
        currentEditor?.dismissBashModeUi?.();
        currentEditor?.refreshGhostSuggestion?.();
        requestStatusRender();
        ctx.ui.notify(`Bash mode enabled (${session.state.shellName})`, "info");
      } catch (error) {
        shellSession?.dispose();
        shellSession = null;
        bashModeActive = false;
        requestStatusRender();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to start shell session: ${message}`, "error");
      }
      return;
    }

    bashModeActive = value;
    currentEditor?.dismissBashModeUi?.();
    requestStatusRender();
    ctx.ui.notify("Bash mode disabled", "info");
  };

  function overlaySelectListTheme(theme: Theme) {
    return {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
  }

  async function showSelectOverlay(
    ctx: any,
    title: string,
    hint: string,
    items: SelectItem[],
    maxVisible: number,
  ): Promise<SelectItem | null> {
    return ctx.ui.custom<SelectItem | null>(
      (tui: any, theme: Theme, _keybindings: any, done: (result: SelectItem | null) => void) => {
        const selectList = new SelectList(items, maxVisible, overlaySelectListTheme(theme));
        const border = (text: string) => theme.fg("dim", text);
        const wrapRow = (text: string, innerWidth: number): string => {
          return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
        };

        selectList.onSelect = (item) => done(item);
        selectList.onCancel = () => done(null);

        return {
          render: (width: number) => {
            if (width < 3) {
              return selectList.render(Math.max(0, width)).map((line) =>
                truncateToWidth(line, Math.max(0, width), "", true));
            }

            const innerWidth = width - 2;
            const lines: string[] = [];

            lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
            lines.push(wrapRow(theme.fg("accent", theme.bold(title)), innerWidth));
            lines.push(border(`├${"─".repeat(innerWidth)}┤`));

            for (const line of selectList.render(innerWidth)) {
              lines.push(wrapRow(line, innerWidth));
            }

            lines.push(border(`├${"─".repeat(innerWidth)}┤`));
            lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
            lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

            return lines;
          },
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center" },
      },
    );
  }

  // Track session start
  pi.on("session_start", async (event, ctx) => {
    shellSession?.dispose();
    shellSession = null;
    sessionGeneration++;
    sessionStartTime = Date.now();
    currentCtx = ctx;
    customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);
    lastUserPrompt = "";
    isStreaming = false;
    liveAssistantUsage = null;
    stashedEditorText = null;

    const settings = readSettings(ctx.cwd);
    bashModeSettings = parseBashModeSettings(settings);
    resolvedShortcuts = resolveShortcutConfig(settings);
    showLastPrompt = settings.showLastPrompt !== false;
    config = parsePowerlineConfig(settings.powerline, PRESET_NAMES);
    stashedPromptHistory = readPersistedStashHistory();
    bashModeActive = false;
    bashTranscript = new BashTranscriptStore(bashModeSettings);
    bashCompletionEngine = new BashCompletionEngine();
    invalidateGitStatus();
    invalidateGitBranch();
    setTimeout(() => requestImmediateStatusRender({ deferDuringTyping: false }), 100);
    setTimeout(() => requestImmediateStatusRender({ deferDuringTyping: false }), 300);

    currentThinkingLevel = pi.getThinkingLevel();
    lastRenderedThinkingLevel = null;

    if (ctx.hasUI) {
      ctx.ui.setStatus("stash", undefined);
    }

    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
      // Startup welcome UI is disabled by default for this personal extension.
      // Set `showWelcome: true` in pi settings to opt back in.
      if (event.reason === "startup" && settings.showWelcome === true) {
        if (settings.quietStartup === true) {
          setupWelcomeHeader(ctx);
        } else {
          setupWelcomeOverlay(ctx);
        }
      } else {
        dismissWelcome(ctx);
      }
    }

  });

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    dismissWelcomeOverlay?.();
    dismissWelcomeOverlay = null;
    welcomeHeaderActive = false;
    welcomeOverlayShouldDismiss = false;
    statusRenderScheduler.cancel();
    shellSession?.dispose();
    shellSession = null;
    bashModeActive = false;
    currentCtx = null;
    footerDataRef = null;
    currentThinkingLevel = null;
    lastRenderedThinkingLevel = null;
    liveAssistantUsage = null;
    tuiRef = null;
    currentEditor = null;
    inheritedEditorFactory = undefined;
    inheritedEditorCaptured = false;
    resetLayoutCache();
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Invalidate git status on file changes, trigger re-render on potential branch changes
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    // Check for bash commands that might change git branch
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        // Invalidate caches since working tree state changes with branch
        invalidateGitStatus();
        invalidateGitBranch();
        // Small delay to let git update, then re-render
        setTimeout(() => requestStatusRender(), 100);
      }
    }
  });

  // Also catch user escape commands (! prefix)
  // Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
  // to ensure we catch the update after the command completes.
  pi.on("user_bash", async (event) => {
    if (mightChangeGitBranch(event.command)) {
      // Invalidate immediately so next render fetches fresh data
      invalidateGitStatus();
      invalidateGitBranch();
      // Multiple staggered re-renders to catch fast and slow commands
      setTimeout(() => requestStatusRender(), 100);
      setTimeout(() => requestStatusRender(), 300);
      setTimeout(() => requestStatusRender(), 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    requestStatusRender();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = typeof event.level === "string" ? event.level : pi.getThinkingLevel();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("before_agent_start", async (event) => {
    lastUserPrompt = event.prompt;
  });

  // Track streaming state (footer only shows status during streaming)
  // Also dismiss welcome when agent starts responding (handles `p "command"` case)
  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    liveAssistantUsage = null;
    dismissWelcome(ctx);
    currentCtx = ctx;
  });

  pi.on("message_update", async (event, ctx) => {
    if (isSessionAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && getUsageTokenTotal(event.message.usage) > 0) {
      liveAssistantUsage = event.message.usage;
      currentCtx = ctx;
      layoutDirty = true;
      statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    if (isSessionAssistantMessage(event.message)) {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        liveAssistantUsage = null;
      } else if (getUsageTokenTotal(event.message.usage) > 0) {
        liveAssistantUsage = event.message.usage;
      }
    }
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("tool_call", async (_event, ctx) => {
    dismissWelcome(ctx);
  });

  function dismissWelcome(ctx: any) {
    if (dismissWelcomeOverlay) {
      dismissWelcomeOverlay();
      dismissWelcomeOverlay = null;
    } else {
      // The startup overlay mounts after a delay; dismiss it immediately if it appears later.
      welcomeOverlayShouldDismiss = true;
    }
    if (welcomeHeaderActive) {
      welcomeHeaderActive = false;
      ctx.ui.setHeader(undefined);
    }
  }

  function addStashHistoryEntry(text: string): void {
    const changed = pushStashHistory(stashedPromptHistory, text);
    if (!changed) {
      return;
    }

    persistStashHistory(stashedPromptHistory);
  }

  function copyTextToClipboard(ctx: any, text: string, successMessage?: string): void {
    copyToClipboard(text);
    if (successMessage) {
      ctx.ui.notify(successMessage, "info");
    }
  }

  function getEditorTextForClipboard(ctx: any): string | null {
    const text = getCurrentEditorText(ctx, currentEditor);
    if (hasNonWhitespaceText(text)) {
      return text;
    }

    ctx.ui.notify("Editor is empty", "info");
    return null;
  }

  async function selectStashedPromptFromHistory(ctx: any): Promise<string | null> {
    const historyItems = [...stashedPromptHistory];
    const items: SelectItem[] = historyItems.map((entry, index) => ({
      value: String(index),
      label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
    }));

    const selected = await showSelectOverlay(
      ctx, "Stash history", "↑↓ navigate • enter insert • esc cancel",
      items, Math.min(items.length, 10));
    if (!selected) return null;

    const i = Number.parseInt(selected.value, 10);
    return historyItems[i] ?? null;
  }

  async function selectProjectPromptFromHistory(ctx: any, prompts: string[]): Promise<string | null> {
    const items: SelectItem[] = prompts.map((entry, index) => ({
      value: String(index),
      label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
    }));

    const selected = await showSelectOverlay(
      ctx, "Recent project prompts", "↑↓ navigate • enter insert • esc cancel",
      items, Math.min(items.length, 10));
    if (!selected) return null;

    const i = Number.parseInt(selected.value, 10);
    return prompts[i] ?? null;
  }

  async function selectPromptHistorySource(
    ctx: any,
    stashCount: number,
    projectPromptCount: number,
  ): Promise<"stash" | "project" | null> {
    const items: SelectItem[] = [];

    if (stashCount > 0) {
      items.push({
        value: "stash",
        label: "Stashed prompts",
        description: `${stashCount} saved`,
      });
    }

    if (projectPromptCount > 0) {
      items.push({
        value: "project",
        label: "Recent project prompts",
        description: `${projectPromptCount} recent`,
      });
    }

    if (items.length === 0) {
      return null;
    }

    if (items.length === 1) {
      return items[0]?.value === "project" ? "project" : "stash";
    }

    const selected = await showSelectOverlay(
      ctx, "Prompt history", "↑↓ navigate • enter open • esc cancel",
      items, items.length);
    if (!selected) return null;

    return selected.value === "project" ? "project" : "stash";
  }

  async function insertSelectedPromptHistoryEntry(ctx: any, selected: string): Promise<void> {
    const currentText = getCurrentEditorText(ctx, currentEditor);
    if (!hasNonWhitespaceText(currentText)) {
      ctx.ui.setEditorText(selected);
      ctx.ui.notify("Inserted prompt", "info");
      return;
    }

    const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);

    if (action === "Replace") {
      ctx.ui.setEditorText(selected);
      ctx.ui.notify("Replaced editor with prompt", "info");
      return;
    }

    if (action === "Append") {
      const separator = currentText.endsWith("\n") || selected.startsWith("\n") ? "" : "\n";
      ctx.ui.setEditorText(`${currentText}${separator}${selected}`);
      ctx.ui.notify("Appended prompt", "info");
    }
  }

  function stashOrRestoreEditorText(ctx: any): void {
    const rawText = getCurrentEditorText(ctx, currentEditor);
    const hasStash = stashedEditorText !== null;

    if (!hasNonWhitespaceText(rawText)) {
      if (!hasStash) {
        ctx.ui.notify("Nothing to stash", "info");
        return;
      }

      ctx.ui.setEditorText(stashedEditorText);
      stashedEditorText = null;
      ctx.ui.setStatus("stash", undefined);
      ctx.ui.notify("Stash restored", "info");
      return;
    }

    stashedEditorText = rawText;
    addStashHistoryEntry(rawText);
    ctx.ui.setEditorText("");
    ctx.ui.setStatus("stash", "stash");
    ctx.ui.notify(hasStash ? "Stash updated" : "Text stashed", "info");
  }

  async function openStashHistory(ctx: any): Promise<void> {
    let projectPrompts: string[] = [];

    try {
      projectPrompts = readRecentProjectPrompts(ctx.cwd, PROJECT_PROMPT_HISTORY_LIMIT);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to load project prompts: ${message}`, "warning");
    }

    if (stashedPromptHistory.length === 0 && projectPrompts.length === 0) {
      ctx.ui.notify("No prompt history yet", "info");
      return;
    }

    const source = await selectPromptHistorySource(ctx, stashedPromptHistory.length, projectPrompts.length);
    if (!source) {
      return;
    }

    const selected = source === "project"
      ? await selectProjectPromptFromHistory(ctx, projectPrompts)
      : await selectStashedPromptFromHistory(ctx);
    if (!selected) return;

    await insertSelectedPromptHistoryEntry(ctx, selected);
  }

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    liveAssistantUsage = null;
    currentCtx = ctx;
    if (ctx.hasUI) {
      if (stashedEditorText !== null) {
        if (ctx.ui.getEditorText().trim() === "") {
          ctx.ui.setEditorText(stashedEditorText);
          stashedEditorText = null;
          ctx.ui.setStatus("stash", undefined);
          ctx.ui.notify("Stash restored", "info");
        } else {
          ctx.ui.notify("Stash preserved - clear editor then Alt+S to restore", "info");
        }
      }
    }
    requestStatusRender();
  });

  // Command to toggle/configure
  pi.registerCommand("powerline", {
    description: "Configure powerline status (toggle, preset)",
    handler: async (args, ctx) => {
      // Update context reference (command ctx may have more methods)
      currentCtx = ctx;

      if (!args?.trim()) {
        // Toggle
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          shellSession?.dispose();
          shellSession = null;
          bashTranscript.clear();
          bashModeActive = false;
          dismissWelcomeOverlay?.();
          dismissWelcomeOverlay = null;
          welcomeHeaderActive = false;
          welcomeOverlayShouldDismiss = false;
          getPromptHistoryState().savedPromptHistory = [];
          stashedEditorText = null;
          ctx.ui.setStatus("stash", undefined);
          // Clear all custom UI components and restore the editor that was
          // installed before this extension.
          ctx.ui.setEditorComponent(inheritedEditorFactory);
          ctx.ui.setFooter(undefined);
          ctx.ui.setHeader(undefined);
          ctx.ui.setWidget("powerline-top", undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-bash-transcript", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          ctx.ui.setWidget("powerline-last-prompt", undefined);
          footerDataRef = null;
          tuiRef = null;
          currentEditor = null;
          statusRenderScheduler.cancel();
          resetLayoutCache();
          ctx.ui.notify("Powerline disabled", "info");
        }
        return;
      }

      const normalizedArgs = args.trim().toLowerCase();
      const mouseScrollMatch = /^mouse-scroll(?:\s+(on|off|toggle))?$/.exec(normalizedArgs);
      if (mouseScrollMatch) {
        const mode = mouseScrollMatch[1] ?? "toggle";
        config.mouseScroll = mode === "toggle" ? !config.mouseScroll : mode === "on";

        if (writePowerlineOptionSetting(ctx.cwd, { mouseScroll: config.mouseScroll }, config.preset)) {
          ctx.ui.notify("Mouse-scroll preference saved; Pi 0.84 controls fullscreen transcript scrolling", "info");
        } else {
          ctx.ui.notify("Mouse-scroll preference not persisted; Pi 0.84 controls fullscreen transcript scrolling", "warning");
        }
        return;
      }

      const fixedEditorMatch = /^fixed-editor(?:\s+(on|off|toggle))?$/.exec(normalizedArgs);
      if (fixedEditorMatch) {
        const mode = fixedEditorMatch[1] ?? "toggle";
        config.fixedEditor = mode === "toggle" ? !config.fixedEditor : mode === "on";
        if (enabled && ctx.hasUI) {
          setupCustomEditor(ctx);
        }

        const editorState = config.fixedEditor ? "enabled" : "disabled";
        if (writePowerlineOptionSetting(ctx.cwd, { fixedEditor: config.fixedEditor }, config.preset)) {
          ctx.ui.notify(`Powerline custom editor ${editorState}; Pi controls the fullscreen dock`, "info");
        } else {
          ctx.ui.notify(`Powerline custom editor ${editorState} (not persisted); Pi controls the fullscreen dock`, "warning");
        }
        return;
      }

      const preset = normalizePreset(args);
      if (preset) {
        config.preset = preset;
        resetLayoutCache();
        if (enabled) {
          setupCustomEditor(ctx);
        }

        if (writePowerlinePresetSetting(preset, ctx.cwd)) {
          ctx.ui.notify(`Preset set to: ${preset}`, "info");
        } else {
          ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // Show available presets
      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });

  pi.registerCommand("stash-history", {
    description: "Open prompt history picker",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (!enabled) {
        ctx.ui.notify("Powerline is disabled", "info");
        return;
      }

      await openStashHistory(ctx);
    },
  });

  pi.registerCommand("bash-mode", {
    description: "Toggle sticky bash mode (on, off, toggle)",
    handler: async (args, ctx) => {
      const mode = args?.trim().toLowerCase() || "toggle";
      if (mode === "on") {
        await setBashModeActive(true, ctx);
        return;
      }
      if (mode === "off") {
        await setBashModeActive(false, ctx);
        return;
      }
      if (mode === "toggle") {
        await setBashModeActive(!bashModeActive, ctx);
        return;
      }
      ctx.ui.notify("Usage: /bash-mode [on|off|toggle]", "warning");
    },
  });

  pi.registerCommand("bash-reset", {
    description: "Reset the managed bash session",
    handler: async (_args, ctx) => {
      shellSession?.dispose();
      shellSession = null;
      bashTranscript.clear();
      if (bashModeActive) {
        try {
          await ensureShellSession();
        } catch (error) {
          bashModeActive = false;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to restart shell session: ${message}`, "error");
          requestStatusRender();
          return;
        }
      }
      requestStatusRender();
      ctx.ui.notify("Bash session reset", "info");
    },
  });

  pi.registerShortcut(bashModeSettings.toggleShortcut, {
    description: "Toggle bash mode",
    handler: async (ctx) => {
      if (!enabled || !ctx.hasUI) return;
      await setBashModeActive(!bashModeActive, ctx);
    },
  });

  pi.registerShortcut("alt+s", {
    description: "Stash/restore editor text",
    handler: async (ctx) => {
      if (!enabled || !ctx.hasUI) return;
      stashOrRestoreEditorText(ctx);
    },
  });

  pi.registerShortcut(resolvedShortcuts.stashHistory, {
    description: "Open prompt history picker",
    handler: async (ctx) => {
      if (!enabled || !ctx.hasUI) return;
      await openStashHistory(ctx);
    },
  });

  pi.registerShortcut(resolvedShortcuts.copyEditor, {
    description: "Copy full editor text",
    handler: async (ctx) => {
      if (!enabled || !ctx.hasUI) return;

      const text = getEditorTextForClipboard(ctx);
      if (!text) return;

      copyTextToClipboard(ctx, text, "Copied editor text");
    },
  });

  pi.registerShortcut(resolvedShortcuts.cutEditor, {
    description: "Cut full editor text",
    handler: async (ctx) => {
      if (!enabled || !ctx.hasUI) return;

      const text = getEditorTextForClipboard(ctx);
      if (!text) return;

      copyTextToClipboard(ctx, text);
      ctx.ui.setEditorText("");
      ctx.ui.notify("Cut editor text", "info");
    },
  });

  function buildSegmentContext(ctx: any, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevelFromSession: string | null = null;

    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      if (!isRecord(e)) {
        continue;
      }

      // Check for thinking level change entries
      if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
        thinkingLevelFromSession = e.thinkingLevel;
      }

      if (e.type !== "message" || !isSessionAssistantMessage(e.message)) {
        continue;
      }

      const m = e.message;
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        continue;
      }
      input += m.usage.input;
      output += m.usage.output;
      cacheRead += m.usage.cacheRead;
      cacheWrite += m.usage.cacheWrite;
      cost += m.usage.cost.total;
      if (getUsageTokenTotal(m.usage) > 0) {
        lastAssistant = m;
      }
    }

    // Calculate context percentage.
    const latestUsage = isStreaming ? liveAssistantUsage ?? lastAssistant?.usage : lastAssistant?.usage;
    const coreContextUsage = isStreaming && liveAssistantUsage ? null : readCoreContextUsage(ctx);
    const contextTokens = coreContextUsage?.contextTokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
    const contextWindow = coreContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPercent = coreContextUsage?.contextPercent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);

    // Get git status (cached)
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch);
    const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
    const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const thinkingLevel = currentThinkingLevel ?? pi.getThinkingLevel() ?? thinkingLevelFromSession ?? "off";

    return {
      model: ctx.model,
      thinkingLevel,
      sessionId: ctx.sessionManager?.getSessionId?.(),
      sessionName: ctx.sessionManager?.getSessionName?.(),
      lastUserPrompt,
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      lastTurnUsage: latestUsage,
      contextTokens,
      contextPercent,
      contextWindow,
      customCompactionEnabled: customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
      sessionStartTime,
      shellModeActive: bashModeActive,
      shellRunning: shellSession?.state.running ?? false,
      shellName: shellSession?.state.shellName ?? null,
      shellCwd: shellSession?.state.cwd ?? null,
      git: gitStatus,
      extensionStatuses,
      hiddenExtensionStatusKeys,
      customItemsById,
      options: presetDef.segmentOptions ?? {},
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   * The segment context scans session state, so keep it stable across render bursts.
   */
  function getResponsiveLayout(width: number, theme: Theme): { topContent: string; secondaryContent: string } {
    const now = Date.now();
    const cacheTtl = isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

    if (lastLayoutResult && lastLayoutWidth === width) {
      const latestThinkingLevel = currentThinkingLevel ?? pi.getThinkingLevel();
      if (latestThinkingLevel !== lastRenderedThinkingLevel) {
        layoutDirty = true;
        forceNextLayoutRecompute = true;
      }

      if (!layoutDirty && now - lastLayoutTimestamp < cacheTtl) {
        return lastLayoutResult;
      }
    }

    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, theme);

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, width);
    lastRenderedThinkingLevel = segmentCtx.thinkingLevel;
    lastLayoutTimestamp = now;
    layoutDirty = false;
    forceNextLayoutRecompute = false;

    return lastLayoutResult;
  }

  function renderPowerlineStatusLines(width: number): string[] {
    if (!currentCtx || !footerDataRef) return [];

    const statuses = footerDataRef.getExtensionStatuses();
    if (!statuses || statuses.size === 0) return [];
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const notifications: string[] = [];
    for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
      const lineContent = ` ${value}`;
      if (visibleWidth(lineContent) <= width) {
        notifications.push(lineContent);
      }
    }

    return notifications;
  }

  function renderPowerlineTopLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    const layout = getResponsiveLayout(width, theme);
    return layout.topContent ? [layout.topContent] : [];
  }

  function renderPowerlineSecondaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    const layout = getResponsiveLayout(width, theme);
    return layout.secondaryContent ? [layout.secondaryContent] : [];
  }

  function renderBashTranscriptLines(width: number, theme: Theme): string[] {
    if (!bashModeActive) return [];

    const snapshot = bashTranscript.getSnapshot();
    if (snapshot.commands.length === 0) return [];

    const lines: string[] = [];
    if (snapshot.truncatedCommands > 0) {
      lines.push(` ${theme.fg("dim", `… ${snapshot.truncatedCommands} earlier command${snapshot.truncatedCommands === 1 ? "" : "s"} truncated`)}`);
    }

    const recentCommands = snapshot.commands.slice(-4);
    for (const command of recentCommands) {
      const promptGlyph = (shellSession?.state.shellName ?? "shell") === "fish" ? ">" : "$";
      const status = command.exitCode === null
        ? theme.fg("accent", "running")
        : command.exitCode === 0
          ? theme.fg("success", "ok")
          : theme.fg("error", `exit ${command.exitCode}`);
      const commandLine = truncateToWidth(command.command.replace(/\s+/g, " ").trim(), Math.max(8, width - 8), "…");
      lines.push(` ${theme.fg("accent", promptGlyph)} ${commandLine} ${theme.fg("dim", "(")}${status}${theme.fg("dim", ")")}`);

      const outputTail = command.output.slice(-6);
      for (const outputLine of outputTail) {
        lines.push(`   ${truncateToWidth(outputLine, Math.max(1, width - 3), "…")}`);
      }
    }

    return lines.slice(-16);
  }

  function getInlineVimStatus(): { mode: string | null; pending: string | null } {
    const statuses = footerDataRef?.getExtensionStatuses();
    if (!statuses) return { mode: null, pending: null };

    return {
      mode: statuses.get("vim-mode")?.replace(/\s+/g, " ").trim() || null,
      pending: statuses.get("vim-pending")?.replace(/\s+/g, " ").trim() || null,
    };
  }

  function renderLastPromptLines(width: number): string[] {
    if (bashModeActive || !showLastPrompt) return [];

    const vimStatus = getInlineVimStatus();
    const [vimR, vimG, vimB] = hexToRgbTuple(readVesperPanelFg());
    const vimPrefix = vimStatus.mode ? ` ${ansi.getFgAnsi(vimR, vimG, vimB)}${vimStatus.mode}${ansi.reset} ` : "";
    let pendingSuffix = vimStatus.pending ? ` ${getFgAnsiCode("muted")}${vimStatus.pending}${ansi.reset} ` : "";
    const sessionDisplay = getSessionDisplay(
      currentCtx?.sessionManager?.getSessionName?.(),
      lastUserPrompt,
      currentCtx?.sessionManager?.getSessionId?.(),
    );
    const promptPrefix = `${getFgAnsiCode("sep")}↳${ansi.reset} `;
    const prefix = `${vimPrefix}${promptPrefix}`;
    let availableWidth = width - visibleWidth(prefix) - visibleWidth(pendingSuffix);

    if (pendingSuffix && availableWidth < 10) {
      pendingSuffix = "";
      availableWidth = width - visibleWidth(prefix);
    }
    if (availableWidth < 10) {
      const line = truncateToWidth(vimPrefix, width, "…");
      return line ? [line] : [""];
    }

    const sessionText = truncateToWidth(sessionDisplay, availableWidth, "…");
    const styledSession = `${getFgAnsiCode("sep")}${sessionText}${ansi.reset}`;
    const left = `${prefix}${styledSession}`;
    if (pendingSuffix && visibleWidth(left) + 1 + visibleWidth(pendingSuffix) > width) {
      pendingSuffix = "";
    }
    const gap = pendingSuffix
      ? " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(pendingSuffix)))
      : "";
    return [`${left}${gap}${pendingSuffix}`];
  }

  function clearPowerlineWidgets(ctx: any) {
    ctx.ui.setWidget("powerline-status", undefined);
    ctx.ui.setWidget("powerline-top", undefined);
    ctx.ui.setWidget("powerline-secondary", undefined);
    ctx.ui.setWidget("powerline-bash-transcript", undefined);
    ctx.ui.setWidget("powerline-last-prompt", undefined);
  }


  function setupCustomEditor(ctx: any) {
    snapshotPromptHistory(currentEditor);
    if (!enabled) {
      return;
    }

    if (!inheritedEditorCaptured) {
      inheritedEditorFactory = ctx.ui.getEditorComponent();
      inheritedEditorCaptured = true;
    }

    clearPowerlineWidgets(ctx);

    if (!autocompleteProviderInstalled) {
      ctx.ui.addAutocompleteProvider((current: any) => new ModeAwareAutocompleteProvider(
        current,
        new BashAutocompleteProvider(),
        new OneOffBashAutocompleteProvider(),
        () => bashModeActive,
      ));
      autocompleteProviderInstalled = true;
    }

    class PowerlineEditor extends BashModeEditor {
      render(width: number): string[] {
        if (width < 10) {
          return super.render(width);
        }

        const border = (text: string) => `${getFgAnsiCode("sep")}${text}${ansi.reset}`;
        const promptGlyph = bashModeActive ? "$" : ">";
        const prompt = `${ansi.getFgAnsi(200, 200, 200)}${promptGlyph}${ansi.reset}`;
        const promptPrefix = ` ${prompt} `;
        const contentWidth = Math.max(1, width - 3);
        const lines = super.render(contentWidth);
        if (lines.length === 0) return lines;

        let bottomBorderIndex = lines.length - 1;
        for (let i = lines.length - 1; i >= 1; i--) {
          const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
          if (/^─{3,}/.test(stripped)) {
            bottomBorderIndex = i;
            break;
          }
        }

        const result = [` ${border("─".repeat(width - 2))}`];
        for (let i = 1; i < bottomBorderIndex; i++) {
          result.push(`${i === 1 ? promptPrefix : "   "}${lines[i] || ""}`);
        }
        if (bottomBorderIndex === 1) {
          result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
        }
        result.push(` ${border("─".repeat(width - 2))}`);
        result.push(...lines.slice(bottomBorderIndex + 1));

        return result.map((line) => visibleWidth(line) > width
          ? truncateToWidth(line, width, "", true)
          : line);
      }
    }

    const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
      const editor = new PowerlineEditor(tui, editorTheme, keybindings, {
        keybindings,
        isBashModeActive: () => bashModeActive,
        isShellRunning: () => shellSession?.state.running ?? false,
        onExitBashMode: () => {
          void setBashModeActive(false, ctx);
        },
        onSubmitCommand: (command) => void runShellCommand(command, ctx),
        editorBoundaryShortcuts: {
          start: resolvedShortcuts.editorStart,
          end: resolvedShortcuts.editorEnd,
        },
        onInterrupt: () => {
          shellSession?.interrupt();
          ctx.ui.notify("Sent interrupt to shell", "info");
        },
        onNotify: (message, level = "info") => ctx.ui.notify(message, level),
        getHistoryEntries: (prefix) => getShellHistoryEntries(prefix),
        resolveGhostSuggestion: async (text, signal) => {
          const oneOffBash = getOneOffBashCommandContext(text);
          if (oneOffBash) {
            const ghost = await bashCompletionEngine.getGhostSuggestion(
              oneOffBash.command,
              getShellCwd(),
              getShellPath(),
              signal,
            );
            return ghost ? { ...ghost, value: `${oneOffBash.prefix}${ghost.value}` } : null;
          }

          return bashCompletionEngine.getGhostSuggestion(text, getShellCwd(), getShellPath(), signal);
        },
      });

      currentEditor = editor;
      trackPromptHistory(editor);
      restorePromptHistory(editor);
      return editor;
    };

    if (config.fixedEditor) {
      ctx.ui.setEditorComponent(editorFactory);
    } else if (currentEditor) {
      currentEditor = null;
      ctx.ui.setEditorComponent(inheritedEditorFactory);
    }
    // On initial startup with fixedEditor disabled, leave the inherited editor
    // untouched. This preserves editors loaded earlier, notably pi-vim.
    clearPowerlineWidgets(ctx);

    ctx.ui.setFooter((tui: any, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;

      return createFooterComponent({
        onBranchChange: (listener) => footerData.onBranchChange(listener),
        requestRender: () => tui.requestRender(),
        onInvalidate: resetLayoutCache,
        onDispose: () => {
          if (footerDataRef === footerData) footerDataRef = null;
          if (tuiRef === tui) tuiRef = null;
        },
        renderLines: (width) => {
          // Status values can change between ordinary Pi render passes. Rebuild
          // the layout instead of caching a stale FooterDataProvider snapshot.
          resetLayoutCache();
          return [
            ...renderPowerlineTopLines(width, theme),
            ...renderPowerlineSecondaryLines(width, theme),
            ...renderBashTranscriptLines(width, theme),
            ...renderLastPromptLines(width),
            ...renderPowerlineStatusLines(width),
          ];
        },
        fitLine: (line, width) => visibleWidth(line) > width
          ? truncateToWidth(line, width, "", true)
          : line,
      });
    });
  }

  function setupWelcomeHeader(ctx: any) {
    const modelName = ctx.model?.name || ctx.model?.id || "No model";
    const providerName = ctx.model?.provider || "Unknown";
    const loadedCounts = discoverLoadedCounts();
    const recentSessions = getRecentSessions(3);

    const header = new WelcomeHeader(modelName, providerName, recentSessions, loadedCounts);
    welcomeHeaderActive = true;

    ctx.ui.setHeader(() => {
      return {
        render(width: number): string[] {
          return header.render(width);
        },
        invalidate() {
          header.invalidate();
        },
      };
    });
  }

  function setupWelcomeOverlay(ctx: any) {
    const modelName = ctx.model?.name || ctx.model?.id || "No model";
    const providerName = ctx.model?.provider || "Unknown";
    const loadedCounts = discoverLoadedCounts();
    const recentSessions = getRecentSessions(3);

    const overlaySessionGeneration = sessionGeneration;

    // Small delay to let pi-mono finish initialization
    setTimeout(() => {
      if (!enabled || welcomeOverlayShouldDismiss || isStreaming || overlaySessionGeneration !== sessionGeneration) {
        welcomeOverlayShouldDismiss = false;
        return;
      }

      const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
      const hasActivity = sessionEvents.some((entry: unknown) => {
        if (!isRecord(entry)) return false;
        if (entry.type === "tool_call" || entry.type === "tool_result") return true;
        return entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant";
      });
      if (hasActivity) {
        return;
      }

      ctx.ui.custom(
        (tui: any, _theme: any, _keybindings: any, done: (result: void) => void) => {
          const welcome = new WelcomeComponent(
            modelName,
            providerName,
            recentSessions,
            loadedCounts,
          );

          let countdown = 30;
          let dismissed = false;
          let interval: ReturnType<typeof setInterval> | null = null;

          const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            if (interval) clearInterval(interval);
            dismissWelcomeOverlay = null;
            done();
          };

          interval = setInterval(() => {
            if (dismissed) return;
            countdown--;
            welcome.setCountdown(countdown);
            tui.requestRender();
            if (countdown <= 0) dismiss();
          }, 1000);

          dismissWelcomeOverlay = dismiss;

          if (welcomeOverlayShouldDismiss) {
            welcomeOverlayShouldDismiss = false;
            dismiss();
          }

          return {
            focused: false,
            invalidate: () => welcome.invalidate(),
            render: (width: number) => welcome.render(width),
            handleInput: () => dismiss(),
            dispose: () => {
              dismissed = true;
              if (interval) clearInterval(interval);
            },
          };
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center" },
        },
      ).catch((error) => {
        console.debug("[powerline-footer] Welcome overlay failed:", error);
      });
    }, 100);
  }
}

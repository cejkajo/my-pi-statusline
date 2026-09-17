import assert from "node:assert/strict";
import test from "node:test";
import { mergeSegmentsWithCustomItems, parsePowerlineConfig } from "../powerline-config.ts";
import { getPreset } from "../presets.ts";
import type { CustomStatusItem, PresetDef, StatusLinePreset } from "../types.ts";

const PRESET_NAMES: readonly StatusLinePreset[] = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"];

function item(overrides: Partial<CustomStatusItem> & { id: string }): CustomStatusItem {
  return {
    statusKey: overrides.id,
    position: "right",
    anchorPlacement: "after",
    hideWhenMissing: true,
    excludeFromExtensionStatuses: true,
    ...overrides,
  };
}

function preset(overrides: Partial<PresetDef> = {}): PresetDef {
  return {
    leftSegments: ["path", "git"],
    rightSegments: ["model", "thinking", "context_usage"],
    secondarySegments: [],
    separator: "pipe",
    ...overrides,
  };
}

test("keeps historical placement for items without an anchor", () => {
  const merged = mergeSegmentsWithCustomItems(preset(), [
    item({ id: "a", position: "left" }),
    item({ id: "b", position: "right" }),
    item({ id: "c", position: "secondary" }),
  ]);

  assert.deepEqual(merged.leftSegments, ["custom:a", "path", "git"]);
  assert.deepEqual(merged.rightSegments, ["model", "thinking", "context_usage", "custom:b"]);
  assert.deepEqual(merged.secondarySegments, ["custom:c"]);
});

test("anchors an item directly after a built-in segment of the default preset", () => {
  const merged = mergeSegmentsWithCustomItems(getPreset("default"), [
    item({ id: "openai-codex-fast-local", anchor: "model" }),
  ]);

  assert.deepEqual(merged.rightSegments, [
    "telegram",
    "model",
    "custom:openai-codex-fast-local",
    "thinking",
    "cache_hit",
    "context_usage",
  ]);
});

test("anchors an item directly before a built-in segment", () => {
  const merged = mergeSegmentsWithCustomItems(preset(), [
    item({ id: "a", anchor: "thinking", anchorPlacement: "before" }),
  ]);

  assert.deepEqual(merged.rightSegments, ["model", "custom:a", "thinking", "context_usage"]);
});

test("anchors an item to another custom item, by bare id and by custom: id", () => {
  const merged = mergeSegmentsWithCustomItems(preset(), [
    item({ id: "a", anchor: "model" }),
    item({ id: "b", anchor: "a" }),
    item({ id: "c", anchor: "custom:b" }),
  ]);

  assert.deepEqual(merged.rightSegments, ["model", "custom:a", "custom:b", "custom:c", "thinking", "context_usage"]);
});

test("inherits the side of its anchor instead of the configured position", () => {
  const merged = mergeSegmentsWithCustomItems(preset(), [
    item({ id: "a", position: "right", anchor: "path" }),
    item({ id: "b", position: "left", anchor: "context_usage" }),
  ]);

  assert.deepEqual(merged.leftSegments, ["path", "custom:a", "git"]);
  assert.deepEqual(merged.rightSegments, ["model", "thinking", "context_usage", "custom:b"]);
});

test("falls back to position when the anchor is unknown or disabled by the preset", () => {
  const merged = mergeSegmentsWithCustomItems(preset(), [
    item({ id: "a", position: "left", anchor: "nope" }),
    item({ id: "b", position: "right", anchor: "telegram" }),
    item({ id: "c", position: "right", anchor: "c" }),
  ]);

  assert.deepEqual(merged.leftSegments, ["custom:a", "path", "git"]);
  assert.deepEqual(merged.rightSegments, ["model", "thinking", "context_usage", "custom:b", "custom:c"]);
});

test("falls back to position for custom-item anchor cycles without throwing", () => {
  const merged = mergeSegmentsWithCustomItems(preset(), [
    item({ id: "a", anchor: "b" }),
    item({ id: "b", anchor: "a" }),
    item({ id: "c", anchor: "model" }),
  ]);

  assert.deepEqual(merged.rightSegments, [
    "model",
    "custom:c",
    "thinking",
    "context_usage",
    "custom:a",
    "custom:b",
  ]);
});

test("orders several items sharing one anchor deterministically", () => {
  const items = [
    item({ id: "a", anchor: "model" }),
    item({ id: "b", anchor: "model" }),
    item({ id: "c", anchor: "model", anchorPlacement: "before" }),
    item({ id: "d", anchor: "model", anchorPlacement: "before" }),
  ];
  const expected = ["custom:c", "custom:d", "model", "custom:a", "custom:b", "thinking", "context_usage"];

  assert.deepEqual(mergeSegmentsWithCustomItems(preset(), items).rightSegments, expected);
  assert.deepEqual(mergeSegmentsWithCustomItems(preset(), items).rightSegments, expected);
});

test("keeps adjacency when before and after anchors interleave", () => {
  const items = [
    item({ id: "x", anchor: "model" }),
    item({ id: "y", anchor: "x", anchorPlacement: "before" }),
    item({ id: "z", anchor: "model" }),
  ];

  assert.deepEqual(mergeSegmentsWithCustomItems(preset(), items).rightSegments, [
    "model",
    "custom:y",
    "custom:x",
    "custom:z",
    "thinking",
    "context_usage",
  ]);
});

test("normalizes malformed anchor configuration away instead of crashing", () => {
  const config = parsePowerlineConfig({
    customItems: {
      a: { anchor: 42, anchorPlacement: "sideways" },
      b: { anchor: "  model  ", anchorPlacement: "before" },
      c: { anchor: "not a segment id!" },
      d: { anchor: "" },
    },
  }, PRESET_NAMES);

  assert.deepEqual(config.customItems.map((entry) => [entry.id, entry.anchor, entry.anchorPlacement]), [
    ["a", undefined, "after"],
    ["b", "model", "before"],
    ["c", undefined, "after"],
    ["d", undefined, "after"],
  ]);

  const merged = mergeSegmentsWithCustomItems(preset(), config.customItems);
  assert.deepEqual(merged.rightSegments, [
    "custom:b",
    "model",
    "thinking",
    "context_usage",
    "custom:a",
    "custom:c",
    "custom:d",
  ]);
});

test("leaves the preset definitions untouched", () => {
  mergeSegmentsWithCustomItems(getPreset("default"), [item({ id: "a", anchor: "model" })]);

  assert.deepEqual(getPreset("default").rightSegments, [
    "telegram",
    "model",
    "thinking",
    "cache_hit",
    "context_usage",
  ]);
});

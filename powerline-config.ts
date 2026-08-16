import type { ColorValue, CustomItemAnchorPlacement, CustomItemPosition, CustomStatusItem, PresetDef, StatusLinePreset, StatusLineSegmentId } from "./types.ts";

export interface PowerlineConfig {
  preset: StatusLinePreset;
  customItems: CustomStatusItem[];
  mouseScroll: boolean;
  fixedEditor: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePreset(value: unknown, presets: readonly StatusLinePreset[]): StatusLinePreset | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (presets as readonly string[]).includes(normalized) ? (normalized as StatusLinePreset) : null;
}

function normalizeCustomItemId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : null;
}

function normalizeCustomItemPosition(value: unknown): CustomItemPosition {
  if (value === "left" || value === "right" || value === "secondary") return value;
  return "right";
}

function normalizeCustomItemAnchor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return /^(custom:)?[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : undefined;
}

function normalizeCustomItemAnchorPlacement(value: unknown): CustomItemAnchorPlacement {
  return value === "before" ? "before" : "after";
}

function normalizeCustomColor(value: unknown): ColorValue | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? (normalized as ColorValue) : undefined;
}

function normalizeCustomPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeCustomStatusItem(raw: unknown, idOverride?: string): CustomStatusItem | null {
  if (!isRecord(raw)) return null;
  const id = normalizeCustomItemId(idOverride ?? raw.id);
  if (!id) return null;

  const statusKey = typeof raw.statusKey === "string" && raw.statusKey.trim() ? raw.statusKey.trim() : id;

  return {
    id,
    statusKey,
    position: normalizeCustomItemPosition(raw.position),
    anchor: normalizeCustomItemAnchor(raw.anchor),
    anchorPlacement: normalizeCustomItemAnchorPlacement(raw.anchorPlacement),
    color: normalizeCustomColor(raw.color),
    prefix: normalizeCustomPrefix(raw.prefix),
    hideWhenMissing: raw.hideWhenMissing !== false,
    excludeFromExtensionStatuses: raw.excludeFromExtensionStatuses !== false,
  };
}

function normalizeCustomItems(raw: unknown): CustomStatusItem[] {
  const normalized: CustomStatusItem[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const item = normalizeCustomStatusItem(entry);
      if (item) normalized.push(item);
    }
  } else if (isRecord(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const item = normalizeCustomStatusItem(entry, id);
      if (item) normalized.push(item);
    }
  }

  const deduped = new Map<string, CustomStatusItem>();
  for (const item of normalized) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()];
}

export function parsePowerlineConfig(value: unknown, presets: readonly StatusLinePreset[]): PowerlineConfig {
  const defaultConfig: PowerlineConfig = { preset: "default", customItems: [], mouseScroll: true, fixedEditor: true };

  const directPreset = normalizePreset(value, presets);
  if (directPreset) return { ...defaultConfig, preset: directPreset };

  if (!isRecord(value)) return defaultConfig;

  return {
    preset: normalizePreset(value.preset, presets) ?? defaultConfig.preset,
    customItems: normalizeCustomItems(value.customItems),
    mouseScroll: value.mouseScroll !== false,
    fixedEditor: value.fixedEditor !== false,
  };
}

/**
 * Merges custom items into the preset's segment lists.
 *
 * Items without a usable `anchor` keep the historical `position` behavior: left
 * items are unshifted, right and secondary items are pushed. An item with an
 * anchor is instead placed directly next to that anchor, on whichever side the
 * anchor lives, so the anchor overrides `position` whenever it resolves. Anchors
 * that are unknown, disabled by the preset, self-referential, or part of a
 * custom-item cycle never throw: those items simply fall back to `position`.
 */
export function mergeSegmentsWithCustomItems(presetDef: PresetDef, customItems: readonly CustomStatusItem[]): {
  leftSegments: StatusLineSegmentId[];
  rightSegments: StatusLineSegmentId[];
  secondarySegments: StatusLineSegmentId[];
} {
  const left: StatusLineSegmentId[] = [...presetDef.leftSegments];
  const right: StatusLineSegmentId[] = [...presetDef.rightSegments];
  const secondary: StatusLineSegmentId[] = [...(presetDef.secondarySegments ?? [])];
  const sides = [left, right, secondary];

  const placeByPosition = (item: CustomStatusItem, segmentId: StatusLineSegmentId) => {
    if (item.position === "left") left.unshift(segmentId);
    else if (item.position === "secondary") secondary.push(segmentId);
    else right.push(segmentId);
  };

  const anchored: CustomStatusItem[] = [];
  for (const item of customItems) {
    if (item.anchor) anchored.push(item);
    else placeByPosition(item, `custom:${item.id}`);
  }

  // Number of items already inserted after a given anchor, so that several items
  // sharing one anchor keep configuration order instead of stacking in reverse.
  const afterCounts = new Map<string, number>();
  const findAnchor = (anchor: string) => {
    for (const side of sides) {
      const index = side.findIndex((segId) => segId === anchor || segId === `custom:${anchor}`);
      if (index !== -1) return { side, index };
    }
    return null;
  };

  let pending = anchored;
  while (pending.length > 0) {
    const unresolved: CustomStatusItem[] = [];
    for (const item of pending) {
      const segmentId: StatusLineSegmentId = `custom:${item.id}`;
      const anchor = item.anchor ? findAnchor(item.anchor) : null;
      if (!anchor) {
        unresolved.push(item);
        continue;
      }
      if (item.anchorPlacement === "before") {
        anchor.side.splice(anchor.index, 0, segmentId);
        continue;
      }
      const anchorSegmentId = anchor.side[anchor.index];
      const offset = afterCounts.get(anchorSegmentId) ?? 0;
      anchor.side.splice(anchor.index + 1 + offset, 0, segmentId);
      afterCounts.set(anchorSegmentId, offset + 1);
    }

    // No progress means every remaining anchor is unknown or part of a cycle.
    if (unresolved.length === pending.length) {
      for (const item of unresolved) placeByPosition(item, `custom:${item.id}`);
      break;
    }
    pending = unresolved;
  }

  return { leftSegments: left, rightSegments: right, secondarySegments: secondary };
}

export function nextPowerlineSettingWithPreset(existingPowerlineSetting: unknown, preset: StatusLinePreset): unknown {
  if (!isRecord(existingPowerlineSetting)) {
    return preset;
  }
  return { ...existingPowerlineSetting, preset };
}

export function nextPowerlineSettingWithOptions(
  existingPowerlineSetting: unknown,
  updates: Partial<Pick<PowerlineConfig, "mouseScroll" | "fixedEditor">>,
  currentPreset: StatusLinePreset,
): unknown {
  if (!isRecord(existingPowerlineSetting)) {
    return { preset: currentPreset, ...updates };
  }
  return { ...existingPowerlineSetting, ...updates };
}

export function collectHiddenExtensionStatusKeys(customItems: readonly CustomStatusItem[]): Set<string> {
  const hidden = new Set<string>();
  for (const item of customItems) {
    if (item.excludeFromExtensionStatuses) hidden.add(item.statusKey);
  }
  return hidden;
}

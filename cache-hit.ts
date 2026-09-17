import type { LastTurnUsage } from "./types.ts";

export interface CacheHitDisplay {
  percent: number;
  color: "success" | "warning" | "error";
}

/** Last-turn prompt cache ratio; output tokens are not part of the prompt. */
export function getCacheHitDisplay(usage: LastTurnUsage | undefined): CacheHitDisplay | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens === 0) return undefined;

  const percent = (usage.cacheRead / promptTokens) * 100;
  return {
    percent: Math.round(percent),
    color: percent >= 90 ? "success" : percent >= 60 ? "warning" : "error",
  };
}

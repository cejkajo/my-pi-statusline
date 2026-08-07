export const CONTEXT_DANGER_USED_TOKENS = 150_000;

export function getContextTokenColor(tokens: number): "tokens" | "contextError" {
  return tokens > CONTEXT_DANGER_USED_TOKENS ? "contextError" : "tokens";
}

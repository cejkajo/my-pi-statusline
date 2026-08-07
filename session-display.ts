export function getSessionDisplay(
  sessionName: string | undefined,
  lastUserPrompt: string | undefined,
  sessionId: string | undefined,
): string {
  return lastUserPrompt?.replace(/\s+/g, " ").trim()
    || sessionName?.trim()
    || sessionId?.slice(0, 8)
    || "new";
}

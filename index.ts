import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import statusline from "./statusline.js";
import usageLimits from "./usage-limits.js";

export default function managedStatusline(pi: ExtensionAPI) {
  usageLimits(pi);
  statusline(pi);
}

// Event wiring for tool-input repair (see tool-repair.ts for the logic and
// for why repair is split between a tool_call hook and inside execute()).
//
// This half handles the string-field repairs that CAN be done in a
// tool_call hook: a wrong-but-schema-valid string (a markdown auto-link
// leaking into a path) passes Pi's own validation fine, so the call reaches
// our hook and event.input can be mutated in place before execution.
//
// Applies to Pi's built-in read/write/edit/ls/grep/find as well as
// pi-tools' own tools, since it keys off field name rather than owning the
// schema.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordPathRepair, unwrapDegenerateMarkdownLink } from "./tool-repair.ts";

/** Fields that carry a filesystem path across built-in and pi-tools tools. */
const PATH_FIELDS = ["path", "file_path", "filePath", "absolutePath"];

export function registerToolRepair(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;
    if (!input || typeof input !== "object") return;

    for (const field of PATH_FIELDS) {
      const value = input[field];
      if (typeof value !== "string") continue;
      const cleaned = unwrapDegenerateMarkdownLink(value);
      if (cleaned !== value) {
        input[field] = cleaned;
        recordPathRepair(event.toolName);
      }
    }
  });
}

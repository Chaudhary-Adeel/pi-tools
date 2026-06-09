// Compact renderers for Pi's built-in edit/write tools.
// Overrides the default verbose output — shows a one-liner collapsed;
// full diff/content visible on Ctrl+O expand.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function registerCompactBuiltins(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // ── edit: show "+N / -M  path" collapsed, diff on expand ──────────
  const originalEdit = createEditTool(cwd);
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: originalEdit.description,
    parameters: originalEdit.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return originalEdit.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, _context) {
      const text =
        theme.fg("toolTitle", theme.bold("edit ")) +
        theme.fg("accent", args.path);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) return new Text(theme.fg("warning", "editing…"), 0, 0);

      const content = result.content[0];
      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
      }

      const details = result.details as { diff?: string; path?: string } | undefined;
      if (!details?.diff) {
        return new Text(theme.fg("success", "✓ edited"), 0, 0);
      }

      // Count additions/removals from diff
      const diffLines = details.diff.split("\n");
      let adds = 0;
      let rems = 0;
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) adds++;
        if (line.startsWith("-") && !line.startsWith("---")) rems++;
      }

      let text =
        theme.fg("success", `+${adds}`) +
        theme.fg("dim", " / ") +
        theme.fg("error", `-${rems}`) +
        theme.fg("dim", "  ✓ edited");

      if (expanded) {
        for (const line of diffLines.slice(0, 30)) {
          if (line.startsWith("+") && !line.startsWith("+++"))
            text += `\n${theme.fg("success", line)}`;
          else if (line.startsWith("-") && !line.startsWith("---"))
            text += `\n${theme.fg("error", line)}`;
          else
            text += `\n${theme.fg("dim", line)}`;
        }
        if (diffLines.length > 30) {
          text += `\n${theme.fg("muted", `… ${diffLines.length - 30} more diff lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ── write: show "✓ wrote path (N lines)" collapsed, content on expand ──
  const originalWrite = createWriteTool(cwd);
  pi.registerTool({
    name: "write",
    label: "write",
    description: originalWrite.description,
    parameters: originalWrite.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalWrite.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, _context) {
      const text =
        theme.fg("toolTitle", theme.bold("write ")) +
        theme.fg("accent", args.path);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) return new Text(theme.fg("warning", "writing…"), 0, 0);

      const content = result.content[0];
      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
      }

      const lineCount =
        content?.type === "text" ? content.text.split("\n").length : 0;
      let text =
        theme.fg("success", "✓ wrote ") +
        theme.fg("dim", `${lineCount} lines`);

      if (expanded && content?.type === "text") {
        const lines = content.text.split("\n").slice(0, 20);
        for (const line of lines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 20) {
          text += `\n${theme.fg("muted", `… ${lineCount - 20} more lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

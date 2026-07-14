// browser.ts — lean browser automation tools via Chrome DevTools Protocol.
//
// Zero external dependencies — just Node built-ins and a hand-rolled
// WebSocket in lib/browser-cdp.ts.
//
// Tools: navigate, snapshot, click, type, evaluate, console, screenshot
//
// Token-efficient by design:
//   - snapshot returns accessibility tree (not raw HTML)
//   - console returns only recent messages
//   - evaluate returns JSON-serializable values only

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, isPrivateHost } from "../lib/shared.ts";
import { CDPClient, type ConsoleEntry } from "../lib/browser-cdp.ts";

// ── SSRF / protocol safety ──────────────────────────────────────────────────
//
// Intentionally still allows "localhost" (unlike web_fetch's validateUrl) —
// navigating to a local dev server (http://localhost:3000) is a core,
// expected use of the browser tools, not an SSRF vector.

const BLOCKED_PROTOCOLS = /^(file|ftp|data|javascript|vbscript):/i;

function validateBrowserUrl(rawUrl: string): string | null {
  if (BLOCKED_PROTOCOLS.test(rawUrl)) {
    return `Refusing to navigate to blocked protocol URL: ${rawUrl}`;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    return `Refusing to navigate to non-http(s) URL: ${rawUrl}`;
  }
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  if (isPrivateHost(hostname)) {
    return `Refusing to navigate to private/reserved IP: ${hostname}`;
  }
  return null;
}

// ── singleton client (lazy-connect, shared across tools) ───────────────────

let client: CDPClient | null = null;

function getClient(port?: number): CDPClient {
  if (!client) {
    client = new CDPClient(port);
  }
  return client;
}

async function ensureConnected(port?: number): Promise<void> {
  const c = getClient(port);
  if (!c.isConnected()) {
    await c.connect(port);
  }
}

// ── shared constants ───────────────────────────────────────────────────────

const NAV_HINT =
  "Start Chrome with --remote-debugging-port=9222 (or the port you configured). " +
  "Any Chromium-based browser works: Chrome, Brave, Edge, Arc, Opera, Vivaldi.";

// ── register ───────────────────────────────────────────────────────────────

export function registerBrowserTools(pi: ExtensionAPI): void {
  // ── browser_navigate ───────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_navigate",
    label: "Navigate",
    description:
      "Navigate the browser to a URL. The browser must be running with " +
      "--remote-debugging-port=PORT (default 9222).",
    promptSnippet: "navigate the browser to a URL",
    promptGuidelines: [
      "Use browser_navigate to go to a page, then browser_snapshot to see its contents.",
      NAV_HINT,
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to navigate to." }),
      port: Type.Optional(
        Type.Number({
          description: "Chrome debugging port (default 9222).",
        }),
      ),
    }),
    async execute(_id, params) {
      const urlError = validateBrowserUrl(params.url);
      if (urlError) throw new Error(urlError);
      try {
        await ensureConnected(params.port);
        await getClient(params.port).navigate(params.url);
        const title = await getClient(params.port).evaluate("document.title");
        return text(`Navigated to: ${params.url}\nTitle: ${title ?? "(loading…)"}`, {
          url: params.url,
          title: title ?? null,
        });
      } catch (e) {
        throw new Error(`Browser navigation failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("browser_navigate "));
      t += theme.fg("muted", args.url as string);
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const title = (d?.title as string) ?? "?";
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", d?.url as string ?? "?");
      summary += "\n  " + theme.fg("dim", `Title: ${title}`);
      return new Text(summary, 0, 0);
    },
  });

  // ── browser_snapshot ───────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_snapshot",
    label: "Page Snapshot",
    description:
      "Get the accessibility tree of the current page. This is the most " +
      "token-efficient way to understand page structure and content. " +
      "Returns element roles, names, and values — not raw HTML.",
    promptSnippet: "get the page accessibility tree",
    promptGuidelines: [
      "The tree shows interactive elements with their roles (button, link, textbox) and labels.",
      "Pass a smaller depth to focus on the top-level structure; larger to dive into details.",
    ],
    parameters: Type.Object({
      depth: Type.Optional(
        Type.Number({
          description: "Max depth to traverse (default 4). Increase for more detail.",
        }),
      ),
      port: Type.Optional(
        Type.Number({ description: "Chrome debugging port (default 9222)." }),
      ),
    }),
    async execute(_id, params) {
      try {
        await ensureConnected(params.port);
        const tree = await getClient(params.port).snapshot(params.depth ?? 4);
        return text(tree, { depth: params.depth ?? 4 });
      } catch (e) {
        throw new Error(`Browser snapshot failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("browser_snapshot"));
      if (args.depth) t += theme.fg("dim", ` depth=${args.depth}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const preview = firstText(result);
      const lines = preview.split("\n");
      const count = lines.filter((l) => l.trim()).length;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `${count} elements`);
      if (expanded) {
        const head = lines.slice(0, 25).join("\n");
        summary += "\n" + theme.fg("dim", head);
        if (lines.length > 25) summary += "\n" + theme.fg("dim", "…");
      }
      return new Text(summary, 0, 0);
    },
  });

  // ── browser_click ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_click",
    label: "Click Element",
    description:
      "Click an element on the page by CSS selector or visible text. " +
      "For text matching, use any unique substring of the element's text content.",
    promptSnippet: "click an element on the page",
    promptGuidelines: [
      "Run browser_snapshot first to see what's clickable on the page.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description:
          "CSS selector (e.g. '#submit', 'button.primary') or visible text to click.",
      }),
      port: Type.Optional(
        Type.Number({ description: "Chrome debugging port (default 9222)." }),
      ),
    }),
    async execute(_id, params) {
      try {
        await ensureConnected(params.port);
        await getClient(params.port).click(params.selector);
        return text(`Clicked: "${params.selector}"`, { selector: params.selector });
      } catch (e) {
        throw new Error(`Browser click failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("browser_click "));
      t += theme.fg("muted", `"${args.selector as string}"`);
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", `Clicked "${(result.details as Record<string, unknown> | undefined)?.selector as string ?? "?"}"`),
        0, 0,
      );
    },
  });

  // ── browser_type ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_type",
    label: "Type Text",
    description:
      "Type text into an input field on the page. Selects all existing text first, " +
      "then types the new value. Target the field by CSS selector.",
    promptSnippet: "type text into a field",
    promptGuidelines: [
      "Run browser_snapshot first to find the correct input field.",
    ],
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector for the input/textarea element.",
      }),
      text: Type.String({ description: "Text to type into the field." }),
      port: Type.Optional(
        Type.Number({ description: "Chrome debugging port (default 9222)." }),
      ),
    }),
    async execute(_id, params) {
      try {
        await ensureConnected(params.port);
        await getClient(params.port).type(params.selector, params.text);
        return text(`Typed "${params.text}" into "${params.selector}"`, {
          selector: params.selector,
          text: params.text,
        });
      } catch (e) {
        throw new Error(`Browser type failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("browser_type "));
      t += theme.fg("muted", `"${args.text as string}"`);
      t += theme.fg("dim", ` into ${args.selector as string}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("muted", `Typed "${(result.details as Record<string, unknown> | undefined)?.text as string ?? "?"}"`),
        0, 0,
      );
    },
  });

  // ── browser_evaluate ───────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_evaluate",
    label: "Evaluate JS",
    description:
      "Run a JavaScript expression in the page and return the result. " +
      "The expression runs in the page's context and can access DOM, " +
      "global variables, etc. Returns only JSON-serializable values.",
    promptSnippet: "run JavaScript in the browser page",
    promptGuidelines: [
      "The expression is wrapped in a Promise — use 'return' for values, 'await' for async.",
      "Functions and DOM nodes can't be serialized; extract the data you need.",
    ],
    parameters: Type.Object({
      expression: Type.String({
        description:
          "JavaScript expression to evaluate. Use 'return' for values.",
      }),
      port: Type.Optional(
        Type.Number({ description: "Chrome debugging port (default 9222)." }),
      ),
    }),
    async execute(_id, params) {
      try {
        await ensureConnected(params.port);
        const result = await getClient(params.port).evaluate(params.expression);
        const resultStr =
          result === undefined
            ? "undefined"
            : typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2);
        return text(resultStr, {
          expression: params.expression,
          resultType: typeof result,
        });
      } catch (e) {
        throw new Error(`Browser evaluate failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      const expr = (args.expression as string) ?? "?";
      let t = theme.fg("toolTitle", theme.bold("browser_evaluate "));
      t += theme.fg("muted", expr.length > 80 ? expr.slice(0, 77) + "…" : expr);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const rtype = (result.details as Record<string, unknown> | undefined)?.resultType as string ?? "?";
      let summary = theme.fg("success", "✓ ") + theme.fg("dim", `(${rtype})`);
      if (expanded) {
        const val = firstText(result);
        const preview = val.length > 300 ? val.slice(0, 297) + "…" : val;
        summary += " " + theme.fg("muted", preview);
      }
      return new Text(summary, 0, 0);
    },
  });

  // ── browser_console ────────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_console",
    label: "Console Messages",
    description:
      "Get console messages (log, warn, error, etc.) from the page. " +
      "Messages are collected automatically while connected.",
    promptSnippet: "read the browser console output",
    promptGuidelines: [
      "Pass 'clear: true' to clear the message buffer after reading.",
    ],
    parameters: Type.Object({
      clear: Type.Optional(
        Type.Boolean({
          description: "Clear stored messages after returning them (default false).",
        }),
      ),
      port: Type.Optional(
        Type.Number({ description: "Chrome debugging port (default 9222)." }),
      ),
    }),
    async execute(_id, params) {
      try {
        await ensureConnected(params.port);
        const msgs = getClient(params.port).getConsoleMessages();
        if (params.clear) {
          getClient(params.port).clearConsole();
        }
        if (msgs.length === 0) {
          return text("(no console messages)");
        }
        const formatted = msgs
          .map((m: ConsoleEntry) => `[${m.type.toUpperCase()}] ${m.text}`)
          .join("\n");
        return text(truncate(formatted), { count: msgs.length, cleared: !!params.clear });
      } catch (e) {
        throw new Error(`Browser console read failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("browser_console"));
      if (args.clear) t += theme.fg("dim", " (clear)");
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const count = (result.details as Record<string, unknown> | undefined)?.count as number ?? 0;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `${count} message(s)`);
      if (expanded && count > 0) {
        const preview = firstText(result);
        const head = preview.split("\n").slice(0, 20).join("\n");
        summary += "\n" + theme.fg("dim", head);
        if (preview.split("\n").length > 20) summary += "\n" + theme.fg("dim", "…");
      }
      return new Text(summary, 0, 0);
    },
  });

  // ── browser_screenshot ─────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description:
      "Take a PNG screenshot of the current page. Returns base64-encoded " +
      "image data. The image appears inline in the chat.",
    promptSnippet: "take a screenshot of the page",
    promptGuidelines: [
      "Screenshots are base64 PNG — large but useful for visual debugging.",
    ],
    parameters: Type.Object({
      port: Type.Optional(
        Type.Number({ description: "Chrome debugging port (default 9222)." }),
      ),
    }),
    async execute(_id, params) {
      try {
        await ensureConnected(params.port);
        const data = await getClient(params.port).screenshot();
        return {
          content: [
            {
              type: "image" as const,
              data,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: `Screenshot captured (${(data.length * 0.75 / 1024).toFixed(1)} KB base64).`,
            },
          ],
          details: { format: "png" },
        };
      } catch (e) {
        throw new Error(`Browser screenshot failed: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_screenshot")),
        0, 0,
      );
    },
    renderResult(result, _opts, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const textPart = result.content?.find((c) => c.type === "text");
      const size = textPart?.text ?? "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("dim", size), 0, 0);
    },
  });
}

---
name: browser
description: Browser automation via Chrome DevTools Protocol. Navigate, snapshot, click, type, evaluate JS, read console, and screenshot. Use when the user asks to interact with a web page, test a UI, scrape content, debug browser errors, or automate any browser task. Requires a Chromium-based browser (Chrome, Brave, Edge, Arc).
---

# Browser Automation

Zero-dependency browser control through Chrome DevTools Protocol. Works with any Chromium-based browser (Chrome, Brave, Edge, Arc, Opera, Vivaldi).

## Quick Start

Launch the browser with debugging enabled:

```bash
./skills/browser/start.sh
```

This auto-detects your installed browser (Chrome → Brave → Chromium → Edge) and opens it with `--remote-debugging-port=9222`. If a browser is already running on the port it won't start a second one.

## Tools

Always run `browser_snapshot` first to see the page structure — it uses the accessibility tree, which is far more token-efficient than fetching raw HTML.

| Tool | Use for |
|---|---|
| `browser_navigate` | Go to a URL. Pass `port: 9222` if not default. |
| `browser_snapshot` | See page structure. Pass `depth` (default 4) for more detail. |
| `browser_click` | Click an element by CSS selector or visible text. |
| `browser_type` | Type into a field. Selects existing text first. |
| `browser_evaluate` | Run JS in the page. Returns JSON-serializable values. |
| `browser_console` | Read console messages (log, warn, error, exceptions). |
| `browser_screenshot` | Capture a PNG of the current viewport. |

## Workflow

```
1. browser_navigate(url: "https://...")
2. browser_snapshot()                          ← see what's on the page
3. browser_console()                           ← check for page errors
4. browser_click/browser_type as needed
5. browser_screenshot()                        ← visual confirmation
```

## Troubleshooting

- **No debuggable page found**: Run `./skills/browser/start.sh` first.
- **Connection refused**: Ensure Chrome is running with `--remote-debugging-port=9222`.
- **Element not found**: Use `browser_snapshot` to find the correct selector or text.
- **Firefox**: Not supported. CDP is Chromium-only.

## Reference

See [references/tools.md](references/tools.md) for detailed tool parameters and examples.

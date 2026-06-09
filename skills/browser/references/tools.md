# Browser Tool Reference

## browser_navigate

Navigate to a URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full URL (https://...) |
| `port` | number | no | CDP port (default 9222) |

Example: `browser_navigate(url: "https://example.com")`

## browser_snapshot

Get accessibility tree of the current page. This is the most token-efficient way to understand page structure — returns element roles, names, and values, not raw HTML.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `depth` | number | no | Max tree depth (default 4) |
| `port` | number | no | CDP port (default 9222) |

Interpreting the output:
- `RootWebArea "Page Title"` — the page root
- `button "Submit"` — a clickable button
- `textbox "Search"` — an input field (by label)
- `link "Read more"` — a link
- `heading "Section"` — a heading
- `StaticText "content"` — text content

## browser_click

Click an element by CSS selector or visible text.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | yes | CSS selector or visible text |
| `port` | number | no | CDP port (default 9222) |

Examples:
- `browser_click(selector: "#login-button")`
- `browser_click(selector: "button.primary")`
- `browser_click(selector: "Submit")` — matches by text content

## browser_type

Type text into an input/textarea. Selects existing content first, then types the replacement.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | yes | CSS selector for the input element |
| `text` | string | yes | Text to type |
| `port` | number | no | CDP port (default 9222) |

Example: `browser_type(selector: "input[name='q']", text: "search query")`

## browser_evaluate

Run JavaScript in the page context. Returns JSON-serializable values only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `expression` | string | yes | JS expression (use `return` for values) |
| `port` | number | no | CDP port (default 9222) |

Examples:
- `browser_evaluate(expression: "document.title")`
- `browser_evaluate(expression: "JSON.stringify(window.location)")`
- `browser_evaluate(expression: "document.querySelectorAll('.item').length")`
- `browser_evaluate(expression: "await fetch('/api/data').then(r => r.json())")`

## browser_console

Read console messages collected from the page (log, warn, error, info, debug). Uncaught exceptions are automatically captured as errors.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `clear` | boolean | no | Clear buffer after reading (default false) |
| `port` | number | no | CDP port (default 9222) |

Example: `browser_console(clear: true)` — read and clear

## browser_screenshot

Capture a PNG screenshot of the current viewport. Returns base64 image data that renders inline in the chat.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | number | no | CDP port (default 9222) |

Example: `browser_screenshot()`

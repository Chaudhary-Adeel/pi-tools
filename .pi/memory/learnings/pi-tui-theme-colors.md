---
description: "theme.fg() valid colors differ from ctx.ui.notify() severity levels"
---
# Pi TUI Theme Colors vs Notify Severities

**`theme.fg()`** and **`ctx.ui.notify()`** accept different sets of color/severity names — they are not interchangeable.

### `theme.fg(color, text)` — valid colors
`accent`, `success`, `warning`, `error`, `muted`, `dim`, `text`

- `"info"` is **NOT** valid for `theme.fg()` — using it throws `Unknown theme color: info`.
- Use `"text"` instead when you need a neutral foreground color.

### `ctx.ui.notify(message, severity)` — valid severities
`"info"`, `"success"`, `"warning"`, `"error"`

- `"info"` IS valid here as a notification severity.
- Same set as above except "info" replaces the theme-specific coloring.

```ts
// ❌ Wrong — "info" not valid for theme.fg
theme.fg("info", "some text")

// ✅ Correct — use "text" for neutral foreground
theme.fg("text", "some text")

// ✅ Fine — "info" is valid for notifications
ctx.ui.notify("something happened", "info")
```

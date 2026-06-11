---
description: "pi TUI terminal size: use tui.terminal.columns/rows, not tui.width()/tui.height()"
---
# Pi TUI Terminal Dimensions

`tui.width()` and `tui.height()` are **not** part of the pi TUI API. Calling them throws `tui.width is not a function`.

**Correct API:**
- `tui.terminal.columns` — current terminal width in columns
- `tui.terminal.rows` — current terminal height in rows

Both are getters that reflect the current terminal size and update on resize.
They are available inside `ctx.ui.custom()` callbacks.

```ts
// ❌ Wrong
const w = tui.width();
const h = tui.height();

// ✅ Correct
const w = tui.terminal.columns;
const h = tui.terminal.rows;
```

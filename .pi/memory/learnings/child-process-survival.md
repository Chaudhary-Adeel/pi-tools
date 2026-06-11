---
description: "How to spawn child processes that survive parent exit in Node.js"
---

# Detached Child Processes That Survive Parent Exit

To spawn a background subprocess that outlives the parent process (e.g., subagents
at session shutdown), you need all three:

1. **`detached: true`** — calls `setsid(2)` so the child gets its own process group.
   Without this, signals sent to the parent's process group (e.g., SIGHUP on terminal
   close) will also kill the child.

2. **`child.unref()`** — tells Node's event loop not to wait for this child before
   exiting. Without this, the parent process hangs until the child finishes.

3. **`stdio: 'ignore'`** — detaches the child's stdio from the parent. If the child
   inherits the parent's stdio streams and the parent exits, the child may crash on
   the next I/O attempt.

**Root cause**: Without `detached: true`, background subprocesses (like subagent
spawns) were killed when pi exited, because they shared the parent's process group.

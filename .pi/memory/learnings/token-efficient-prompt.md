---
description: "Remove prompt sections that tools self-document; operating rules should be minimal not comprehensive"
---

# Token-Efficient Operating Prompt Design

The default pi operating prompt template inflates the system message with ~500+
tokens of content that tools already self-document at invocation time. Aggressive
trimming cut ~40% without losing fidelity.

## What was removed and why

| Section removed | Reason |
|----------------|---------|
| Tool list (7 lines) | pi lists available tools at invocation; the LLM already sees function declarations |
| Tool guidelines for each tool family | Each tool has a `description` and `parameters` schema — restating in the prompt is pure duplication |
| Browser-specific section (7 lines) | Browser tool descriptions ("Navigate to a URL", "Click an element") are self-documenting |
| Command references (`/memory`, `/doctor`, etc.) | These are user-facing commands, not model instructions — the LLM doesn't need to know about them |

## What was kept

- **Operating rules** (2 lines): "Be token-efficient. Think briefly, act."
- **Non-obvious constraints**: parallelism rules ("Independent tool calls go in ONE batch"), subagent usage patterns
- **Memory instructions**: how to use `.pi/memory/` files — this is project-specific and not self-documenting

## Principle

Every line in the system prompt costs tokens on **every turn**.
A 10-line section that's marginally useful costs 10× the token budget over a session.
Strip anything that:
1. The tool schema already describes
2. The LLM already knows from training
3. Is user-facing (commands), not model-facing

Result: operating rules went from 48 lines → 20 lines, saving ~250-350 tokens per turn.

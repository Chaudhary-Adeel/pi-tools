# DeepSeek Prompting Best Practices for Coding Agents

> Research compiled 2026-06-11 from DeepSeek official API docs, the DeepSeek-R1 paper,
> Anthropic's prompting guide (for comparison), and community benchmarks/discussions.

---

## 1. Model Selection & Thinking Mode

### Available Models (mid-2026)

| Model | Notes |
|---|---|
| `deepseek-v4-pro` | Flagship. Thinking mode default. Maps from `claude-opus` in Anthropic API. 500 concurrent. |
| `deepseek-v4-flash` | Fast/cheap. Thinking mode default. Maps from `claude-sonnet`/`claude-haiku`. 2500 concurrent. |
| `deepseek-chat` / `deepseek-reasoner` | **Deprecated** as of 2026-07-24. Aliases for non-thinking and thinking modes of v4-flash. |

### Thinking Mode Toggle

```json
{
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high"
}
```

- **Effort levels**: `high` (default for regular requests) or `max` (auto-set for Claude Code, OpenCode agents).
- `low` and `medium` map to `high`; `xhigh` maps to `max`.
- **No effect**: `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` — setting them won't error but won't do anything.
- The chain-of-thought is returned via `reasoning_content` alongside `content`.

**Recommendation**: Always enable thinking mode for coding agents. Use `reasoning_effort: "max"` for complex multi-step reasoning tasks.

---

## 2. System Prompt Structure

### DeepSeek vs Claude: Key Differences

DeepSeek models respond well to the same prompting principles as Claude, but with important distinctions:

#### What Works the Same
- **Be clear and direct**: Explicit instructions > vague ones. Give sequential steps.
- **XML-structured prompts**: DeepSeek parses XML tags well. Use `<instructions>`, `<context>`, `<examples>`.
- **Role setting**: `"You are an expert coding assistant."` improves focus.
- **Long data at top, query at bottom**: 30% quality improvement in some benchmarks.
- **Few-shot examples**: 3-5 relevant examples significantly improve format consistency.

#### What's Different for DeepSeek

| Area | Claude | DeepSeek |
|---|---|---|
| **System prompt verbosity** | Handles very long system prompts well | Keep system prompts **concise and direct** — overly long system prompts can dilute instruction following |
| **Thinking control** | `thinking: {type: "adaptive"}` with `budget_tokens` | `thinking: {type: "enabled"}` with only `reasoning_effort: "high"/"max"` — no token budgets |
| **Output verbosity** | Can be excessively verbose; needs anti-verbose instructions | More direct. May skip summaries after tool calls. Add explicit "provide a brief summary" if needed. |
| **Chain-of-thought handling** | CoT embedded in response; always passed in context | `reasoning_content` is **separate field**; must be passed back in tool-call turns or API returns 400 |
| **Role enforcement** | Very strong role adherence | Good role adherence, but can be more flexible/boundary-pushing — **explicit guardrails are essential** |

### Recommended System Prompt Template for Coding Agent

```
<system>
You are an expert software engineer and coding assistant. You write clean,
correct, well-tested code. You think carefully before acting.

<principles>
- Before writing code, understand the full context of the codebase.
- Read existing files before modifying them. Never guess at interfaces.
- When debugging, isolate the root cause before applying fixes.
- Prefer minimal, surgical changes over large rewrites.
- Always verify your work compiles/passes tests after changes.
- If uncertain, use tools to inspect the code rather than assuming.
</principles>

<tool_usage>
- Use available tools to read files, search code, and execute commands.
- After each tool call, evaluate the result before the next action.
- If a tool fails, diagnose the error before retrying.
- Never delete or overwrite files unless explicitly instructed.
- Always confirm destructive operations with the user first.
</tool_usage>

<output_format>
- Write code inside ```language blocks.
- Keep explanations concise. Focus on what changed and why.
- When presenting diff-like output, show only the changed lines.
- Use inline comments sparingly — prefer clear naming over comments.
</output_format>

<stop_conditions>
- Stop and ask the user if: requirements are ambiguous, a destructive
  operation is needed, or you're uncertain about the correct approach.
- Never invent APIs, libraries, or configuration that doesn't exist.
</stop_conditions>
</system>
```

---

## 3. Reasoning Scaffolding

### How DeepSeek's Chain-of-Thought Works

DeepSeek's thinking mode is inspired by the R1 paper findings:
- Pure RL training incentivized emergent **self-reflection**, **verification**, and **dynamic strategy adaptation**.
- The model naturally engages in multi-step reasoning before producing output.
- This is most effective on: math, coding competitions, STEM problems, and multi-turn tool use.

### Multi-Turn Conversation Protocol

This is **critical** — DeepSeek handles multi-turn CoT differently from other models:

```
TURN WITHOUT TOOL CALL:
  User → Assistant(reasoning_content + content)
  Next turn: reasoning_content is IGNORED by API
  → Only content needs to be passed in subsequent turns

TURN WITH TOOL CALL:
  User → Assistant(reasoning_content + tool_calls) → Tool → Assistant → ... → Assistant(reasoning_content + content)
  Next turn: reasoning_content MUST be passed back in ALL subsequent requests
  → Failing to do so returns HTTP 400
```

**Implementation rule**: Always `messages.append(response.choices[0].message)` — the message object includes `reasoning_content` automatically. Never strip it.

### Prompting for Self-Verification

DeepSeek models benefit from explicit self-verification prompts. Embed these patterns:

```
<self_verification>
After completing each task:
1. Review your changes for correctness.
2. Run the build/tests to verify nothing is broken.
3. Re-read the original requirement — did you address all points?
4. Check for: off-by-one errors, null handling, edge cases,
   thread safety, and resource leaks.
</self_verification>
```

**Self-critique pattern** (works well with DeepSeek's thinking mode):
```
Before finalizing your answer, identify at least one potential flaw
in your solution and explain how you addressed it.
```

### Reasoning Effort Calibration

| Task Type | Recommended Effort | Notes |
|---|---|---|
| Simple bug fix / one-liner | `high` | Avoids overthinking trivial problems |
| New feature implementation | `high` or `max` | `max` for complex multi-file changes |
| Debugging complex issue | `max` | Benefits from extended CoT |
| Architecture / design decisions | `max` | Needs thorough reasoning |
| Code review | `high` | Systematic review doesn't need `max` |
| Test generation | `high` | Edge case enumeration benefits from thinking |

---

## 4. Output Format Guidance

### Code Generation

DeepSeek supports **Chat Prefix Completion** (Beta) for forcing code output:

```python
messages = [
    {"role": "user", "content": "Please write quick sort code"},
    {"role": "assistant", "content": "```python\n", "prefix": True}
]
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    stop=["```"],
)
```

This forces code-only output with no explanations — useful for autocomplete and inline suggestions.

### General Format Tips

1. **Use stop sequences**: Set `stop: ["```"]` for code blocks, `stop: ["</answer>"]` for XML-wrapped responses.
2. **Match prompt format to desired output**: If you write your prompt without markdown, the model uses less markdown.
3. **Be explicit about format**: `"Your response should contain exactly one code block. No explanations outside the code block."`
4. **JSON output**: Use the dedicated JSON output mode or strict mode tool calls with JSON Schema.

### Structured Output (Tool Calls with Strict Mode)

```json
{
  "type": "function",
  "function": {
    "name": "edit_file",
    "strict": true,
    "description": "Edit a file with the specified changes.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {"type": "string", "description": "File path"},
        "old_text": {"type": "string", "description": "Text to replace"},
        "new_text": {"type": "string", "description": "Replacement text"}
      },
      "required": ["path", "old_text", "new_text"],
      "additionalProperties": false
    }
  }
}
```

Use `base_url="https://api.deepseek.com/beta"` for strict mode.

---

## 5. Known Limitations & Quirks

### 5.1 Destructive / Cavalier Behavior

Community reports indicate DeepSeek models can be **overly aggressive** when not properly constrained:
- **Deleting files without confirmation**: One user reported DeepSeek v4 Flash deleting an entire docs directory because it was in `.gitignore`.
- **Overwriting large code sections**: Instead of surgical edits, it may rewrite entire files.

**Mitigation**: Add explicit guardrails in system prompt:
```
<constraints>
NEVER delete or overwrite files without explicit user confirmation.
When editing files, make the MINIMAL change needed.
Before any destructive operation, explain what you're about to do and why.
</constraints>
```

### 5.2 Tunnel Vision

DeepSeek can fixate on the wrong problem:
- When faced with a bug caused by a wrong framework directive, it spent ages debugging the compiler instead of fixing the actual code.
- It tends to double down on an initial hypothesis rather than reconsidering.

**Mitigation**: Build re-evaluation checkpoints into prompts:
```
If you've spent more than 3 iterations on a fix without success,
STOP and reconsider: is the root cause different from what you assumed?
List alternative hypotheses before proceeding.
```

### 5.3 reasoning_content Management

The biggest API-level gotcha: forgetting to pass `reasoning_content` in tool-call turns causes HTTP 400 errors.

**Mitigation**: Always append the full message object:
```python
# Correct — includes reasoning_content automatically
messages.append(response.choices[0].message)

# Wrong — strips reasoning_content
messages.append({"role": "assistant", "content": response.choices[0].message.content})
```

### 5.4 No Fine-Grained Thinking Control

Unlike Claude which supports `budget_tokens` for extended thinking, DeepSeek only has `reasoning_effort: "high"/"max"`. You cannot:
- Set a specific token budget for thinking
- Force thinking to be shorter (only longer, via `max`)
- Disable thinking mid-conversation once enabled

### 5.5 Chinese Content Sensitivity

Some community users report the model can self-censor on certain topics. For coding work, this is rarely an issue, but be aware when working on content that touches geopolitical topics.

### 5.6 Training Data Freshness

The newer models have more recent training data, but always verify library/API usage against current docs. For older versions, provide explicit documentation snippets in the prompt.

---

## 6. Agent Architecture Recommendations

### 6.1 Scaffolding Pattern

For a DeepSeek-powered coding agent, use this scaffolding:

```
1. SYSTEM PROMPT
   - Role: expert coding assistant
   - Safety constraints (no destructive ops without confirmation)
   - Self-verification requirements
   - Output format rules

2. TOOL DEFINITIONS
   - Use strict mode with JSON Schema for reliability
   - Each tool should have a clear single responsibility
   - Include examples in tool descriptions

3. CONTEXT WINDOW MANAGEMENT
   - reasoning_content adds ~2-3x tokens per thinking turn
   - Budget for this overhead in context window planning
   - Use context caching for repeated system prompts

4. TURN STRUCTURE
   - User request → Reasoning → Tool calls → Reasoning → Answer
   - Each turn: pass full message object (including reasoning_content)
   - After final answer: reasoning_content is dropped for next non-tool turn
```

### 6.2 Parallel Tool Calling

DeepSeek supports parallel tool calls in thinking mode. The model can chain:
```
Reason → Tool A + Tool B (parallel) → Reason on results → Tool C → Final answer
```

Encourage parallelism in the system prompt:
```
When you need multiple pieces of information that are independent of
each other, request them in parallel tool calls rather than sequentially.
```

### 6.3 Error Recovery Loop

```
<error_recovery>
If a tool call fails:
1. Read the error message carefully.
2. Diagnose the cause (wrong parameters? missing file? permissions?).
3. Fix exactly the cause, not something else.
4. Retry with corrected parameters.
5. If the same error occurs twice, try a DIFFERENT approach.
</error_recovery>
```

---

## 7. Cost-Performance Optimization

### Pricing (as of mid-2026)

| Model | Input (per M tokens) | Output (per M tokens) |
|---|---|---|
| `deepseek-v4-pro` | $0.435 | $0.87 |
| `deepseek-v4-flash` | significantly cheaper | significantly cheaper |

Discounted cache reads available. DeepSeek v4 Pro is ~17× cheaper than GPT-5.2 for equivalent agentic workloads.

### Performance Benchmarks

- DeepSeek V4 Pro: Ties GPT-5.2 on FoodTruck Bench (agentic benchmark), ~3% within Opus 4.6.
- DeepSeek R1 0528: Tied Claude Opus 4 for #1 in WebDev Arena, #2 in coding, #4 in hard prompts, #5 in math.
- DeepSeek V3-0324: Caught up to Sonnet 3.7 in code creativity benchmarks.

### Maximizing Performance per Dollar

1. **Use `deepseek-v4-flash` for simple tasks** (formatting, simple queries, code explanation) — save `deepseek-v4-pro` for complex reasoning.
2. **Enable context caching** for repeated system prompts and tool definitions.
3. **Batch independent tasks** where possible to reduce total API round-trips.
4. **Trim `reasoning_content` from non-tool-call turns** before passing to next turn (the API ignores it anyway, so save on context tokens).

---

## 8. Quick Reference: Prompting Checklist

### ✅ Do

- Enable thinking mode (`thinking: {type: "enabled"}`)
- Set appropriate `reasoning_effort` per task complexity
- Use structured, XML-wrapped system prompts
- Include self-verification instructions
- Add explicit safety constraints (no destructive ops without confirmation)
- Pass full message objects (including `reasoning_content`) in tool-call turns
- Use strict-mode tool definitions for reliable structured output
- Provide few-shot examples for format-sensitive tasks
- Set explicit stop sequences for code generation
- Trim context in non-tool-call turns (drop old `reasoning_content`)

### ❌ Don't

- Set `temperature`/`top_p` — they're ignored in thinking mode
- Strip `reasoning_content` from tool-call turns — causes HTTP 400
- Use overly long system prompts — keep them focused
- Rely on the model to "play it safe" — it can be cavalier
- Assume thinking mode is always better — it costs more tokens
- Use Claude-specific features like `budget_tokens` or `thinking: {type: "adaptive"}`
- Forget that DeepSeek's Anthropic API maps model names (claude-sonnet → deepseek-v4-flash)

---

## 9. Migration: Claude System Prompt → DeepSeek

When porting an existing Claude coding agent to DeepSeek:

1. **Remove**: `budget_tokens`, `thinking: {type: "adaptive"}`, `temperature` controls
2. **Replace**: `thinking: {type: "adaptive"}` with `thinking: {type: "enabled"}` + `reasoning_effort`
3. **Add**: explicit safety constraints (DeepSeek needs more guardrails than recent Claude)
4. **Add**: tunnel-vision escape hatches ("if stuck after 3 attempts, re-evaluate root cause")
5. **Adjust**: model string / API base URL
6. **Preserve**: XML structure, role setting, few-shot examples, clear instructions
7. **Monitor**: reasoning_content management in tool-call loops

### API Configuration

```python
# OpenAI-compatible
client = OpenAI(
    api_key=os.environ.get("DEEPSEEK_API_KEY"),
    base_url="https://api.deepseek.com",
)
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    reasoning_effort="max",
    extra_body={"thinking": {"type": "enabled"}},
)

# Anthropic-compatible (for Claude Code, etc.)
client = anthropic.Anthropic(
    base_url="https://api.deepseek.com/anthropic",
    api_key=os.environ.get("DEEPSEEK_API_KEY"),
)
message = client.messages.create(
    model="deepseek-v4-pro",  # or "claude-opus-4-8" (auto-mapped)
    max_tokens=4096,
    system="You are an expert coding assistant...",
    messages=[{"role": "user", "content": "..."}],
)
```

---

## Sources

- [DeepSeek API Docs — Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek API Docs — Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek API Docs — Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
- [DeepSeek-R1 Paper (arXiv:2501.12948)](https://arxiv.org/abs/2501.12948)
- [Anthropic Prompting Best Practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts)
- [FoodTruck Bench: DeepSeek V4 Pro](https://foodtruckbench.com/blog/deepseek-v4-pro)
- Community: r/LocalLLaMA, r/DeepSeekAI, WebDev Arena (lmarena.ai)

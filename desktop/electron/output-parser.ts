/**
 * Output parser — converts raw Pi CLI stdout lines into structured events
 * for the renderer. Strips ANSI escape codes and classifies each line.
 */

// Simple ANSI escape code stripper (avoids an npm dep in the main process)
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][AB012]/g
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '').replace(CONTROL_RE, '')
}

// ── Event types ─────────────────────────────────────────────────────────────

export type ParsedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; tool: string; args: string; raw: string }
  | { kind: 'tool-result'; tool: string; status: 'ok' | 'error'; summary: string; raw: string }
  | { kind: 'section'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; exitCode: number }

// ── Pattern matching ─────────────────────────────────────────────────────────

// Tool call line: "  → tool_name arg1 arg2" or "→ tool_name …"
const TOOL_CALL_RE = /^[\s\u2192→]*(?:→|\u2192)\s+(\w+)\s*(.*)/

// Tool result success: "  ✓ ..." or "✓ ..."
const TOOL_OK_RE = /^[\s✓]*✓\s+(.+)/

// Tool result error: "  ✗ ..." or "✗ ..."
const TOOL_ERR_RE = /^[\s✗]*✗\s+(.+)/

// Section headers like "──────" separators
const SEPARATOR_RE = /^[\s─━\-=]{8,}$/

// Extract the first word (tool name) from a tool call args line
function splitToolArgs(argsStr: string): { tool: string; args: string } {
  const parts = argsStr.trim().split(/\s+/)
  return { tool: parts[0] ?? '', args: parts.slice(1).join(' ') }
}

/** Parse a single output line into zero or more structured events. */
export function parseOutput(rawLine: string): ParsedEvent[] {
  const line = stripAnsi(rawLine)
  if (!line.trim()) return []

  // Tool call
  const callMatch = TOOL_CALL_RE.exec(line)
  if (callMatch) {
    const tool = callMatch[1]!
    const args = callMatch[2]?.trim() ?? ''
    return [{ kind: 'tool-call', tool, args, raw: line.trim() }]
  }

  // Tool result success
  const okMatch = TOOL_OK_RE.exec(line)
  if (okMatch) {
    const raw = line.trim()
    // Try to extract tool name from summary ("✓ web_fetch https://...")
    const { tool, args: summary } = splitToolArgs(okMatch[1]!)
    return [{ kind: 'tool-result', tool, status: 'ok', summary: summary || raw, raw }]
  }

  // Tool result error
  const errMatch = TOOL_ERR_RE.exec(line)
  if (errMatch) {
    const raw = line.trim()
    const { tool, args: summary } = splitToolArgs(errMatch[1]!)
    return [{ kind: 'tool-result', tool, status: 'error', summary: summary || raw, raw }]
  }

  // Separator / section break
  if (SEPARATOR_RE.test(line)) {
    return [] // skip visual separators
  }

  // Plain text
  return [{ kind: 'text', text: line }]
}

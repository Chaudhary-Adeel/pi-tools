import { useMemo } from 'react'

interface Props {
  content: string
}

// ── Simple syntax highlighter (no deps) ──────────────────────────────────

const KEYWORDS = /\b(function|const|let|var|if|else|return|import|export|from|class|interface|type|extends|implements|async|await|try|catch|throw|new|this|super|for|while|do|switch|case|break|continue|default|typeof|instanceof|in|of|void|null|undefined|true|false)\b/g
const STRING_RE = /(["'`])(?:(?!\1|\\).|\\.)*\1/g
const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm
const NUMBER_RE = /\b\d+\.?\d*\b/g
const BUILTIN_RE = /\b(console|Math|JSON|Promise|Array|Object|String|Number|Boolean|Map|Set|Date|RegExp|Error|parseInt|parseFloat|isNaN)\b/g

function highlightCode(code: string, lang?: string): string {
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Comments first (so they override everything else)
  html = html.replace(COMMENT_RE, (m) => `<span class="hl-comment">${m}</span>`)
  // Strings
  html = html.replace(STRING_RE, (m) => `<span class="hl-string">${m}</span>`)
  // Keywords
  html = html.replace(KEYWORDS, (m) => `<span class="hl-keyword">${m}</span>`)
  // Builtins
  html = html.replace(BUILTIN_RE, (m) => `<span class="hl-builtin">${m}</span>`)
  // Numbers
  html = html.replace(NUMBER_RE, (m) => `<span class="hl-number">${m}</span>`)

  return `<code class="hl-code${lang ? ` hl-lang-${lang}` : ''}">${html}</code>`
}

// ── Markdown line renderer ────────────────────────────────────────────────

type BlockType = 'normal' | 'code'

function renderInline(text: string): string {
  // Bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Italic *text*
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Inline code `text`
  text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
  // URLs
  text = text.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
  return text
}

export default function MarkdownText({ content }: Props) {
  const html = useMemo(() => {
    const lines = content.split('\n')
    const blocks: { type: BlockType; content: string[]; lang?: string }[] = []
    let current: { type: BlockType; content: string[]; lang?: string } = { type: 'normal', content: [] }

    for (const line of lines) {
      const fenceMatch = line.match(/^```(\w*)$/)
      if (fenceMatch) {
        if (current.type === 'code') {
          // Close code block
          blocks.push(current)
          current = { type: 'normal', content: [] }
        } else {
          // Start code block
          if (current.content.length > 0) blocks.push(current)
          current = { type: 'code', content: [], lang: fenceMatch[1] || undefined }
        }
        continue
      }
      current.content.push(line)
    }
    if (current.content.length > 0) blocks.push(current)

    // Render blocks to HTML
    const parts: string[] = []
    for (const block of blocks) {
      if (block.type === 'code') {
        const code = block.content.join('\n').trimEnd()
        parts.push(`<pre class="md-code-block">${highlightCode(code, block.lang)}</pre>`)
      } else {
        // Paragraph grouping — split on blank lines
        const text = block.content.join('\n')
        const paragraphs = text.split('\n\n')
        for (const para of paragraphs) {
          if (!para.trim()) continue
          const plines = para.trim().split('\n')

          // Check if it's a bullet list
          const isBullet = plines.every((l) => /^[\s]*[-*]\s/.test(l.trim()))
          const isNumbered = plines.every((l) => /^[\s]*\d+\.\s/.test(l.trim()))

          if (isBullet) {
            const items = plines.map((l) => `<li>${renderInline(l.trim().replace(/^[-*]\s+/, ''))}</li>`).join('')
            parts.push(`<ul class="md-list">${items}</ul>`)
          } else if (isNumbered) {
            const items = plines.map((l) => `<li>${renderInline(l.trim().replace(/^\d+\.\s+/, ''))}</li>`).join('')
            parts.push(`<ol class="md-list">${items}</ol>`)
          } else {
            parts.push(`<p class="md-paragraph">${renderInline(plines.join('<br/>'))}</p>`)
          }
        }
      }
    }

    return parts.join('')
  }, [content])

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

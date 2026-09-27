/**
 * Lexical approximation of the upstream tree-sitter `node_chain` used by
 * stale-anchor recovery's sibling-construct guard (omp facc0f9cdf).
 *
 * The original compares the chain of enclosing syntax nodes (kind + opening
 * row text) at an authored anchor against the chain at its remapped landing
 * point, refusing a remap that crosses into an identically shaped sibling
 * construct. This fork has no tree-sitter (see {@link ./syntax.ts}), so this
 * module infers the chain lexically: Python indentation blocks plus
 * `{`/`[` bracket depth for Python-family files, brace/bracket depth for
 * C-like files, and an empty chain for everything else — which makes the
 * guard a no-op where the original also had nothing to prove with.
 *
 * Positions are useless here — the point is to tell "the list under key `a`"
 * apart from an identically shaped list under key `b`, so the opening row's
 * content carries the identity.
 *
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

/** One enclosing construct: the row that opens it, plus how the chain tracks it. */
export interface ConstructInfo {
  /** How the construct is inferred: `bracket` (braces/brackets) or `block` (Python indentation). */
  kind: 'bracket' | 'block'
  /** The opening row's text with trailing whitespace removed (leading indent kept — it is part of the shape). */
  opener: string
}

type Lang = 'python' | 'brace'

const PYTHON_EXTS = new Set(['py', 'py3', 'pyi', 'pyw'])
const BRACE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx',
  'java', 'kt', 'kts', 'rs', 'go', 'cs', 'scala',
  'swift', 'dart', 'php', 'rb', 'erl', 'vue', 'svelte',
  'json', 'jsonc', 'json5',
])

function inferLanguage(path: string): Lang | null {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  if (PYTHON_EXTS.has(ext)) return 'python'
  if (BRACE_EXTS.has(ext)) return 'brace'
  return null
}

/** Leading-whitespace columns (tab = 8), for Python block nesting. */
function indentColumns(line: string): number {
  let columns = 0
  for (const ch of line) {
    if (ch === ' ') columns++
    else if (ch === '\t') columns += 8 - (columns % 8)
    else break
  }
  return columns
}

interface CharState {
  /** Quote char of a triple-quoted string spanning lines, or null. */
  inTriple: string | null
  /** Quote char of a single-line string, or null. */
  inString: string | null
  /** Inside a C-style block comment (C-like). */
  inBlockComment: boolean
}

interface ScanEvent {
  open: boolean
}

interface LineScan {
  events: ScanEvent[]
  /** Python only: the line opens an indentation block (its last significant char is `:` outside strings/comments). */
  isOpener: boolean
}

/**
 * Scan one line for bracket events and (Python) block-openers, honoring
 * single/double/triple-quoted strings, `#` comments (Python), and `//` /
 * C-style block comments (C-like). `state` carries string/comment context
 * across lines.
 */
function scanLine(line: string, lang: Lang, state: CharState): LineScan {
  const events: ScanEvent[] = []
  let lastSignificant = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (state.inTriple !== null) {
      if (ch === state.inTriple && line[i + 1] === state.inTriple && line[i + 2] === state.inTriple) {
        state.inTriple = null
        i += 2
      }
      continue
    }
    if (state.inString !== null) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === state.inString) state.inString = null
      continue
    }
    if (state.inBlockComment) {
      if (ch === '*' && line[i + 1] === '/') {
        state.inBlockComment = false
        i++
      }
      continue
    }
    if (ch === '#') break
    if (ch === '/' && lang === 'brace') {
      const next = line[i + 1]
      if (next === '/') break
      if (next === '*') {
        state.inBlockComment = true
        i++
        continue
      }
    }
    if (ch === "'" || ch === '"') {
      if (line[i + 1] === ch && line[i + 2] === ch) {
        state.inTriple = ch
        i += 2
      } else {
        state.inString = ch
      }
      continue
    }
    if (ch === '{' || ch === '[') events.push({ open: true })
    else if (ch === '}' || ch === ']') events.push({ open: false })
    if (ch !== ' ' && ch !== '\t') lastSignificant = ch
  }
  return { events, isOpener: lastSignificant === ':' }
}

/**
 * The chain of constructs enclosing `line` (1-indexed) in `lines`, innermost
 * first: each entry is the opening row's kind and text. Empty for files whose
 * language cannot be inferred (mirrors upstream's "no grammar — stay allowed").
 */
export function enclosingContext(
  lines: readonly string[],
  path: string,
  line: number,
): ConstructInfo[] {
  const lang = inferLanguage(path)
  if (lang === null) return []
  const brackets: Array<ConstructInfo & { line: number }> = []
  const blocks: Array<ConstructInfo & { line: number; indent: number }> = []
  const state: CharState = { inTriple: null, inString: null, inBlockComment: false }
  const limit = Math.min(lines.length, line)
  for (let i = 1; i <= limit; i++) {
    const text = lines[i - 1] ?? ''
    const trimmed = text.trim()
    const opener = text.replace(/\s+$/, '')
    const isBlankOrComment = lang === 'python' && (trimmed.length === 0 || trimmed.startsWith('#'))
    const indent = indentColumns(text)

    if (!isBlankOrComment) {
      // A line at (or below) a block's indentation is outside that block;
      // blank/comment-only lines are neutral in Python and never dedent.
      while (blocks.length > 0 && (blocks[blocks.length - 1]?.indent ?? 0) >= indent) blocks.pop()
    }

    const { events, isOpener } = scanLine(text, lang, state)
    for (const event of events) {
      if (event.open) brackets.push({ kind: 'bracket', opener, line: i })
      else brackets.pop()
    }
    if (!isBlankOrComment && isOpener) {
      blocks.push({ kind: 'block', opener, line: i, indent })
    }
  }

  // Merge the two independent stacks by opener line, innermost (most recent) first.
  return [...brackets, ...blocks]
    .sort((a, b) => b.line - a.line)
    .map(({ kind, opener }) => ({ kind, opener }))
}

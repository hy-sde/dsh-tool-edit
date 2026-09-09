/**
 * Lexical bracket-context for numbered diffs — the fallback scanner of the
 * original `utils/block-context.ts` (tree-sitter not wired in the harness
 * port; the original would have preferred `enclosingBlockBoundaries` first).
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

/** Where the source came from, so tree-sitter could pick a grammar (unused here). */
export interface BlockContextSource {
  path?: string
  lang?: string
}

const OPEN_TO_CLOSE: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
}

const CLOSE_TO_OPEN: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
}

interface StackEntry {
  opener: string
  lineNumber: number
  text: string
  visible: boolean
}

type ScannerMode = 'code' | 'single' | 'double' | 'template' | 'blockComment'

function findMatchingStackIndex(stack: readonly StackEntry[], opener: string): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index]?.opener === opener) return index
  }
  return -1
}

function isHashCommentStart(line: string, index: number): boolean {
  if (line[index] !== '#') return false
  for (let i = 0; i < index; i++) {
    const ch = line[i]
    if (ch !== ' ' && ch !== '\t') return false
  }
  return true
}

/**
 * Lexical bracket-matching fallback for sources tree-sitter can't parse
 * (unknown extensions, syntax errors). Pairs `()[]{}` while skipping strings
 * and line/block comments, and reports the matching line when one endpoint is
 * visible and the other is not.
 */
function lexicalBracketContext(fullLines: readonly string[], visible: ReadonlySet<number>): Map<number, string> {
  const context = new Map<number, string>()
  const stack: StackEntry[] = []
  let mode: ScannerMode = 'code'
  let escaped = false

  for (let lineIndex = 0; lineIndex < fullLines.length; lineIndex++) {
    const lineNumber = lineIndex + 1
    const line = fullLines[lineIndex] ?? ''
    const lineVisible = visible.has(lineNumber)
    let index = 0
    while (index < line.length) {
      const ch = line[index] ?? ''
      const next = index + 1 < line.length ? (line[index + 1] ?? '') : ''

      if (mode === 'blockComment') {
        if (ch === '*' && next === '/') {
          mode = 'code'
          index += 2
          continue
        }
        index++
        continue
      }

      if (mode === 'single' || mode === 'double' || mode === 'template') {
        if (escaped) {
          escaped = false
          index++
          continue
        }
        if (ch === '\\') {
          escaped = true
          index++
          continue
        }
        if (
          (mode === 'single' && ch === "'") ||
          (mode === 'double' && ch === '"') ||
          (mode === 'template' && ch === '`')
        ) {
          mode = 'code'
        }
        index++
        continue
      }

      if (ch === '/' && next === '/') break
      if (ch === '/' && next === '*') {
        mode = 'blockComment'
        index += 2
        continue
      }
      if (isHashCommentStart(line, index)) break
      if (ch === "'") {
        mode = 'single'
        escaped = false
        index++
        continue
      }
      if (ch === '"') {
        mode = 'double'
        escaped = false
        index++
        continue
      }
      if (ch === '`') {
        mode = 'template'
        escaped = false
        index++
        continue
      }

      if (OPEN_TO_CLOSE[ch]) {
        stack.push({ opener: ch, lineNumber, text: line, visible: lineVisible })
        index++
        continue
      }

      const opener = CLOSE_TO_OPEN[ch]
      if (opener) {
        const matchIndex = findMatchingStackIndex(stack, opener)
        if (matchIndex !== -1) {
          const [matched] = stack.splice(matchIndex)
          if (matched) {
            if (lineVisible && !matched.visible) context.set(matched.lineNumber, matched.text)
            if (matched.visible && !lineVisible) context.set(lineNumber, line)
          }
        }
      }

      index++
    }

    if (mode === 'single' || mode === 'double') {
      mode = 'code'
      escaped = false
    }
  }

  for (const lineNumber of visible) context.delete(lineNumber)
  return context
}

/**
 * Resolve the off-window boundary lines for a visible window (lexical bracket
 * scan). Returns a map of `lineNumber → source text` for the lines to surface,
 * never including a line already visible. When every line is visible the map
 * is empty.
 */
export function findBlockContextLines(
  fullLines: readonly string[],
  visibleInput: ReadonlySet<number> | readonly number[],
  _source: BlockContextSource = {},
): Map<number, string> {
  const visible = visibleInput instanceof Set ? visibleInput : new Set(visibleInput)
  if (visible.size === 0 || (fullLines.length > 0 && visible.size >= fullLines.length)) return new Map()
  return lexicalBracketContext(fullLines, visible)
}

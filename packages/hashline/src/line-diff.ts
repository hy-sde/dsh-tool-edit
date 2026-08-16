/**
 * Harness-native replacement for the original's `diffLineRuns` (imported from
 * `@oh-my-pi/pi-natives`). Ported from @oh-my-pi/hashline
 * (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025
 * Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 *
 * Runs a Myers O(ND) diff over the two texts' lines and emits runs in the
 * shape recovery.ts consumes: an ordered run list with `count` and
 * `added`/`removed` flags, where unchanged runs carry neither flag.
 */
export interface LineDiffRun {
  added?: boolean
  removed?: boolean
  count: number
}

type DiffOp = { op: 'equal'; count: number } | { op: 'insert'; count: number } | { op: 'delete'; count: number }

function myersDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let foundD = -1
  let d: number
  for (d = 0; d <= max && foundD === -1; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        // Move down.
        x = v[offset + k + 1]!
      } else {
        // Move right.
        x = v[offset + k - 1]! + 1
      }
      let y = x - k
      while (x < n && y < m && a[x]! === b[y]!) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        foundD = d
        break;
      }
    }
  }

  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (d = foundD; d > 0; d--) {
    const prev = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ op: 'equal', count: 1 })
      x--
      y--
    }
    if (x === prevX) {
      ops.push({ op: 'insert', count: 1 })
      y--
    } else {
      ops.push({ op: 'delete', count: 1 })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'equal', count: 1 })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ op: 'delete', count: 1 })
    x--
  }
  while (y > 0) {
    ops.push({ op: 'insert', count: 1 })
    y--
  }
  ops.reverse()

  const runs: DiffOp[] = []
  for (const op of ops) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.op === op.op) last.count += op.count
    else runs.push({ ...op })
  }
  return runs
}

/**
 * Line-level diff of `oldText` / `newText` (each compared line-split on
 * `"\n"` with a trailing empty element preserved like `String.split` does).
 * Returns runs in order with a `count` and an `added`/`removed` flag on the
 * runs that differ; unchanged runs carry neither flag.
 */
export function diffLineRuns(oldText: string, newText: string): LineDiffRun[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  return myersDiff(oldLines, newLines).map((op) => {
    if (op.op === 'equal') return { count: op.count }
    if (op.op === 'insert') return { added: true, count: op.count }
    return { removed: true, count: op.count }
  })
}

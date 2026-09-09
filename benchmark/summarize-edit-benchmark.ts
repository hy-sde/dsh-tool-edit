/**
 * Summarize one run-edit-benchmark JSON output into a compact per-task view,
 * and compare two preset arms (baseline vs rich-edit) on pass rate, timing,
 * tokens, and edit-tool usage.
 *
 * Usage:
 *   node scripts/summarize-edit-benchmark.ts <minimal.json> <code-edit.json>
 * @module dsh-summarize-edit-benchmark
 */

import { readFileSync } from 'node:fs'

interface TaskResult {
  preset: string
  task: string
  pass: boolean
  reason: string | undefined
  durationMs: number
  promptTokens: number
  completionTokens: number
  toolCalls: Record<string, number>
  toolFailures: Record<string, number>
  filesChecked: number
}

interface RunSummary {
  preset: string
  model: string
  tasksRun: number
  passed: number
  passRate: number
  totalDurationMs: number
  aggregates: {
    promptTokens: number
    completionTokens: number
    toolCalls: Record<string, number>
    toolFailures: Record<string, number>
  }
  results: TaskResult[]
}

function load(path: string): RunSummary {
  return JSON.parse(readFileSync(path, 'utf8')) as RunSummary
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const [basePath, editPath] = process.argv.slice(2)
if (!basePath || !editPath) {
  process.stderr.write('usage: node scripts/summarize-edit-benchmark.ts <baseline.json> <edit.json>\n')
  process.exit(1)
}
const base = load(basePath)
const edit = load(editPath)

console.log(`model: ${base.model}  |  ${base.preset} vs ${edit.preset}`)
console.log()
console.log('== pass rate ==')
console.log(`  ${base.preset.padEnd(20)} ${base.passed}/${base.tasksRun} (${(base.passRate * 100).toFixed(1)}%)`)
console.log(`  ${edit.preset.padEnd(20)} ${edit.passed}/${edit.tasksRun} (${(edit.passRate * 100).toFixed(1)}%)`)

console.log('\n== timing (ms) ==')
for (const [label, run] of [['baseline', base], ['edit', edit]] as const) {
  const durations = run.results.map(r => r.durationMs)
  console.log(`  ${label.padEnd(10)} mean=${Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)} median=${Math.round(median(durations))} total=${run.totalDurationMs}ms`)
}

console.log('\n== tokens ==')
for (const [label, run] of [['baseline', base], ['edit', edit]] as const) {
  const perTaskIn = run.results.map(r => r.promptTokens)
  const perTaskOut = run.results.map(r => r.completionTokens)
  console.log(`  ${label.padEnd(10)} in  total=${run.aggregates.promptTokens} avg=${Math.round(perTaskIn.reduce((a, b) => a + b, 0) / perTaskIn.length)}`)
  console.log(`  ${label.padEnd(10)} out total=${run.aggregates.completionTokens} avg=${Math.round(perTaskOut.reduce((a, b) => a + b, 0) / perTaskOut.length)}`)
}

console.log('\n== tool calls ==')
const toolNames = [...new Set([...Object.keys(base.aggregates.toolCalls), ...Object.keys(edit.aggregates.toolCalls)])].sort()
for (const name of toolNames) {
  const b = base.aggregates.toolCalls[name] ?? 0
  const e = edit.aggregates.toolCalls[name] ?? 0
  const bf = base.aggregates.toolFailures[name] ?? 0
  const ef = edit.aggregates.toolFailures[name] ?? 0
  if (name === 'edit') console.log(`  edit             base=${b} (fails ${bf})  edit=${e} (fails ${ef})  — the ported tool`)
  else console.log(`  ${name.padEnd(18)} base=${b}  edit=${e}`)
}
const baseFailTotal = Object.values(base.aggregates.toolFailures).reduce((a, b) => a + b, 0)
const editFailTotal = Object.values(edit.aggregates.toolFailures).reduce((a, b) => a + b, 0)
console.log(`  (total tool-level failures: base=${baseFailTotal}, edit=${editFailTotal})`)

console.log('\n== per-task deltas (tasks where outcomes differ) ==')
const byTask = new Map<string, [TaskResult, TaskResult]>()
for (const r of base.results) byTask.set(r.task, [r, r])
for (const r of edit.results) {
  const pair = byTask.get(r.task)
  if (pair) pair[1] = r
}
for (const [task, [b, e]] of byTask) {
  if (b.pass !== e.pass) {
    console.log(`  ${task.padEnd(38)} base=${b.pass ? 'PASS' : 'FAIL'}  edit=${e.pass ? 'PASS' : 'FAIL'}`)
  }
}

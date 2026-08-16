#!/usr/bin/env node
/**
 * Compare two benchmark runs (baseline str_replace_editor vs rich edit) and
 * print the same tables that benchmark/README.md hand-renders.
 *
 * Usage:
 *   node benchmark/compare.mjs benchmark/results/structural-minimal.json \
 *                              benchmark/results/structural-minimal-code-edit.json
 * @module dsh-tool-edit/benchmark
 */

import { readFileSync } from 'node:fs'

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function count(run, tool) {
  return run.aggregates.toolCalls[tool] ?? 0
}
function failures(run) {
  return Object.values(run.aggregates.toolFailures ?? {}).reduce((a, b) => a + b, 0)
}

const [basePath, editPath] = process.argv.slice(2)
if (!basePath || !editPath) {
  process.stderr.write('usage: node benchmark/compare.mjs <baseline.json> <edit.json>\n')
  process.exit(1)
}
const base = load(basePath)
const edit = load(editPath)

const dur = r => r.durationMs
const mean = run => Math.round(run.results.reduce((a, r) => a + dur(r), 0) / Math.max(1, run.results.length))
const pct = run => (run.passRate * 100).toFixed(1)

console.log(`model=${base.model} | ${base.preset} vs ${edit.preset}`)
console.log('')
console.log('| metric | baseline (str_replace_editor) | rich edit | Δ |')
console.log('|---|---|---|---|')
console.log(`| pass rate | ${base.passed}/${base.tasksRun} (${pct(base)}%) | ${edit.passed}/${edit.tasksRun} (${pct(edit)}%) | ${(edit.passRate - base.passRate) >= 0 ? '+' : ''}${((edit.passRate - base.passRate) * 100).toFixed(1)} pp |`)
const dt = edit.totalDurationMs - base.totalDurationMs
console.log(`| total wall time | ${Math.round(base.totalDurationMs / 1000)}s | ${Math.round(edit.totalDurationMs / 1000)}s | ${dt >= 0 ? '+' : ''}${dt}ms |`)
console.log(`| mean per task | ${mean(base)}ms | ${mean(edit)}ms | ${mean(edit) - mean(base)}ms |`)
console.log(`| median per task | ${median(base.results.map(dur))}ms | ${median(edit.results.map(dur))}ms | ${median(edit.results.map(dur)) - median(base.results.map(dur))}ms |`)
console.log(`| str_replace_editor calls | ${count(base, 'str_replace_editor')} | ${count(edit, 'str_replace_editor')} | |`)
console.log(`| edit calls | ${count(base, 'edit')} | ${count(edit, 'edit')} | |`)
console.log(`| read calls | ${count(base, 'read')} | ${count(edit, 'read')} | |`)
console.log(`| bash calls | ${count(base, 'bash')} | ${count(edit, 'bash')} | |`)
console.log(`| non-fatal FsError retries | ${failures(base)} | ${failures(edit)} | |`)
console.log(`| prompt tokens | ${base.aggregates.promptTokens.toLocaleString('en-US')} | ${edit.aggregates.promptTokens.toLocaleString('en-US')} | |`)
console.log(`| completion tokens | ${base.aggregates.completionTokens.toLocaleString('en-US')} | ${edit.aggregates.completionTokens.toLocaleString('en-US')} | |`)

console.log('\n-- per-task outcomes where the arms differ --')
const byTask = new Map()
for (const r of base.results) byTask.set(r.task, r)
for (const r of edit.results) {
  const pair = byTask.get(r.task)
  if (pair) pair.edit = r
}
for (const [task, pair] of byTask) {
  if (pair.pass !== pair.edit.pass) {
    console.log(`  ${task.padEnd(40)} baseline=${pair.pass ? 'PASS' : 'FAIL'}  edit=${pair.edit.pass ? 'PASS' : 'FAIL'}`)
  }
}

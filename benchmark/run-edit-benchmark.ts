/**
 * DSH-side driver for the oh-my-pi TypeScript edit benchmark.
 *
 * Boots the real `headless` profile (base bundle + settings + api-proxy +
 * credentials + agent-default-model) exactly as `dsh --profile headless`
 * does, disables its built-in one-shot runner, adds the
 * `dsh-agent-presets` roster, and for every task creates a fresh Agent with
 * the selected preset mounted, feeds it the task's pre-rendered prompt.md,
 * waits for quiescence, then byte-compares the produced workspace against the
 * task's expected/ directory.
 *
 * This file is shipped in the dsh-tool-edit repo but RUNS INSIDE a DeepSeek
 * Harness checkout: it imports `runProfile` from the harness CLI internals
 * (`apps/cli/src/profile-boot.ts`), which are not published to npm. Copy it
 * to `<harness>/scripts/run-edit-benchmark.ts` and run it from the harness
 * root (see benchmark/README.md in the plugin repo for the full setup).
 *
 * rc.7 arms. On stock harness releases the deployment's host `tool-fs`
 * provides `read`/`write`/`edit`, and the bench patch below KEEPS that row so
 * every arm sees the same `read`/`write`/`edit` surface; each arm's preset
 * only decides WHICH `edit` resolves (baseline = no editor row, the host's
 * stock `edit`; rich = a `tool-edit` row whose scoped `edit` shadows the host
 * one). The dedicated Anthropic-style `str_replace_editor` tool
 * (`tool-str-replace-editor`) is disabled for every arm.
 *
 * Usage (from the harness checkout root, after `pnpm i`):
 *   pnpm exec tsx scripts/run-edit-benchmark.ts --preset baseline \
 *     --fixtures <dir> --out results-baseline.json --limit 40
 *
 * A preset-level A/B run therefore differs in exactly one variable — WHICH
 * `edit` tool is mounted — matching the harness-change-only methodology of
 * the upstream study. NOTE: runs recorded before the rc.7 rework compared a
 * self-contained rich preset against the `str_replace_editor` tool; numbers
 * from the two arm designs are NOT directly comparable, see benchmark/README.md.
 * @module dsh-run-edit-benchmark
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { type Context } from '@deepseek-ai/cordis'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runProfile } from '../apps/cli/src/profile-boot.ts'

/** The shipped preset root this app reads, exactly as profile-boot resolves it. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../apps/cli/config/agent-presets', import.meta.url))

/** Pilot slice: operator/identifier/literal/duplicate/multi-composite — 40 tasks. */
const PILOT_CATEGORIES = new Set(['operator', 'identifier', 'literal', 'duplicate', 'multi-composite', 'multi'])

export interface BenchmarkTask {
  id: string
  prompt: string
  inputDir: string
  expectedDir: string
}

export interface TaskResult {
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

export interface RunArgs {
  preset: string
  fixtures: string
  out: string
  tasks: string[] | undefined
  limit: number | undefined
  timeoutMs: number
  nonce: string
}

const HELP = `run-edit-benchmark: drive the oh-my-pi edit tasks through a DSH preset.

Usage:
  pnpm exec tsx scripts/run-edit-benchmark.ts --preset <id> --fixtures <dir> --out <file> [--tasks a,b,c] [--limit N] [--timeout-ms N]

Flags:
  --preset    Shipped preset id to mount per agent (e.g. minimal, code-edit).
  --fixtures  Directory containing extracted benchmark fixture task dirs.
  --out       JSON output file for per-task results.
  --tasks     Comma-separated task ids; defaults to the 40-task pilot slice.
  --limit     Run only the first N selected tasks (dry-run validation).
  --timeout-ms  Per-task quiescence budget (default 360000).
`

function parseArgs(argv: string[]): RunArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const preset = get('--preset')
  const fixtures = get('--fixtures')
  const out = get('--out')
  if (preset === undefined || fixtures === undefined || out === undefined) {
    throw new Error('--preset, --fixtures and --out are required; pass --help for usage')
  }
  const tasksArg = get('--tasks')
  const limitArg = get('--limit')
  const timeoutArg = get('--timeout-ms')
  return {
    preset,
    fixtures: resolve(fixtures),
    out: resolve(out),
    tasks: tasksArg === undefined ? undefined : tasksArg.split(',').map(part => part.trim()).filter(part => part !== ''),
    limit: limitArg === undefined ? undefined : Number(limitArg),
    timeoutMs: timeoutArg === undefined ? 360_000 : Number(timeoutArg),
    nonce: Math.random().toString(36).slice(2, 8),
  }
}

/** List the fixture task ids, optionally narrowed to the pilot categories. */
export function listTasks(fixturesDir: string, pilotOnly: boolean): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(id => !pilotOnly || PILOT_CATEGORIES.has((id.split('-', 1)[0] ?? '').toLowerCase()))
    .sort()
}

/** Load one task's prompt and workspace/expected dirs from an extracted fixture. */
export function loadTask(fixturesDir: string, id: string): BenchmarkTask {
  const root = join(fixturesDir, id)
  if (!existsSync(join(root, 'prompt.md'))) throw new Error(`task ${id}: missing prompt.md`)
  return {
    id,
    prompt: readFileSync(join(root, 'prompt.md'), 'utf8'),
    inputDir: join(root, 'input'),
    expectedDir: join(root, 'expected'),
  }
}

/** Recursively list file paths (dir-relative) under a directory. */
function listFiles(root: string, base = ''): string[] {
  const out: string[] = []
  const full = join(root, base)
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(root, rel))
    else out.push(rel)
  }
  return out.sort()
}

/** Byte-compare every expected file against the produced workspace. */
export function verifyWorkspace(workdir: string, expectedDir: string): { pass: boolean; filesChecked: number } {
  let filesChecked = 0
  for (const rel of listFiles(expectedDir)) {
    const expected = readFileSync(join(expectedDir, rel), 'utf8')
    const actualPath = join(workdir, rel)
    if (!existsSync(actualPath)) return { pass: false, filesChecked }
    const actual = readFileSync(actualPath, 'utf8')
    filesChecked += 1
    if (actual !== expected) return { pass: false, filesChecked }
  }
  return { pass: true, filesChecked }
}

/**
 * The overlay patch that turns `headless` into a preset-driven bench host.
 *
 * The host plane supplies the shared tool surface: `tool-fs` (`read`, `write`,
 * `edit`) stays ENABLED so every arm — and its preset — sees identical
 * `read`/`write`/`edit`. All other host-plane model-facing rows are disabled
 * (one-shot drivers, bash, skills, goals, todo, web, …), and the standalone
 * Anthropic-style `str_replace_editor` tool is disabled, so the A/B differs
 * only in which `edit` the arm preset exposes. The `dsh-agent-presets` roster
 * (including the user root, where this repo's bench presets are installed) is
 * inserted so each task Agent can mount a preset.
 */
export function writeBenchPatch(preset: string, dir: string): string {
  const patchPath = join(dir, `bench-${preset.replace(/[^A-Za-z0-9-]/g, '_')}.yml`)
  const disables = [
    'headless-startup',
    'headless-runner',
    'code-runtime',
    'tool-bash',
    'tool-pwsh',
    'tool-jobs',
    'tool-str-replace-editor',
    'skill-filesystem',
    'tool-skill',
    'tool-goal',
    'plan-mode',
    'compaction-basic',
    'command-compact',
    'tool-result-pruner',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-subagent',
    'tool-subagent-fork',
    'workflow-worker-thread',
    'tool-workflow',
    'tool-ralph',
    'agent-instructions',
    'tool-todo',
    'tool-web',
  ]
  const content = [
    '# Generated by run-edit-benchmark.ts — disables the non-editor host-plane',
    '# model-facing tool rows (one-shot drivers, shell, skills, goals, todo,',
    '# web) plus the standalone str_replace_editor tool. `tool-fs` STAYS enabled:',
    '# its shared read/write/edit surface is what every arm sees, and each arm',
    '# preset only re-picks the `edit` implementation (baseline: none, host stock',
    '# edit; rich: @hy-sde-org/dsh-tool-edit scoped shadow). The roster incl.',
    '# user presets so each task Agent can mount the selected bench preset.',
    ...disables.map(id => `- id: ${id}\n  disabled: true`),
    '',
    '- insert:',
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '      config:',
    `        default: ${preset}`,
    '        includeUserRoot: true',
    '',
  ].join('\n')
  writeFileSync(patchPath, content)
  return patchPath
}

/** Set up a fresh workspace copy of the task's input/ dir. */
function prepareWorkdir(workRoot: string, id: string): string {
  const workdir = join(workRoot, id.replace(/[^A-Za-z0-9_-]/g, '_'))
  rmSync(workdir, { recursive: true, force: true })
  mkdirSync(workdir, { recursive: true })
  return workdir
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const raced = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
    return raced
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Run one task to quiescence and measure it. */
async function runTask(args: RunArgs, ctxAny: unknown, workdir: string, task: BenchmarkTask): Promise<TaskResult> {
  const ctx = ctxAny as {
    agents: {
      create(
        options: Record<string, unknown>,
      ): Promise<{
        agent: {
          whenIdle(): Promise<void>
          followup(message: unknown): void
          session: { seq: number; events: readonly unknown[] }
        }
      }>
    }
    agentPresets: { mount(ctx: Context, preset: string): Promise<void> }
    agentDefaultModel: { currentSelection(): { provider: string; model: string } }
    tools: { schemas(source?: unknown): Array<{ name: string }> }
  }
  const selection = ctx.agentDefaultModel.currentSelection()
  let agent:
    | {
      whenIdle(): Promise<void>
      followup(message: unknown): void
      session: { seq: number; events: readonly unknown[] }
    }
    | undefined
  let mountError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const created = await ctx.agents.create({
        sessionId: SessionId(`bench-${args.preset}-${task.id}-${args.nonce}`),
        meta: { cwd: workdir },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx: Context) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          await ctx.agentPresets.mount(agentCtx, args.preset)
        },
      })
      agent = created.agent
      break
    } catch (error) {
      mountError = error
      await sleep(500)
    }
  }
  if (agent === undefined) {
    return {
      preset: args.preset,
      task: task.id,
      pass: false,
      reason: `mount failed: ${mountError instanceof Error ? mountError.message : String(mountError)}`,
      durationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: {},
      toolFailures: {},
      filesChecked: 0,
    }
  }

  const toolNames = ctx.tools.schemas(agent).map(schema => schema.name)
  if (process.env.BENCH_DEBUG === '1') {
    process.stdout.write(`bench:   tools=${toolNames.join(',')}\n`)
  }
  await agent.whenIdle()
  const started = Date.now()
  let reason: string | undefined
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task.prompt }],
      source: { kind: 'user' },
    }))
    await withTimeout(agent.whenIdle(), args.timeoutMs, `task ${task.id}`)
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  const durationMs = Date.now() - started

  // Project the session's owned scalars: token usage over assistant steps,
  // tool-call counts, tool failures reported by tool/result, and the turn reason.
  let promptTokens = 0
  let completionTokens = 0
  const toolCalls: Record<string, number> = {}
  const toolFailures: Record<string, number> = {}
  for (const event of agent.session.events) {
    const data = (event as { data?: Record<string, unknown> }).data ?? {}
    if ((event as { type?: string }).type === 'assistant/message') {
      const usage = data.usage as { inputTokens?: number; outputTokens?: number } | undefined
      if (usage !== undefined) {
        promptTokens += usage.inputTokens ?? 0
        completionTokens += usage.outputTokens ?? 0
      }
    } else if ((event as { type?: string }).type === 'tool/call') {
      const name = String(data.name ?? '?')
      toolCalls[name] = (toolCalls[name] ?? 0) + 1
    } else if ((event as { type?: string }).type === 'tool/result') {
      const error = data.error as { name?: string } | undefined
      if (error !== undefined) {
        const name = error.name ?? 'tool-error'
        toolFailures[name] = (toolFailures[name] ?? 0) + 1
      }
    } else if ((event as { type?: string }).type === 'turn/end') {
      const turnReason = data.reason as { kind?: string; error?: { code?: string } } | undefined
      if (turnReason?.kind === 'error') reason = turnReason.error?.code ?? 'error'
    }
  }

  const verified = verifyWorkspace(workdir, task.expectedDir)
  if (process.env.BENCH_DEBUG === '1') {
    const tail = agent.session.events.slice(-6).map((event) => {
      const data = (event as { data?: Record<string, unknown> }).data ?? {}
      const type = (event as { type?: string }).type ?? '?'
      if (type === 'turn/end') return `${type}:${JSON.stringify(data.reason)}`
      if (type === 'tool/call') return `${type}:${String(data.name)}`
      if (type === 'user/message') return `${type}:<${(data.content as { type: string }[] | undefined)?.map(block => block.type).join(',')}>`
      return `${type}`
    }).join(' | ')
    process.stdout.write(`bench:   events=${tail}\n`)
    process.stdout.write(`bench:   verify=${JSON.stringify(verified)}\n`)
  }
  return {
    preset: args.preset,
    task: task.id,
    pass: verified.pass,
    reason: reason ?? 'completed',
    durationMs,
    promptTokens,
    completionTokens,
    toolCalls,
    toolFailures,
    filesChecked: verified.filesChecked,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.fixtures)) throw new Error(`fixtures dir does not exist: ${args.fixtures}`)

  const taskIds = args.tasks ?? listTasks(args.fixtures, true)
  const selected = args.limit === undefined ? taskIds : taskIds.slice(0, args.limit)
  if (selected.length === 0) throw new Error('no tasks selected')

  const benchDir = join(dirname(args.out), '.bench-work')
  mkdirSync(benchDir, { recursive: true })
  const patchPath = writeBenchPatch(args.preset, benchDir)
  const workRoot = join(benchDir, `${args.preset}-${basename(args.out).replace(/\.json$/, '')}`)
  mkdirSync(workRoot, { recursive: true })

  process.stdout.write(`bench: preset=${args.preset} tasks=${selected.length} (${selected[0]}…${selected[selected.length - 1]}), patch=${basename(patchPath)}\n`)
  process.stdout.write(`bench: model route comes from agent-default-model settings; mounting shipped presets from ${SHIPPED_PRESET_ROOT}\n`)

  const { ctx, shutdown } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'headless',
    patchFiles: [patchPath],
    args: [],
  })
  try {
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const presetSvc = ctx.get('agentPresets')
    const defaultModel = ctx.get('agentDefaultModel')
    if (agents === undefined || presetSvc === undefined || defaultModel === undefined) {
      throw new Error('bench: headless profile lacks agents/agentPresets/agentDefaultModel')
    }
    // Cold-start settle: preset rows inject host services the loader publishes
    // during apply; a first mount racing that publish sees `systemPrompt`
    // missing and fails. Poll the host services into existence before running.
    const settleDeadline = Date.now() + 15_000
    while (Date.now() < settleDeadline) {
      if (ctx.get('systemPrompt') !== undefined && ctx.get('tools') !== undefined) break
      await sleep(100)
    }
    const selection = defaultModel.currentSelection()
    process.stdout.write(`bench: route provider=${selection.provider} model=${selection.model}\n`)

    const results: TaskResult[] = []
    for (const id of selected) {
      const task = loadTask(args.fixtures, id)
      const workdir = prepareWorkdir(workRoot, `${id}`)
      cpSync(task.inputDir, workdir, { recursive: true })
      process.stdout.write(`bench: [${results.length + 1}/${selected.length}] ${id} …\n`)
      const result = await runTask(args, ctx, workdir, task)
      results.push(result)
      const mark = result.pass ? 'PASS' : 'FAIL'
      process.stdout.write(
        `bench:   ${mark} ${id} in ${result.durationMs}ms (${result.promptTokens}in/${result.completionTokens}out) reason=${result.reason}\n`,
      )
      rmSync(workdir, { recursive: true, force: true })
      writeFileSync(args.out, JSON.stringify({ preset: args.preset, model: selection.model, results }, null, 2))
    }

    const passed = results.filter(result => result.pass).length
    const summary = {
      preset: args.preset,
      model: selection.model,
      tasksRun: results.length,
      passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      totalDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
      aggregates: {
        promptTokens: results.reduce((sum, result) => sum + result.promptTokens, 0),
        completionTokens: results.reduce((sum, result) => sum + result.completionTokens, 0),
        toolCalls: results.reduce((map, result) => {
          for (const [name, count] of Object.entries(result.toolCalls)) map[name] = (map[name] ?? 0) + count
          return map
        }, {} as Record<string, number>),
        toolFailures: results.reduce((map, result) => {
          for (const [name, count] of Object.entries(result.toolFailures)) map[name] = (map[name] ?? 0) + count
          return map
        }, {} as Record<string, number>),
      },
    }
    writeFileSync(args.out, JSON.stringify({ ...summary, results }, null, 2))
    process.stdout.write(`bench: DONE preset=${args.preset} ${passed}/${results.length} pass (${summary.passRate.toFixed(3)})\n`)
    process.stdout.write(`bench: summary written to ${args.out}\n`)
  } finally {
    await sleep(50)
    await shutdown.shutdown(0)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`bench: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  })
}

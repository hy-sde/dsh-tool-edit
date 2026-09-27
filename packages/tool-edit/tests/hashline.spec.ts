import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { computeFileHash, getSessionSnapshotStore } from '@hy-sde-org/dsh-hashline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { getSnapshotStore } from '../src/hashline/store.ts'
import * as ToolEdit from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`tool-edit-hashline-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`tool-edit-hashline-${++callNumber}`),
    name: 'edit',
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

async function setup(config: ToolEdit.Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-hashline-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const fiber = await ctx.plugin(ToolEdit, config)
  return { ctx, root, fiber, owner: agent(ctx, root) }
}

describe('tool-edit (hashline mode)', () => {
  it('replaces an anchored line range and persists the new snapshot', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'greet.py')
    const before = 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\n'
    await writeFile(sample, before)

    const tag = computeFileHash(before)
    const input = [
      `[${sample}#${tag}]`,
      'PUT 1.=2:',
      '+def greet(name):',
      '+    print(f"Hello, {name}")',
      '',
    ].join('\n')

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('def greet(name):\n    print(f"Hello, {name}")\ngreet("world")\n')
  })

  it('inserts rows before a line with the gap syntax', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'list.txt')
    const before = 'one\ntwo\nthree\n'
    await writeFile(sample, before)

    const tag = computeFileHash(before)
    const input = [
      `[${sample}#${tag}]`,
      'PUT <2:',
      '+inserted',
      '',
    ].join('\n')

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('one\ninserted\ntwo\nthree\n')
  })

  it('rejects a stale tag without touching the file', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'stale.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)

    // A tag that hashes a DIFFERENT (stale) text must fail the anchor check.
    const staleTag = computeFileHash('completely different\n')
    const input = `[${sample}#${staleTag}]\nPUT 1.=2:\n+replacement\nline\n`

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    expect(await readFile(sample, 'utf8')).toBe(before)
  })
})

describe('tool-edit (hashline) × fs-observation-policy', () => {
  /** Like `setup` but with the read-before-edit policy mounted. */
  async function setupGuarded(config: ToolEdit.Config = {}) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-hashline-guarded-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(FsPolicy)
    const fiber = await ctx.plugin(ToolEdit, config)
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  it('a tag minted through the shared session store lands on the first attempt', async () => {
    const { ctx, root, owner } = await setupGuarded()
    const sample = join(root, 'greet.py')
    const before = 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\n'
    await writeFile(sample, before)

    // The contract restored in the fork (bfce5d6505): an external read/grep
    // tool records what it displayed into the SAME per-session store the edit
    // patcher reads from. `getSnapshotStore` (tool-edit's accessor) must
    // return the identical instance `getSessionSnapshotStore` hands the
    // harness `read` tool — tags and seen-line provenance then fuse.
    const shared = getSnapshotStore(owner.session as object)
    const external = getSessionSnapshotStore(owner.session as object)
    expect(shared).toBe(external)
    const tag = external.record(sample, before, [1, 2, 3])
    expect(tag).toBe(computeFileHash(before))

    // First edit attempt, tag copied verbatim from the read-side output: no
    // rejection, no extra read round-trip.
    const input = [
      `[${sample}#${tag}]`,
      'PUT 1.=2:',
      '+def greet(name):',
      '+    print(f"Hello, {name}")',
      '',
    ].join('\n')
    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('def greet(name):\n    print(f"Hello, {name}")\ngreet("world")\n')
  })

  it('a blind hashline edit lands in one call: the executor self-observes under the policy', async () => {
    const { ctx, root, owner } = await setupGuarded()
    const sample = join(root, 'blind.txt')
    const before = 'alpha\nbeta\n'
    await writeFile(sample, before)

    // No read tool call at all. The prepare-time read by the hashline executor
    // itself records the presence observation, so the guarded write passes
    // with the version CAS intact — omp self-contained semantics.
    const tag = computeFileHash(before)
    const input = `[${sample}#${tag}]\nPUT 1.=1:\n+ALPHA\n`
    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('ALPHA\nbeta\n')
  })

  it('agentless hashline edits stay gated by the observation policy', async () => {
    const { ctx, root } = await setupGuarded()
    const sample = join(root, 'gated.txt')
    const before = 'line one\n'
    await writeFile(sample, before)

    // No owner session: the executor's reads cannot be attributed to anyone,
    // so the policy keeps rejecting the write — an agentless caller cannot
    // satisfy read-before-edit by inventing a session.
    const tag = computeFileHash(before)
    const input = `[${sample}#${tag}]\nPUT 1.=1:\n+CHANGED\n`
    const result = await call(ctx, undefined, { input })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
    expect(await readFile(sample, 'utf8')).toBe(before)
  })
})

describe('tool-edit (hashline mode) × edit-result line provenance', () => {
  /** Full composition with seen-line enforcement: real backend + shared snapshot store + rich editor. */
  async function provenanceStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-provenance-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const fiber = await ctx.plugin(ToolEdit, { enforceSeenLines: true })
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  function modelText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  it('registers displayed edit-result rows as post-edit snapshot provenance: rejects hidden lines, accepts displayed lines', async () => {
    const { ctx, root, owner } = await provenanceStack()
    const sample = join(root, 'a.txt')
    const source = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n'
    // Post-edit content: `NEWLINE` inserted after line 2 (13 lines).
    const edited = 'line1\nline2\nNEWLINE\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n'
    await writeFile(sample, source)

    // The harness `read` tool records what it displayed onto the session's
    // hoisted snapshot store (getSessionSnapshotStore). The plugins workspace
    // has no dsh-tool-fs, so record a partial read (lines 1-2 displayed)
    // directly through the same shared store — identical provenance.
    const store = getSessionSnapshotStore(owner.session)
    const originalTag = store.record(sample, source, [1, 2])
    expect(originalTag).toBe(computeFileHash(source))

    // First edit anchors the seen line 2 (PUT >2 = insert after). The rendered
    // rows are `1:line1`, `2:line2`, `3:NEWLINE` — row 3 was NEVER displayed by
    // the read, so registering it as seen provenance on the post-edit tag is
    // the fix under test (omp cea3caf71f). Without it the follow-up edit at
    // line 3 would be rejected as anchored on a never-displayed line.
    const first = await call(ctx, owner, {
      input: `[${sample}#${originalTag}]\nPUT >2:\n+NEWLINE\n`,
    })
    expect(first.isError).toBe(false)
    const firstText = modelText(first)
    expect(firstText).toContain('3:NEWLINE')
    const editedTag = computeFileHash(edited)

    // (a) A line the edit result did NOT display stays rejected under the
    // post-edit tag: line 13 (the tail) was hidden under the rendered rows.
    const hidden = await call(ctx, owner, {
      input: `[${sample}#${editedTag}]\nPUT 13.=13:\n+LINE13\n`,
    })
    expect(hidden.isError).toBe(true)
    expect(modelText(hidden)).toContain('lines 13')

    // (b) A line the edit result DID display is accepted under the same tag:
    // line 3 is anchorable because the edit result rendered it as `3:NEWLINE`
    // and registered it as seen provenance on the post-edit snapshot.
    const seen = await call(ctx, owner, {
      input: `[${sample}#${editedTag}]\nPUT 3.=3:\n+LINE3\n`,
    })
    expect(seen.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(
      'line1\nline2\nLINE3\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n',
    )
  })
})

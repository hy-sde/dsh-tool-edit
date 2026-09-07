import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolEdit from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`tool-edit-owner-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
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

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`tool-edit-${++callNumber}`),
    name: 'edit',
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

async function setup(
  config: ToolEdit.Config = {},
  options: { fsPolicy?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  if (options.fsPolicy === true) await ctx.plugin(FsPolicy)
  const fiber = await ctx.plugin(ToolEdit, config)
  return { ctx, root, fiber, owner: agent(ctx, root) }
}

describe('tool-edit (replace mode)', () => {
  it('registers the edit tool with the four-mode schema and diff/generic calls', async () => {
    const { ctx, fiber } = await setup({ description: 'custom edit description' })
    expect(ctx.tools.schemas().map(item => item.name)).toEqual(['edit'])
    const schema = ctx.tools.schemas()[0]
    expect(schema?.description).toBe('custom edit description')
    const properties = (schema?.parameters as {
      properties: Record<string, { type?: string }>
    }).properties
    expect(properties.path?.type).toBe('string')
    expect(properties.old_string?.type).toBe('string')
    expect(properties.new_string?.type).toBe('string')
    expect(properties.replace_all?.type).toBe('boolean')
    expect(properties.edits?.type).toBe('array')
    expect(properties.input?.type).toBe('string')

    // Replace call → diff card from the literal old/new strings.
    expect(ctx.tools.get('edit')?.presentCall?.({
      path: '/workspace/a.txt',
      old_string: 'old',
      new_string: 'new',
    })).toMatchObject({
      card: 'diff',
      title: 'Edit /workspace/a.txt',
      diffs: [{ path: '/workspace/a.txt', oldText: 'old', newText: 'new' }],
    })
    // Patch call → generic edit card with locations.
    expect(ctx.tools.get('edit')?.presentCall?.({
      path: '/workspace/a.txt',
      edits: [{ op: 'update', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n' }],
    })).toMatchObject({
      card: 'generic',
      kind: 'edit',
      locations: [{ path: '/workspace/a.txt' }],
    })
    // apply_patch call → generic edit card (input payload, no locations).
    expect(ctx.tools.get('edit')?.presentCall?.({
      input: '*** Begin Patch\n*** Update File: /workspace/a.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch',
    })).toMatchObject({ card: 'generic', kind: 'edit' })

    // Replace result meta → presentResult diff card.
    const presentResult = ctx.tools.get('edit')?.presentResult?.(
      { path: '/workspace/a.txt', old_string: 'old', new_string: 'new' },
      { meta: { diffs: [{ path: '/workspace/a.txt', oldText: 'old', newText: 'new' }] }, content: [], isError: false },
    )
    expect(presentResult).toMatchObject({
      card: 'diff',
      diffs: [{ path: '/workspace/a.txt', oldText: 'old', newText: 'new' }],
    })

    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.get('edit')).toBeUndefined()
  })

  it('replaces text end-to-end through ctx.fs', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'sample.txt')
    await writeFile(sample, 'one\ntwo\nthree\n')

    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'two',
      new_string: 'TWO',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`Successfully replaced text in ${sample}.`)
    expect(await readFile(sample, 'utf8')).toBe('one\nTWO\nthree\n')
  })

  it('replaces every occurrence with replace_all', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'repeat.txt')
    await writeFile(sample, 'same\nmiddle\nsame\n')

    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'same',
      new_string: 'SAME',
      replace_all: true,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`Successfully replaced 2 occurrences in ${sample}.`)
    expect(await readFile(sample, 'utf8')).toBe('SAME\nmiddle\nSAME\n')
  })

  it('falls back to fuzzy whitespace matching when the verbatim old_string misses', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'fuzzy.txt')
    await writeFile(sample, 'const answer =  a   +  b\n')

    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'const answer = a + b',
      new_string: 'const answer = c',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`Successfully replaced text in ${sample}.`)
    expect(await readFile(sample, 'utf8')).toBe('const answer = c\n')
  })

  it('rejects ambiguous single replacements without mutating the file', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'ambiguous.txt')
    await writeFile(sample, 'same\nother\nsame\n')

    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'same',
      new_string: 'x',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Found 2 occurrences')
    expect(text(result)).toContain('more context')
    expect(await readFile(sample, 'utf8')).toBe('same\nother\nsame\n')
  })

  it('rejects a missing old_string without touching the file', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'missing.txt')
    await writeFile(sample, 'content\n')

    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'absent',
      new_string: 'x',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('absent')
    expect(await readFile(sample, 'utf8')).toBe('content\n')
  })

  it('self-observes its own read so a blind edit lands; the policy still gates agentless calls', async () => {
    const { ctx, root, owner } = await setup({}, { fsPolicy: true })
    const sample = join(root, 'guarded.txt')
    await writeFile(sample, 'before')

    // First try, no separate read step: the executor's authoritative read
    // records the fs/observed presence record for the same owner, so the
    // edit lands in one call (omp self-contained semantics) — while the
    // write still goes through the policy's version CAS.
    const landed = await call(ctx, owner, {
      path: sample,
      old_string: 'before',
      new_string: 'after',
    })
    expect(landed.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('after')

    // Agentless direct execution has no owner to attribute an observation to,
    // so the policy keeps rejecting it: a harness-side caller cannot satisfy
    // the read-before-edit contract by inventing a session.
    const sample2 = join(root, 'guarded2.txt')
    await writeFile(sample2, 'value')
    const agentless = await call(ctx, undefined, {
      path: sample2,
      old_string: 'value',
      new_string: 'other',
    })
    expect(agentless.isError).toBe(true)
    expect(agentless.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
    expect(await readFile(sample2, 'utf8')).toBe('value')
  })

  it('rejects invalid config', () => {
    expect(() => {
      ToolEdit.apply(new Context(), { fuzzyThreshold: 2 })
    }).toThrow('fuzzyThreshold must be in (0, 1]')
  })

  it('applies a unified-diff entry in patch mode', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'patched.txt')
    await writeFile(sample, 'line one\nline two\nline three\n')

    const diff = [
      '--- a/patched.txt',
      '+++ b/patched.txt',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+line TWO',
      ' line three',
      '',
    ].join('\n')
    const result = await call(ctx, owner, {
      path: sample,
      edits: [{ op: 'update', diff }],
    })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('line one\nline TWO\nline three\n')
  })

  it('applies a Codex apply-patch envelope in apply_patch mode', async () => {
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const sample = join(root, 'codex.txt')
    await writeFile(sample, 'alpha\nbeta\ngamma\n')

    const input = [
      '*** Begin Patch',
      `*** Update File: ${sample}`,
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
      '',
    ].join('\n')
    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('alpha\nBETA\ngamma\n')
  })
})
describe('path aliases and no-op edits', () => {
  it('accepts file_path as an alias for path', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'a.txt')
    await writeFile(sample, 'hello world\n')
    const result = await call(ctx, owner, {
      file_path: sample,
      old_string: 'hello',
      new_string: 'goodbye',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Successfully replaced text')
    expect(await readFile(sample, 'utf8')).toBe('goodbye world\n')
  })

  it('accepts filePath as an alias for path', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'b.txt')
    await writeFile(sample, 'alpha\n')
    const result = await call(ctx, owner, {
      filePath: sample,
      old_string: 'alpha',
      new_string: 'omega',
    })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('omega\n')
  })

  it('reports an unchanged edit as a no-change success instead of an error', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'c.txt')
    await writeFile(sample, 'same\n')
    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'same',
      new_string: 'same',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('No change')
    expect(await readFile(sample, 'utf8')).toBe('same\n')
  })

  it('retries a replace once when the guarded write reports FS_STALE_VERSION', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'stale.txt')
    await writeFile(sample, 'stale\n')
    const fs = ctx.fs as unknown as { writeText: (...args: unknown[]) => Promise<unknown> }
    const original = fs.writeText.bind(ctx.fs)
    let attempts = 0
    fs.writeText = async (...args) => {
      attempts++
      if (attempts === 1) {
        throw new FsError('cannot write "stale.txt": file changed since it was read', 'FS_STALE_VERSION')
      }
      return original(...args)
    }
    const result = await call(ctx, owner, {
      path: sample,
      old_string: 'stale',
      new_string: 'fresh',
    })
    expect(result.isError).toBe(false)
    expect(attempts).toBe(2)
    expect(await readFile(sample, 'utf8')).toBe('fresh\n')
  })
})

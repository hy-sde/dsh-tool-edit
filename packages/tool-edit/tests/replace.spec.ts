import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolEdit from '../src/index.ts'
import { errorKindOf } from '@hy-sde-org/dsh-hashline'
import { applyCodexPatch, parseApplyPatch, parseApplyPatchStreaming } from '../src/apply-patch.ts'
import { parseApplyPatchHunks } from '../src/diff.ts'
import { applyPatch, type FileSystem } from '../src/patch.ts'

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
  const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    model: { current: () => undefined, select: () => {} },
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

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({
    calls: [{ type: 'tool-call' as const, id: ToolCallId(`tool-edit-${++callNumber}`), name: 'edit', arguments: JSON.stringify(args)}],
    signal: new AbortController().signal,
    ...owner === undefined ? {} : { agent: owner },
  }).then(b => b.results[0]!.result)
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
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
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

// Ported from oh-my-pi crates/pi-edit/tests/fixtures/apply_patch/core.json
// (first-match binding, commits 1bf55e7414, b2a8496255, 5d999d5868, 0142429b5d):
// a context-free hunk whose lines occur more than once binds to the first
// exact or whitespace/unicode-normalized match at or after the previous hunk,
// like Codex (oh-my-pi ceeb647e12): fuzzy, substring and
// wrap-behind-the-previous-hunk matches are rejected instead of guessed.
describe('tool-edit (apply_patch mode) first-match binding', () => {
  async function applyEnvelope(content: string, hunkLines: string[]) {
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const sample = join(root, 'a.txt')
    await writeFile(sample, content)
    const input = ['*** Begin Patch', `*** Update File: ${sample}`, ...hunkLines, '*** End Patch', ''].join('\n')
    const result = await call(ctx, owner, { input })
    return { result, sample }
  }

  it('context-free hunk takes the first of repeated lines', async () => {
    const { result, sample } = await applyEnvelope('x\na\nx\nb\n', ['@@', '-x', '+y'])
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('y\na\nx\nb\n')
  })

  it('context-free hunks bind to successive repeated lines', async () => {
    const { result, sample } = await applyEnvelope('x\na\nx\nb\n', ['@@', '-x', '+y', '@@', '-x', '+z'])
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('y\na\nz\nb\n')
  })

  it('first-match binding does not wrap behind the previous hunk', async () => {
    const { result, sample } = await applyEnvelope('x\nx\nz\n', ['@@', '-z', '+Z', '@@', '-x', '+y'])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Failed to find expected lines in ${sample}`)
    expect(await readFile(sample, 'utf8')).toBe('x\nx\nz\n')
  })

  it('ambiguous fuzzy hunk is rejected, not bound to the first candidate', async () => {
    const { result, sample } = await applyEnvelope('const timeoutMs = 1000;\nother\nconst timeoutMs = 2000;\n', [
      '@@',
      '-const timeoutMs = 3000;',
      '+const timeoutMs = 5000;',
      '@@',
      '-other',
      '+OTHER',
    ])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Failed to find expected lines in ${sample}`)
    expect(await readFile(sample, 'utf8')).toBe('const timeoutMs = 1000;\nother\nconst timeoutMs = 2000;\n')
  })

  it('single ambiguous fuzzy hunk is rejected', async () => {
    const { result, sample } = await applyEnvelope('const timeoutMs = 1000;\nother\nconst timeoutMs = 2000;\n', [
      '@@',
      '-const timeoutMs = 3000;',
      '+const timeoutMs = 5000;',
    ])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Failed to find expected lines in ${sample}`)
    expect(await readFile(sample, 'utf8')).toBe('const timeoutMs = 1000;\nother\nconst timeoutMs = 2000;\n')
  })

  it('single hunk matching part of a line is rejected (complete lines only)', async () => {
    const body = 'function f() {\n    if (isEnabled(featureFlagName) && user.isAdmin()) {\n        run();\n    }\n}\n'
    const { result, sample } = await applyEnvelope(body, ['@@', '-isAdmin()', '+isOwner()'])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Failed to find expected lines in ${sample}`)
    expect(await readFile(sample, 'utf8')).toBe(body)
  })

  it('single hunk repeated only after unicode normalization takes the first', async () => {
    const { result, sample } = await applyEnvelope('title – one\nmid\ntitle – one\n', ['@@', '-title - one', '+title - two'])
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('title - two\nmid\ntitle – one\n')
  })

  it('single multi-line hunk repeated only after trimming takes the first', async () => {
    const { result, sample } = await applyEnvelope('  a\n  b\nmid\n  a\n  b\n', ['@@', '-a', '-b', '+c'])
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('  c\nmid\n  a\n  b\n')
  })

  it('single ambiguous fuzzy hunk is rejected when the better candidate comes later', async () => {
    const body = 'const requestTimeoutMilliseconds = 1200;\nother\nconst requestTimeoutMilliseconds = 3001;\n'
    const { result, sample } = await applyEnvelope(body, [
      '@@',
      '-const requestTimeoutMilliseconds = 3000;',
      '+const requestTimeoutMilliseconds = 5000;',
    ])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Failed to find expected lines in ${sample}`)
    expect(await readFile(sample, 'utf8')).toBe(body)
  })

  it('JSON patch mode keeps the uniqueness check for repeated lines', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'a.txt')
    await writeFile(sample, 'x\na\nx\nb\n')
    const result = await call(ctx, owner, {
      path: sample,
      edits: [{ op: 'update', diff: '@@\n-x\n+y\n' }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Found 2 occurrences in ${sample}`)
    expect(await readFile(sample, 'utf8')).toBe('x\na\nx\nb\n')
  })
})

describe('tool-edit (apply_patch mode) complete-line exact matching', () => {
  // Ported from oh-my-pi crates/pi-edit/tests/apply_patch_exact.rs
  // (ceeb647e12, cb927599ef, 57f70e8c34): hunks match complete file lines
  // through Codex normalization (exact, trimEnd, trim, unicode);
  // materially different lines are rejected without writes.
  async function applyEnvelope(content: string | null, hunkLines: string[]) {
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const sample = join(root, 'fixture.txt')
    if (content !== null) await writeFile(sample, content)
    const input = ['*** Begin Patch', `*** Update File: ${sample}`, ...hunkLines, '*** End Patch', ''].join('\n')
    const result = await call(ctx, owner, { input })
    return { result, sample, root }
  }

  it('applies a hunk whose trailing context line is empty (trailing-newline artifact)', async () => {
    // The envelope strips the file's trailing newline element, so a trailing
    // empty context line (' ') can never match verbatim; the seek retries
    // without it — mirroring the JSON path and upstream Codex file_update.rs.
    const { result, sample } = await applyEnvelope('a\nb\n', ['@@', ' a', '+b2', ' '])
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('a\nb2\nb\n')
  })

  it('rejects materially unmatched lines without writes', async () => {
    const cases: [before: string, body: string[], message: string][] = [
      [
        '{\n    "sha": "a",\n    "ref": "b"\n}\n',
        ['@@', '-    sha="a",', '-    ref="b"', '+    sha="c",', '+    ref="d"'],
        'Failed to find expected lines',
      ],
      [
        'void configure(int first, int middle, int last);\n',
        ['@@', '-void configure(int first, int last);', '+void configure(int first, int last, bool enabled);'],
        'Failed to find expected lines',
      ],
      [
        'def configure(\n    first,\n    middle,\n    last,\n):\n    pass\n',
        ['@@', ' def configure(', '     first,', '-    last,', '+    final,', ' ):'],
        'Failed to find expected lines',
      ],
      ['// named states\n', ['@@', '-named states', '+79 named states'], 'Failed to find expected lines'],
      ['69 named states\n', ['@@', '-named states', '+79 named states'], 'Failed to find expected lines'],
      [
        'void configure(int first, int middle);\n    run();\n',
        ['@@ void configure(int first);', '-    run();', '+    stop();'],
        'Failed to find context',
      ],
      ['unrelated header\nold\n', ['@@', ' absent header', '-old', '+new'], 'Failed to find expected lines'],
    ]
    for (const [before, body, message] of cases) {
      const { result, sample } = await applyEnvelope(before, body)
      expect(result.isError, body.join('\n')).toBe(true)
      expect(text(result), body.join('\n')).toContain(message)
      expect(text(result), body.join('\n')).toContain(`in ${sample}`)
      expect(await readFile(sample, 'utf8'), body.join('\n')).toBe(before)
    }
  })

  it('matches only complete lines through Codex normalization passes', async () => {
    const cases: [before: string, body: string[], expected: string][] = [
      ['69 named states\n', ['@@', '-69 named states', '+79 named states'], '79 named states\n'],
      ['old   \n', ['@@', '-old', '+new'], 'new\n'],
      ['    old\n', ['@@', '-old', '+new'], '    new\n'],
      ['', ['@@', '+first'], 'first'],
      ['head', ['@@', '+tail'], 'head\ntail'],
      [
        'message = "hello – world"\n',
        ['@@', '-message = "hello - world"', '+message = "goodbye"'],
        'message = "goodbye"\n',
      ],
      ['old\nold\n', ['@@', '-old', '+first', '@@', '-old', '+second'], 'first\nsecond\n'],
    ]
    for (const [before, body, expected] of cases) {
      const { result, sample } = await applyEnvelope(before, body)
      expect(result.isError, body.join('\n')).toBe(false)
      expect(await readFile(sample, 'utf8'), body.join('\n')).toBe(expected)
    }
  })

  it('wrong context in a later file rejects the envelope (sequential apply writes earlier files)', async () => {
    // Mirror delta: runApplyPatch applies entries sequentially, so first.txt
    // is already written when the fixture.txt hunk fails; upstream rejects
    // the whole envelope atomically before writing anything.
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const fixture = join(root, 'fixture.txt')
    const first = join(root, 'first.txt')
    await writeFile(fixture, 'void configure(int first, int middle, int last);\n')
    await writeFile(first, 'before\n')
    const input = [
      '*** Begin Patch',
      `*** Update File: ${first}`,
      '@@',
      '-before',
      '+after',
      `*** Update File: ${fixture}`,
      '@@',
      '-void configure(int first, int last);',
      '+void configure(int first, int last, bool enabled);',
      '*** End Patch',
    ].join('\n')
    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`Failed to find expected lines in ${fixture}`)
    expect(await readFile(first, 'utf8')).toBe('after\n')
    expect(await readFile(fixture, 'utf8')).toBe('void configure(int first, int middle, int last);\n')
  })

  it('line deletion removes its terminator and preserves other empty lines', async () => {
    for (const ending of ['\n', '\r\n']) {
      for (const finalNewline of [false, true]) {
        for (const [lines, index] of [
          [['first', 'remove', 'last'], 1],
          [['remove', 'middle', 'last'], 0],
          [['first', 'middle', 'remove'], 2],
          [['remove'], 0],
          [['first', '', 'remove', '', 'last'], 2],
        ] as const) {
          const before = lines.join(ending) + (finalNewline ? ending : '')
          const remaining = lines.filter((_, i) => i !== index)
          const expected = remaining.join(ending) + (finalNewline && remaining.length > 0 ? ending : '')
          const { result, sample } = await applyEnvelope(before, ['@@', '-remove'])
          expect(result.isError, before).toBe(false)
          expect(await readFile(sample, 'utf8'), before).toBe(expected)
        }
      }
    }
  })

  it('deleting an import line does not leave an empty row', async () => {
    const { result, sample } = await applyEnvelope('from x import (\n    A,\n    B,\n)\n', ['@@', '-    A,'])
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('from x import (\n    B,\n)\n')

    const second = await applyEnvelope('from x import (\n    B,\n)\n', ['@@', '-    B,', '+    C,'])
    expect(second.result.isError).toBe(false)
    expect(await readFile(second.sample, 'utf8')).toBe('from x import (\n    C,\n)\n')
  })
})

describe('tool-edit (apply_patch mode) machine-readable error kinds (oh-my-pi 3c2b968909)', () => {
  // Mirror surface note: the installed @deepseek-ai/dsh-tools does not
  // project `errorKind` onto result.error (the fork's core/tools surface),
  // so the kinds are asserted on the thrown errors via direct src imports;
  // the tool-level messages are asserted through the registered tool like
  // the other specs. Unlike the fork, the mirror's applyPatch has no real-fs
  // default — direct calls must supply one.
  const realFs = (): FileSystem => ({
    exists: async p => {
      try {
        await stat(p)
        return true
      } catch {
        return false
      }
    },
    read: async p => {
      // Mirror the harness adapter's ENOENT surface ('File not found: <path>')
      // that readExistingPatchFile's broadened catch recognizes.
      try {
        return await readFile(p, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File not found: ${p}`)
        throw error
      }
    },
    write: (p, content) => writeFile(p, content),
    delete: async p => {
      await rm(p)
    },
    mkdir: async p => {
      await mkdir(p, { recursive: true })
    },
  })
  async function applyEnvelope(content: string, hunkLines: string[]) {
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const sample = join(root, 'fixture.txt')
    await writeFile(sample, content)
    const input = ['*** Begin Patch', `*** Update File: ${sample}`, ...hunkLines, '*** End Patch', ''].join('\n')
    const result = await call(ctx, owner, { input })
    return { result, sample, root }
  }

  it('surfaces no_match for unmatched hunk lines', async () => {
    const { result, sample, root } = await applyEnvelope('alpha\nbeta\n', ['@@', '-gamma', '+delta'])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Failed to find expected lines')
    let thrown: unknown
    try {
      await applyCodexPatch(
        ['*** Begin Patch', `*** Update File: ${sample}`, '@@', '-gamma', '+delta', '*** End Patch'].join('\n'),
        { cwd: root, fs: realFs() },
      )
    } catch (error) {
      thrown = error
    }
    expect(errorKindOf(thrown), text(result)).toBe('no_match')
    expect(await readFile(sample, 'utf8')).toBe('alpha\nbeta\n')
  })

  it('surfaces out_of_range for a line hint before line 1', async () => {
    const { result } = await applyEnvelope('alpha\n', ['@@ line 0', '-alpha', '+omega'])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Line hint must be >= 1')
    let thrown: unknown
    try {
      parseApplyPatchHunks('@@ line 0\n-alpha\n+omega')
    } catch (error) {
      thrown = error
    }
    expect(errorKindOf(thrown), text(result)).toBe('out_of_range')
  })

  it('surfaces file_not_found for a missing Update target', async () => {
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const input = [
      '*** Begin Patch',
      `*** Update File: ${join(root, 'absent.txt')}`,
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n')
    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('File not found')
    let thrown: unknown
    try {
      await applyPatch({ path: join(root, 'absent.txt'), op: 'update', diff: '@@\n-x\n+y' }, { cwd: root, fs: realFs() })
    } catch (error) {
      thrown = error
    }
    expect(errorKindOf(thrown), text(result)).toBe('file_not_found')
  })

  it('surfaces no_change for an envelope with no hunks', async () => {
    const { ctx, owner } = await setup({ mode: 'apply_patch' })
    const result = await call(ctx, owner, { input: ['*** Begin Patch', '*** End Patch'].join('\n') })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No files were modified')
    let thrown: unknown
    try {
      await applyCodexPatch('*** Begin Patch\n*** End Patch', { cwd: process.cwd(), fs: realFs() })
    } catch (error) {
      thrown = error
    }
    expect(errorKindOf(thrown), text(result)).toBe('no_change')
  })
})

describe('tool-edit (apply_patch mode) move-only update sections (oh-my-pi 57f70e8c34)', () => {
  const MOVE_ONLY = (fixture: string, moved: string): string =>
    ['*** Begin Patch', `*** Update File: ${fixture}`, `*** Move to: ${moved}`, '*** End Patch'].join('\n')

  it('parses identically in streaming and non-streaming mode', () => {
    const input = MOVE_ONLY('fixture.txt', 'moved.txt')
    expect(parseApplyPatch(input)).toEqual(parseApplyPatchStreaming(input))
  })

  it('preserves source bytes through the move', async () => {
    for (const [before, expected] of [
      ['alpha\n', 'alpha\n'],
      ['alpha', 'alpha'],
      // Mirror delta: the harness text seam strips a leading BOM at decode
      // (fs-local decodeUtf8 uses the TextDecoder default), so the raw read
      // already lacks it; the move still persists the read bytes exactly.
      ['\uFEFFalpha\r\nbeta\r\n', 'alpha\r\nbeta\r\n'],
      ['', ''],
    ] as const) {
      const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
      const sample = join(root, 'fixture.txt')
      const moved = join(root, 'moved.txt')
      await writeFile(sample, before)
      const result = await call(ctx, owner, { input: MOVE_ONLY(sample, moved) })
      expect(result.isError, before).toBe(false)
      await expect(readFile(sample, 'utf8'), before).rejects.toThrow()
      expect(await readFile(moved, 'utf8'), before).toBe(expected)
    }
  })

  it('keeps the missing-source, collision and same-path guards', async () => {
    for (const [source, destination, moved, error] of [
      [null, null, 'moved.txt', 'File not found'],
      ['source\n', 'destination\n', 'moved.txt', 'destination already exists.'],
      ['source\n', null, './fixture.txt', 'same as source'],
    ] as const) {
      const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
      const sample = join(root, 'fixture.txt')
      if (source !== null) await writeFile(sample, source)
      if (destination !== null) await writeFile(join(root, 'moved.txt'), destination)
      const result = await call(ctx, owner, { input: MOVE_ONLY(sample, join(root, moved)) })
      expect(result.isError, moved).toBe(true)
      expect(text(result), moved).toContain(error)
      expect(await readFile(sample, 'utf8').catch(() => null), moved).toBe(source)
      expect(await readFile(join(root, 'moved.txt'), 'utf8').catch(() => null), moved).toBe(destination)
    }
  })

  it('a later invalid hunk still applies the move-only section (sequential mirror delta)', async () => {
    const { ctx, root, owner } = await setup({ mode: 'apply_patch' })
    const sample = join(root, 'fixture.txt')
    const other = join(root, 'other.txt')
    const moved = join(root, 'moved.txt')
    await writeFile(sample, 'alpha\n')
    await writeFile(other, 'other\n')
    const input = [
      '*** Begin Patch',
      `*** Update File: ${sample}`,
      `*** Move to: ${moved}`,
      `*** Update File: ${other}`,
      '@@',
      '-missing',
      '+new',
      '*** End Patch',
    ].join('\n')
    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    expect(await readFile(other, 'utf8')).toBe('other\n')
    // Upstream stages the whole envelope and commits nothing; the sequential
    // apply commits the move before the other.txt hunk fails.
    expect(await readFile(moved, 'utf8')).toBe('alpha\n')
    await expect(readFile(sample, 'utf8')).rejects.toThrow()
  })
})

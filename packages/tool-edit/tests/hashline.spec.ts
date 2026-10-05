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
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { computeFileHash, getSessionSnapshotStore, InMemorySnapshotStore, Patch, type PatchSection } from '@hy-sde-org/dsh-hashline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { computeHashlineSectionDiff } from '../src/hashline/diff.ts'
import { carriedSeenLines } from '../src/hashline/execute.ts'
import { getSnapshotStore } from '../src/hashline/store.ts'
import type { FileReader } from '../src/session.ts'
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

  it('names the origin file when a tag was minted for another file in this session', async () => {
    const { ctx, root, owner } = await setup()
    // Mint a real tag for origin.txt through an edit; the store then holds
    // origin.txt under its post-edit hash.
    const origin = join(root, 'origin.txt')
    const originBefore = 'origin line one\norigin line two\n'
    await writeFile(origin, originBefore)
    const originEdit = await call(ctx, owner, {
      input: `[${origin}#${computeFileHash(originBefore)}]\nPUT 1.=1:\n+origin line one (edited)\n`,
    })
    expect(originEdit.isError).toBe(false)

    const sample = join(root, 'sample.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)
    // Reuse origin.txt's post-edit tag on sample.txt: a tag this session
    // really issued, just for another file — the rejection names it.
    const foreignTag = computeFileHash('origin line one (edited)\norigin line two\n')
    const input = `[${sample}#${foreignTag}]\nPUT 1.=1:\n+replacement\n`

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    const modelText = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(modelText).toContain(`was issued in this session for ${origin}`)
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

describe('tool-edit (hashline mode) × default seen-line enforcement', () => {
  /** Default settings (no explicit enforceSeenLines): regression for omp 760d5dfdee. */
  async function defaultStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-seenlines-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    // No config — the flip under test is the DEFAULT.
    const fiber = await ctx.plugin(ToolEdit)
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  function modelText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  const DRAW_SOURCE = [
    'def draw(sheet, anchor, alpha, beta):',
    '    add_native_hole_callout(sheet=sheet,',
    '        nested=nested(alpha,',
    '            beta),',
    '        point=model_point_in_view(',
    '            anchor),',
    '        callout_xy=(0.230, 0.258))',
    '',
  ].join('\n')

  it('rejects a hunk anchored on a line the read elided (default settings)', async () => {
    const { ctx, root, owner } = await defaultStack()
    const sample = join(root, 'draw.py')
    await writeFile(sample, DRAW_SOURCE)

    // Simulate a ranged read displaying lines 1,2,5,6,7 while eliding 3-4:
    // the same seen-set the harness read tool records for `draw.py:7-7`.
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, DRAW_SOURCE, [1, 2, 5, 6, 7])

    const result = await call(ctx, owner, {
      input: `[${sample}#${tag}]\nPUT 4.=4:\n+            beta, gamma),\n`,
    })
    expect(result.isError).toBe(true)
    expect(modelText(result)).toContain('never displayed')
    expect(await readFile(sample, 'utf8')).toBe(DRAW_SOURCE)
  })

  it('applies a hunk anchored on a line the read displayed (default settings)', async () => {
    const { ctx, root, owner } = await defaultStack()
    const sample = join(root, 'draw.py')
    await writeFile(sample, DRAW_SOURCE)

    // Read displayed lines 1,2,5,6,7; line 7 is seen, so its edit applies.
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, DRAW_SOURCE, [1, 2, 5, 6, 7])

    const result = await call(ctx, owner, {
      input: `[${sample}#${tag}]\nPUT 7.=7:\n+        callout_xy=(0.240, 0.258))\n`,
    })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(DRAW_SOURCE.replace('0.230', '0.240'))
  })
})

describe('tool-edit (hashline) × diff-preview mismatch origin', () => {
  it('names the tag origin path in the preview mismatch error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-preview-'))
    roots.push(root)
    const snapshots = new InMemorySnapshotStore()
    const origin = join(root, 'origin.txt')
    const originTag = snapshots.record(origin, 'origin line\n')
    const sample = join(root, 'sample.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)
    const reader: FileReader = {
      resolve: async target => ({ targetKey: FsTargetKey(target), displayPath: target }),
      stat: async () => undefined,
      readText: async target => readFile(target.displayPath, 'utf8'),
    }

    // The preview shares the apply-time rejection shape: a tag issued for
    // another file names that file instead of dead-ending.
    const patch = Patch.parse(`[${sample}#${originTag}]\nPUT 1.=1:\n+replacement\n`)
    const result = await computeHashlineSectionDiff(patch.sections[0] as PatchSection, root, snapshots, { reader })

    expect('error' in result && result.error).toContain(`was issued in this session for ${origin}`)
    expect(await readFile(sample, 'utf8')).toBe(before)
  })
})

describe('tool-edit (hashline mode) × carried read provenance', () => {
  /**
   * Composition with seen-line enforcement, as the GUI mounts it. The
   * plugins workspace has no dsh-tool-fs and mounts no read policy here —
   * the provenance flows through the same shared session snapshot store the
   * edit self-registers against (mirrors `provenanceStack`).
   */
  async function carriedStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-carried-'))
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

  /** Hashline header `[path#TAG]` tag from a rendered read/edit result. */
  function tagFrom(text: string): string | undefined {
    return /\[[^\]#]+#([0-9A-F]{4})\]/.exec(text)?.[1]
  }

  /** 40-line file whose line 35 the read displayed. */
  function fortyLines(): { lines: string[]; source: string } {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`)
    return { lines, source: `${lines.join('\n')}\n` }
  }

  it('keeps a displayed line anchorable across a line-neutral hunk elsewhere in the file', async () => {
    const { ctx, root, owner } = await carriedStack()
    const sample = join(root, 'neutral.txt')
    const { lines, source } = fortyLines()
    await writeFile(sample, source)
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, source, lines.map((_, i) => i + 1))

    // Insert above line 35 and cut below it — net-zero, so line 35 keeps
    // its number and content. The rendered result only previews the touched
    // hunks, so without carried provenance line 35 would go unseen on the
    // post-edit tag and the follow-up edit would bounce.
    const first = await call(ctx, owner, {
      input: `[${sample}#${tag}]\nPUT <10:\n+inserted line\nCUT 30\n`,
    })
    expect(first.isError).toBe(false)
    const edited = [...lines.slice(0, 9), 'inserted line', ...lines.slice(9, 29), ...lines.slice(30)]
    const editedTag = tagFrom(modelText(first))
    expect(editedTag).toBe(computeFileHash(`${edited.join('\n')}\n`))

    const followup = await call(ctx, owner, {
      input: `[${sample}#${editedTag}]\nPUT 35.=35:\n+line35 (edited)\n`,
    })
    expect(followup.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(
      `${[...edited.slice(0, 34), 'line35 (edited)', ...edited.slice(35)].join('\n')}\n`,
    )
  })

  it('does not carry a line the edit shifted — its old number names other content', async () => {
    const { ctx, root, owner } = await carriedStack()
    const sample = join(root, 'shifted.txt')
    const { lines, source } = fortyLines()
    await writeFile(sample, source)
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, source, lines.map((_, i) => i + 1))

    const first = await call(ctx, owner, {
      input: `[${sample}#${tag}]\nPUT <10:\n+inserted line\nCUT 30\n`,
    })
    expect(first.isError).toBe(false)
    const edited = [...lines.slice(0, 9), 'inserted line', ...lines.slice(9, 29), ...lines.slice(30)]
    const editedTag = tagFrom(modelText(first))

    // Old line 16 now sits at 17; number 16 names line15. Carried
    // provenance covers only unshifted lines, so the stale anchor rejects.
    const stale = await call(ctx, owner, {
      input: `[${sample}#${editedTag}]\nPUT 16.=16:\n+line16 (edited)\n`,
    })
    expect(stale.isError).toBe(true)
    expect(await readFile(sample, 'utf8')).toBe(`${edited.join('\n')}\n`)
  })

  // NOTE (mirror): the fork's "registers carried lines even when the write
  // drifts from the previewed text" test is not ported. It produces the
  // drift with an injectable fake `lsp` service whose formatter output the
  // fork's EditFilesystem persists (writeText returns the formatted text).
  // The standalone plugin's EditFilesystem deliberately keeps the authored
  // view (`return { text: content }`), so `result.written` can never differ
  // from `result.after` in the hashline path and the drift branch is
  // unreachable through the public edit tool. Porting the test would require
  // changing the plugin's write-path semantics, which is outside this
  // harvest; `carriedSeenLines` itself stays covered by the pure-function
  // test below, and the no-drift registration by the two integration tests
  // above.
  it('carries only unshifted runs; a missing prior lets every unshifted line carry', async () => {
    const before = 'a\nb\nc\nd\ne\n'
    // Net-zero hunk at the top: c/d/e keep number and content; the leading
    // run carries too; the changed line does not.
    const after = 'A\nb\nc\nd\ne\n'
    expect(carriedSeenLines(before, after, new Set([1, 2, 5]))).toEqual([2, 5])
    // No prior snapshot (or an unrestricted one): every unshifted line
    // carries, since the edit could anchor anywhere. The rewrite models as
    // remove+add, so the equal run starts at 2; the trailing split artifact
    // rides along, exactly as upstream's split does.
    expect(carriedSeenLines(before, after, undefined)).toEqual([2, 3, 4, 5, 6])
    // Pure shift: nothing keeps its number, nothing carries.
    expect(carriedSeenLines('x\na\nb\nc\nd\ne\n', before, new Set([1, 2, 3, 4, 5]))).toEqual([])
  })
})

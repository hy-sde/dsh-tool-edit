import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { _internals, type EditLspDiagnostic } from '../src/lsp/client.ts'
import { createEditLspProvider, type EditLspProvider } from '../src/lsp/provider.ts'
import { createWritethrough } from '../src/lsp/writethrough.ts'
import { resolveConfig } from '../src/index.ts'

const { pathToUri, languageIdFromPath, applyEdits } = _internals

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp-server.mjs')

describe('lsp client internals', () => {
  it('maps a path to a file:// URI', () => {
    expect(pathToUri('/workspace/src/a b.ts')).toBe('file:///workspace/src/a%20b.ts')
    expect(pathToUri('src/a.ts')).toBe('file:///src/a.ts')
  })

  it('infers language ids from extensions', () => {
    expect(languageIdFromPath('a.ts')).toBe('typescript')
    expect(languageIdFromPath('a.tsx')).toBe('typescriptreact')
    expect(languageIdFromPath('a.js')).toBe('javascript')
    expect(languageIdFromPath('a.json')).toBe('json')
    expect(languageIdFromPath('unknown.xyz')).toBe('typescript')
  })

  it('applies LSP edits tail-first so positions stay valid', () => {
    const edits = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'Hello' },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'x' },
    ]
    expect(applyEdits('abcde\nQ\n', edits)).toBe('Hello\nx\n')
  })
})

describe('embedded LSP provider over a real child process', () => {
  it('formats then collects diagnostics, and disposes cleanly', async () => {
    const provider: EditLspProvider = createEditLspProvider({
      command: `node ${FAKE_SERVER}`,
      cwd: dirname(FAKE_SERVER),
    })

    // format: the fake server appends a marker line
    const formatted = await provider.format!({
      filePath: '/workspace/a.ts',
      workspaceRoot: '/workspace',
      text: 'const x = 1',
    })
    expect(formatted).not.toBeUndefined()
    expect(formatted!.formattedText).toContain('// formatted')

    // collect diagnostics: the fake server publishes one diagnostic after change
    const collected = await provider.collectDiagnostics!({
      filePath: '/workspace/a.ts',
      workspaceRoot: '/workspace',
      text: 'const x = 2',
      version: 1,
    })
    expect(collected).not.toBeUndefined()
    const diags = collected!.diagnostics as readonly EditLspDiagnostic[]
    expect(diags.length).toBeGreaterThan(0)
    expect(diags[0]!.source).toBe('fake')
    expect(diags[0]!.message).toContain('fake diagnostic')

    await provider.dispose!()
  })

  it('degrades to undefined when the server command cannot spawn', async () => {
    const provider: EditLspProvider = createEditLspProvider({
      command: 'definitely-not-a-real-binary-xyz --stdio',
    })
    const formatted = await provider.format!({
      filePath: '/workspace/a.ts',
      workspaceRoot: '/workspace',
      text: 'const x = 1',
    })
    expect(formatted).toBeUndefined()
    const collected = await provider.collectDiagnostics!({
      filePath: '/workspace/a.ts',
      workspaceRoot: '/workspace',
      text: 'const x = 2',
      version: 1,
    })
    expect(collected).toBeUndefined()
    await provider.dispose!()
  })
})

describe('writethrough with a stub provider', () => {
  it('formats content on write and never throws on provider failure', async () => {
    const failing: EditLspProvider = {
      async format() { throw new Error('boom') },
      async collectDiagnostics() { throw new Error('boom') },
      async dispose() {},
    }
    const writethrough = createWritethrough({
      provider: failing,
      config: resolveConfig({ formatOnWrite: true, diagnosticsOnEdit: true },
      ),
    })
    const result = await writethrough('/a.ts', 'const x = 1')
    expect(result).toBeUndefined()
  })

  it('applies the provider-formatted text and attaches diagnostics', async () => {
    const provider: EditLspProvider = {
      async format(args) {
        return { formattedText: `${args.text}\n// formatted` }
      },
      async collectDiagnostics() {
        return {
          diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            severity: 2,
            source: 'stub',
            message: 'warning here',
          }],
        }
      },
      async dispose() {},
    }
    const writethrough = createWritethrough({
      provider,
      config: resolveConfig({ formatOnWrite: true, diagnosticsOnEdit: true }),
    })
    const result = await writethrough('/a.ts', 'const x = 1')
    expect(result).not.toBeUndefined()
    expect(result!.summary).toContain('1 warning')
    expect(applyEdits('const x = 1', [])).toBe('const x = 1') // sanity on exports
  })
})

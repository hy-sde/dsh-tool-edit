import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEditLspProvider, DEFAULT_LSP_COMMAND } from '../src/lsp/provider.ts'
import { splitCommand } from '../src/lsp/stdio.ts'
import {
  NATIVE_ARGS,
  findWorkspaceTypeScript,
  resolveTscOnPath,
  selectTypeScriptServer,
  typescriptPackageDir,
  typescriptSpeaksLsp,
} from '../src/lsp/typescript.ts'

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp-server.mjs')

/** A TypeScript install fixture: package.json + bin/tsc, optional lib/tsserver.js. */
async function writeTypeScriptPackage(packageDir: string, opts: { tsserver: boolean }): Promise<void> {
  await mkdir(join(packageDir, 'bin'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), '{"name":"typescript","version":"7.0.0"}\n')
  await writeFile(join(packageDir, 'bin', 'tsc'), '')
  if (opts.tsserver) {
    await mkdir(join(packageDir, 'lib'), { recursive: true })
    await writeFile(join(packageDir, 'lib', 'tsserver.js'), '')
  }
}

/** Spawn inputs standing in for the default `npx typescript-language-server` wrapper. */
const WRAPPER = { command: DEFAULT_LSP_COMMAND, args: splitCommand(DEFAULT_LSP_COMMAND) }
/** The switch standing in for `typescriptNative: { command: 'tsc' }`. */
const NATIVE = { command: 'tsc' }

describe('TypeScript server selection helpers', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'tool-edit-ts7-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds a workspace-local TypeScript install by walking up', async () => {
    await writeTypeScriptPackage(join(root, 'node_modules', 'typescript'), { tsserver: false })
    const nested = join(root, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    expect(findWorkspaceTypeScript(nested)).toBe(join(root, 'node_modules', 'typescript'))
  })

  it('returns null when no workspace TypeScript install exists', async () => {
    expect(findWorkspaceTypeScript(root)).toBeNull()
  })

  describe('typescriptPackageDir / typescriptSpeaksLsp', () => {
    it('detects a classic install behind a symlinked node_modules/.bin/tsc', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: true })
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await symlink(join('..', 'typescript', 'bin', 'tsc'), join(root, 'node_modules', '.bin', 'tsc'))
      const launcher = join(root, 'node_modules', '.bin', 'tsc')
      expect(typescriptPackageDir(launcher)).toBe(packageDir)
      expect(typescriptSpeaksLsp(launcher)).toBe(false)
    })

    it('detects a TypeScript 7 package behind a symlinked launcher', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await symlink(join('..', 'typescript', 'bin', 'tsc'), join(root, 'node_modules', '.bin', 'tsc'))
      expect(typescriptSpeaksLsp(join(root, 'node_modules', '.bin', 'tsc'))).toBe(true)
    })

    it('detects a global npm layout (<prefix>/lib/node_modules/typescript/bin/tsc)', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      const launcher = join(packageDir, 'bin', 'tsc')
      expect(typescriptPackageDir(launcher)).toBe(packageDir)
      expect(typescriptSpeaksLsp(launcher)).toBe(true)
    })

    it('returns null for an unrecognizable launcher layout', async () => {
      const launcher = join(root, 'scratch', 'tsc')
      await mkdir(dirname(launcher), { recursive: true })
      await writeFile(launcher, '')
      expect(typescriptPackageDir(launcher)).toBeNull()
      expect(typescriptSpeaksLsp(launcher)).toBe(false)
    })
  })

  describe('resolveTscOnPath', () => {
    it('finds a plain tsc launcher on PATH', async () => {
      const binDir = join(root, 'bin')
      await mkdir(binDir, { recursive: true })
      await writeFile(join(binDir, 'tsc'), '')
      expect(resolveTscOnPath('tsc', { PATH: binDir }, 'darwin')).toBe(join(binDir, 'tsc'))
    })

    it('finds a tsc.cmd shim on Windows layouts', async () => {
      const binDir = join(root, 'npm')
      await mkdir(binDir, { recursive: true })
      await writeFile(join(binDir, 'tsc.cmd'), '')
      expect(resolveTscOnPath('tsc', { PATH: binDir }, 'win32')).toBe(join(binDir, 'tsc.cmd'))
    })

    it('returns null when PATH has no tsc', async () => {
      expect(resolveTscOnPath('tsc', { PATH: join(root, 'empty') }, 'darwin')).toBeNull()
    })

    it('returns an absolute launcher path only when it exists', async () => {
      const launcher = join(root, 'abs', 'tsc')
      await mkdir(dirname(launcher), { recursive: true })
      await writeFile(launcher, '')
      expect(resolveTscOnPath(launcher, {}, 'darwin')).toBe(launcher)
      expect(resolveTscOnPath(join(root, 'missing-tsc'), {}, 'darwin')).toBeNull()
    })
  })

  describe('selectTypeScriptServer', () => {
    it('keeps the configured wrapper for a classic workspace install', async () => {
      await writeTypeScriptPackage(join(root, 'node_modules', 'typescript'), { tsserver: true })
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('spawns the workspace tsc --lsp for a TypeScript 7 workspace install', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await writeFile(join(root, 'node_modules', '.bin', 'tsc'), '')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: join(root, 'node_modules', '.bin', 'tsc'),
        args: [...NATIVE_ARGS],
      })
    })

    it('keeps the wrapper when no workspace install exists and nothing resolves on PATH', async () => {
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('uses the resolved native launcher for a TypeScript 7 install found on PATH', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      const launcher = join(packageDir, 'bin', 'tsc')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, launcher)).toEqual({
        command: launcher,
        args: [...NATIVE_ARGS],
      })
    })

    it('keeps the wrapper when the resolved launcher belongs to a classic install', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: true })
      const launcher = join(packageDir, 'bin', 'tsc')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, launcher)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('prefers a classic local install over a TypeScript 7 launcher on PATH', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: true })
      const pathTsc = join(root, 'lib', 'node_modules', 'typescript', 'bin', 'tsc')
      await writeTypeScriptPackage(join(root, 'lib', 'node_modules', 'typescript'), { tsserver: false })
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, pathTsc)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('falls back to the wrapper when a TypeScript 7 package has no spawnable launcher', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), '{"name":"typescript"}\n')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('detects a TypeScript 7 install on PATH through the realpath npm layout', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      const binDir = join(root, 'bin')
      await mkdir(binDir, { recursive: true })
      await symlink(join('..', 'lib', 'node_modules', 'typescript', 'bin', 'tsc'), join(binDir, 'tsc'))
      const resolved = resolveTscOnPath('tsc', { PATH: binDir }, 'darwin')
      expect(resolved).toBe(join(binDir, 'tsc'))
      expect(typescriptSpeaksLsp(resolved!)).toBe(true)
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, resolved)).toEqual({
        command: join(binDir, 'tsc'),
        args: [...NATIVE_ARGS],
      })
    })

    it('passes the configured command through unchanged when the switch is unset', async () => {
      await writeTypeScriptPackage(join(root, 'node_modules', 'typescript'), { tsserver: false })
      expect(selectTypeScriptServer(WRAPPER, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Provider-level wiring: selection must reach the spawned server for a
// TypeScript 7 workspace while classic/undetectable workspaces keep the
// configured wrapper (no real server spawns — the fake LSP script is reused).
// ---------------------------------------------------------------------------

describe('createEditLspProvider TypeScript 7 selection', () => {
  let root: string
  let ws: string
  let fakeServerSource: string

  const skipOnWindows = (): boolean => process.platform === 'win32'

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'tool-edit-ts7-prov-')))
    ws = join(root, 'ws')
    await mkdir(ws)
    await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
    fakeServerSource = await readFile(FAKE_SERVER, 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /**
   * An executable native `tsc` launcher: refuses to run unless invoked as
   * `tsc --lsp --stdio` (proving the native path won), then serves LSP the
   * same way as the fake server fixture.
   */
  async function writeNativeTscLauncher(tscPath: string): Promise<void> {
    await mkdir(dirname(tscPath), { recursive: true })
    const body = [
      '#!/usr/bin/env node',
      "if (!process.argv.includes('--lsp') || !process.argv.includes('--stdio')) {",
      "  console.error('tsc spawned without --lsp --stdio: ' + process.argv.join(' '))",
      '  process.exit(2)',
      '}',
      fakeServerSource,
    ].join('\n')
    await writeFile(tscPath, body)
    await chmod(tscPath, 0o755)
  }

  /** A wrapper launcher that crashes on boot — proves it was never selected. */
  async function writeCrashWrapper(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '#!/usr/bin/env node\nprocess.exit(1)\n')
    await chmod(path, 0o755)
    return path
  }

  it('spawns the workspace tsc --lsp --stdio for a TypeScript 7 workspace', async () => {
    if (skipOnWindows()) return
    const wrapper = await writeCrashWrapper(join(root, 'crash-wrapper.js'))
    await writeTypeScriptPackage(join(ws, 'node_modules', 'typescript'), { tsserver: false })
    await writeNativeTscLauncher(join(ws, 'node_modules', '.bin', 'tsc'))
    const provider = createEditLspProvider({
      command: `node ${wrapper}`,
      typescriptNative: { command: join(root, 'no-such-tsc') },
    })
    const formatted = await provider.format({
      filePath: join(ws, 'a.ts'),
      workspaceRoot: ws,
      text: 'const x = 1',
    })
    expect(formatted?.formattedText).toContain('// formatted')
    await provider.dispose()
  })

  it('keeps the configured wrapper for a classic workspace install', async () => {
    if (skipOnWindows()) return
    await writeTypeScriptPackage(join(ws, 'node_modules', 'typescript'), { tsserver: true })
    // A resolvable native launcher that would crash if ever selected.
    const crashTsc = await writeCrashWrapper(join(root, 'crash-tsc'))
    const provider = createEditLspProvider({
      command: `node ${FAKE_SERVER}`,
      typescriptNative: { command: crashTsc },
    })
    const formatted = await provider.format({
      filePath: join(ws, 'a.ts'),
      workspaceRoot: ws,
      text: 'const x = 1',
    })
    expect(formatted?.formattedText).toContain('// formatted')
    await provider.dispose()
  })

  it('keeps the configured wrapper when no install exists and the native command is unresolvable', async () => {
    if (skipOnWindows()) return
    const provider = createEditLspProvider({
      command: `node ${FAKE_SERVER}`,
      typescriptNative: { command: join(root, 'no-such-tsc') },
    })
    const formatted = await provider.format({
      filePath: join(ws, 'a.ts'),
      workspaceRoot: ws,
      text: 'const x = 1',
    })
    expect(formatted?.formattedText).toContain('// formatted')
    await provider.dispose()
  })

  it('rejects an empty native command at creation', () => {
    expect(() => createEditLspProvider({
      command: `node ${FAKE_SERVER}`,
      typescriptNative: { command: '' },
    })).toThrow(/typescriptNative\.command must be non-empty/)
  })
})

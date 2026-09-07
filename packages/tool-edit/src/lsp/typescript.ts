/**
 * TypeScript install inspection behind the opt-in `typescriptNative` switch:
 * TypeScript 7 dropped the JS `lib/tsserver.js` that `typescript-language-server`
 * wraps and speaks LSP natively via `tsc --lsp --stdio`, so a workspace needs a
 * different server than the configured wrapper (older `tsc` rejects `--lsp`
 * with TS5023). This module detects which install a workspace uses and selects
 * one spawn command for it. Pure `node:fs` helpers only — the tests exercise
 * selection without spawning; the PATH lookup stays local to this package, and
 * the provider passes the resolved native launcher in to
 * {@link selectTypeScriptServer}.
 *
 * Ported from the oh-my-pi native-LSP work (upstream commit 530664c8f5,
 * `packages/coding-agent/src/lsp/config.ts`) following the shape of
 * `@deepseek-ai/dsh-lsp-stdio`'s `typescript.ts`.
 * @module @hy-sde-org/dsh-tool-edit/lsp
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** The native `tsc --lsp --stdio` invocation; older `tsc` rejects `--lsp`. */
export const NATIVE_ARGS = ['--lsp', '--stdio'] as const

/** Opt-in per-server switch: the configured server is a TypeScript wrapper. */
export interface TypeScriptNativeConfig {
  /**
   * Native `tsc` launcher — a bare PATH name or an absolute path; resolved on
   * PATH at provider creation. Defaults to `'tsc'` (also covers `tsgo`-style
   * launchers when the binary name differs).
   */
  command?: string
}

/** Spawn inputs of one configured TypeScript server before per-workspace selection. */
export interface TypeScriptServerInput {
  /** The wrapper executable (e.g. `npx`). */
  readonly command: string
  /** Wrapper arguments, kept verbatim when the wrapper wins. */
  readonly args: readonly string[]
  /** The opt-in switch; when absent, selection is a no-op. */
  readonly typescriptNative?: TypeScriptNativeConfig
}

/** The selected spawn command and arguments for one workspace. */
export interface TypeScriptServerSelection {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Directory of the npm package that owns a resolved `tsc`/`tsgo` launcher, or
 * null when the layout is not a recognizable npm install.
 * @param tscPath - path to a `tsc` launcher (symlink or real file).
 * @returns the owning package directory (e.g. `<root>/node_modules/typescript`), or null.
 */
export function typescriptPackageDir(tscPath: string): string | null {
  let realPath = tscPath
  try {
    realPath = fs.realpathSync(tscPath)
  } catch {
    // The launcher may not exist yet (test fixtures, a PATH entry that
    // vanished); the layout heuristics below still run on the given path and
    // every candidate is existence-checked, so a bad realpath cannot
    // misclassify.
  }
  const binDir = path.dirname(tscPath)
  const candidates = [
    // <pkg>/bin/tsc: symlinked node_modules/.bin and global installs
    ...(path.basename(path.dirname(realPath)) === 'bin' ? [path.dirname(path.dirname(realPath))] : []),
    // node_modules/.bin/tsc.cmd on Windows
    path.join(binDir, '..', 'typescript'),
    // npm global prefix on Windows
    path.join(binDir, 'node_modules', 'typescript'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

/** Whether the TypeScript package at `packageDir` speaks LSP natively (v7+). */
function packageSpeaksLsp(packageDir: string): boolean {
  return !fs.existsSync(path.join(packageDir, 'lib', 'tsserver.js'))
}

/**
 * Whether the `tsc` at `tscPath` belongs to a TypeScript install that speaks
 * LSP itself. TypeScript 7 dropped the JS `lib/tsserver.js` that
 * typescript-language-server wraps and exposes `tsc --lsp --stdio` from its
 * native binary instead; older releases reject the flag with TS5023.
 * @param tscPath - path to a resolved `tsc` launcher.
 * @returns true when the owning install is a TypeScript 7+ native build.
 */
export function typescriptSpeaksLsp(tscPath: string): boolean {
  const packageDir = typescriptPackageDir(tscPath)
  return packageDir !== null && packageSpeaksLsp(packageDir)
}

/**
 * Directory of the TypeScript package installed for a workspace, or null when
 * no ancestor of `workspaceRoot` carries one. Walks up from the workspace root
 * so monorepo workspaces use the install at the repository root.
 * @param workspaceRoot - canonical workspace path.
 * @returns the resolved `node_modules/typescript` directory, or null.
 */
export function findWorkspaceTypeScript(workspaceRoot: string): string | null {
  let dir = path.resolve(workspaceRoot)
  for (;;) {
    const packageDir = path.join(dir, 'node_modules', 'typescript')
    if (fs.existsSync(path.join(packageDir, 'package.json'))) return packageDir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The spawnable workspace `tsc` launcher for a detected package, or null. */
function workspaceTscLauncher(packageDir: string): string | null {
  // node_modules/.bin/tsc is the standard npm/pnpm/yarn launcher; the
  // package's own bin/tsc covers non-launcher layouts such as global installs.
  const binDir = path.join(path.dirname(packageDir), '.bin')
  const binLauncher = path.join(binDir, 'tsc')
  if (fs.existsSync(binLauncher)) return binLauncher
  if (process.platform === 'win32') {
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const candidate = `${binLauncher}${extension}`
      if (fs.existsSync(candidate)) return candidate
    }
  }
  const packageBin = path.join(packageDir, 'bin', 'tsc')
  if (fs.existsSync(packageBin)) return packageBin
  return null
}

/**
 * Resolve a `tsc`-style launcher on PATH (POSIX plain names; win32 also tries
 * the `.exe`/`.cmd`/`.bat` extensions). An absolute `name` is checked
 * directly, mirroring how the subprocess seam resolves configured commands.
 * @param name - launcher name, e.g. `'tsc'`, or an absolute path.
 * @param env - environment to read `PATH` from (defaults to `process.env`).
 * @param platform - platform the PATH layout belongs to (defaults to `process.platform`).
 * @returns the first existing launcher path, or null when unresolvable.
 */
export function resolveTscOnPath(
  name = 'tsc',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null
  const pathVar = env.PATH ?? env.Path ?? ''
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dirRaw of pathVar.split(path.delimiter)) {
    const dir = dirRaw.trim()
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Select the spawn command/args for one workspace's TypeScript server. Keeps
 * exactly one server per workspace: a TypeScript 7+ install (no
 * `lib/tsserver.js`) gets the native `tsc --lsp --stdio` (spawning the
 * workspace's own launcher when the install is local, else the resolved
 * native launcher), and every other case keeps the configured wrapper. With
 * the switch unset, the configured command/args pass through unchanged.
 * @param config - the configured server's spawn inputs and the opt-in switch.
 * @param workspaceRoot - canonical workspace path selection runs for.
 * @param resolvedTsc - native launcher resolved on PATH at provider creation,
 * or null when not found; used only when no workspace-local install decides.
 * @returns the command and args to spawn for this workspace.
 */
export function selectTypeScriptServer(
  config: TypeScriptServerInput,
  workspaceRoot: string,
  resolvedTsc: string | null = null,
): TypeScriptServerSelection {
  if (config.typescriptNative === undefined) {
    return { command: config.command, args: [...config.args] }
  }
  const workspacePackage = findWorkspaceTypeScript(workspaceRoot)
  if (workspacePackage !== null) {
    if (packageSpeaksLsp(workspacePackage)) {
      const launcher = workspaceTscLauncher(workspacePackage)
      if (launcher !== null) return { command: launcher, args: [...NATIVE_ARGS] }
    } else {
      // A classic workspace install wins over any PATH launcher: the wrapper
      // can drive it and the host `tsc` may be a different version.
      return { command: config.command, args: [...config.args] }
    }
  }
  if (resolvedTsc !== null && typescriptSpeaksLsp(resolvedTsc)) {
    return { command: resolvedTsc, args: [...NATIVE_ARGS] }
  }
  return { command: config.command, args: [...config.args] }
}

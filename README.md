# dsh-tool-edit — the rich `edit` tool for DeepSeek Harness

Two standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde/dsh-hashline` | pure line-anchored edit-patch engine (library) | no — transitive |
| `@hy-sde/dsh-tool-edit` | the plugin: `edit` tool (replace / patch / apply_patch / hashline) + embedded format-on-write & diagnostics | yes |

The `edit` tool is a full parity port of oh-my-pi's coding-agent edit tool
onto the harness tool/filesystem contract (`ctx.tools`, `ctx.fs`,
`ctx.systemPrompt`). It reads through the filesystem before every edit,
writes through the `fs/edit-intent` waterfall and records `fs/observed`, so
the harness observation policy (when mounted) can enforce read-before-edit —
and it bundles its **own LSP client**, so `formatOnWrite` and
`diagnosticsOnEdit` work on stock DeepSeek Harness deployments with **zero
upstream changes** (the language server runs via `npx
typescript-language-server` and degrades to edit-only when unavailable).

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

The packages are released as npm tarballs. **Once published**, install the
plugin and its library resolves automatically:

```bash
dsh plugin --profile web add @hy-sde/dsh-tool-edit
```

**Before publishing**, install from the built tarballs — and pin the
unpublished dependency so `pnpm add` doesn't query the registry for
`@hy-sde/dsh-hashline`:

```bash
git clone git@github.com:hy-sde/dsh-tool-edit.git
cd dsh-tool-edit
pnpm install
pnpm run build

HASHLINE_TGZ="$(cd packages/hashline && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$HASHLINE_TGZ"

# Pin hashline locally so the tool-edit tarball's dependency resolves offline.
printf 'overrides:\n  "@hy-sde/dsh-hashline": "file:%s/packages/hashline"\n' "$PWD" >> "$DSH_HOME/profiles/web/pnpm-workspace.yaml"

TOOLEDIT_TGZ="$(cd packages/tool-edit && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$TOOLEDIT_TGZ"
```

(The `overrides` entry is a pre-publication shim; delete it after the first
real publish.)

> **Install order note:** don't try to satisfy the dependency by installing the
> hashline tarball "first" — pnpm re-resolves the full graph on every `add`
> and will 404 on an unpublished `@hy-sde/dsh-hashline` unless the override
> above pins it.

### Verify

```bash
dsh web --dump-config   # look for the hy-sde-edit-fs group rows
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde/dsh-tool-edit
dsh plugin --profile web remove @hy-sde/dsh-hashline
```

> **Already shipped?** If a future DeepSeek Harness release adopts a rich
> edit tool itself, skip installation — adding this bundle on top would
> duplicate the loader row and fail at boot ("duplicate loader entry id").

> **Prompt-section collisions on raw profiles:** the shipped `web` profile
> (the GUI) disables the base host-plane tool rows, so the plugin's
> `read`/`write`/`edit` register cleanly there. On a raw `dsh-base` profile
> (e.g. some headless setups) the host still mounts its own `tool-fs`, whose
> `tool:read`/`tool:edit` system-prompt sections collide with the plugin's —
> boot fails with "prompt section … is already registered". Apply the same
> disables a web deployment has (a user patch disabling the base tool rows),
> or mount the plugin rows inside a preset realm.

## What the bundle does

The plugin's `cordis.patch.yml` is **self-contained**: `ctx.fs` is not
mounted host-wide in Harness (presets own local filesystem discovery), so the
bundle brings its own isolated fs realm with fresh row ids (`hy-sde-*`) that
cannot collide with shipped rows:

- `hy-sde-edit-fs` — a `cordis:group` isolated on `fs`
  - `hy-sde-fs-local` — `@deepseek-ai/dsh-fs-local` (cwd: `DSH_CWD` or the
    harness process cwd; override by patching this row with your workspace)
  - `hy-sde-tool-fs` — `@deepseek-ai/dsh-tool-fs` with `enableEdit: false`
  - `hy-sde-tool-edit` — `@hy-sde/dsh-tool-edit` (the rich editor)

Configure per deployment by patching the rows by id, e.g.:

```yaml
- id: hy-sde-fs-local
  config:
    cwd: /path/to/workspace
- id: hy-sde-tool-edit
  config:
    mode: hashline      # 'auto' | 'hashline' | 'replace' | 'patch' | 'apply_patch'
    formatOnWrite: true
    diagnosticsOnEdit: true
    lspCommand: npx --yes typescript-language-server --stdio
```

## Tool modes

The single `edit` tool dispatches on argument shape (or is pinned to one mode
via `config.mode`):

| mode | argument shape | notes |
|---|---|---|
| `replace` | `path` + `old_string` + `new_string` (`replace_all`) | fuzzy whitespace matching by default |
| `patch` | `path` + `edits[]` | JSON edit entries |
| `apply_patch` | `input` | Codex/Aider-style patch envelope |
| `hashline` | `input` | line-anchored patch language: tags the model saw (`@file`) + `@@` blocks referencing line numbers and hashes |

## LSP behavior on stock DSH

- The embedded client spawns `typescript-language-server` on first edit that
  writes through LSP; the server process is shared for the plugin lifetime
  and torn down on unmount.
- With `formatOnWrite`, edited files are formatted via
  `textDocument/formatting` before the write lands.
- With `diagnosticsOnEdit`, `textDocument/publishDiagnostics` are attached to
  the edit result as an `N error(s), M warning(s)` summary with `line:col
  [severity] [source] message` lines.
- Any failure (no server, spawn error, timeout) degrades to edit-only
  silently. Never blocks an edit.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # hashline 235 tests + tool-edit 20 tests (incl. embedded LSP client)
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish hashline then tool-edit
```

## Layout

```
packages/hashline/    @hy-sde/dsh-hashline — the engine (no runtime deps)
packages/tool-edit/   @hy-sde/dsh-tool-edit — the plugin (embedds the LSP client)
  cordis.patch.yml    the installable harness bundle
  src/lsp/            embedded client: stdio framing, LSP client, provider,
                      writethrough (port of oh-my-pi's lsp writethrough)
```

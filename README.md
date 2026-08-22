# dsh-tool-edit — the rich `edit` tool for DeepSeek Harness

Two standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-hashline` | pure line-anchored edit-patch engine (library) | no — transitive |
| `@hy-sde-org/dsh-tool-edit` | the plugin: `edit` tool (replace / patch / apply_patch / hashline) + embedded format-on-write & diagnostics | yes |

The `edit` tool is a full parity port of oh-my-pi's coding-agent edit tool
onto the harness tool/filesystem contract (`ctx.tools`, `ctx.fs`,
`ctx.systemPrompt`). It reads through the filesystem before every edit,
writes through the `fs/edit-intent` waterfall and records `fs/observed`, so
the harness observation policy (when mounted) can enforce read-before-edit —
and it bundles its **own LSP client**, so `formatOnWrite` and
`diagnosticsOnEdit` work on stock DeepSeek Harness deployments with **zero
upstream changes** (the language server runs via `npx
typescript-language-server` and degrades to edit-only when unavailable).

**Why this exists.** For coding agents, much of the leverage is in the
harness, not the model — the "harness problem" [Stencil So][stencil] frames
well: the tool surface (how a model reads, edits, and is shown errors) often
bounds reliability more than the model does. This plugin is harness work: a
better edit tool with a built-in language server, shipped as an installable
plugin. The [benchmark section][benchmark] records the A/B run that measures
it against the harness's built-in `str_replace_editor`, so the "it's better"
claim is evidenced, not asserted.

[stencil]: https://stencil.so/blog/the-harness-problem
[benchmark]: benchmark/README.md

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

Both packages are published on the npm registry under the `hy-sde-org`
organization (`@hy-sde-org/dsh-hashline` and `@hy-sde-org/dsh-tool-edit`,
version `0.1.1-rc.2`). Install the plugin straight from npm — the registry
resolves the hashline library dependency and the DeepSeek Harness peer
packages automatically, no tarballs, no ordering:

```bash
# one command; @hy-sde-org/dsh-hashline comes in as a transitive dependency
dsh plugin --profile web add @hy-sde-org/dsh-tool-edit
```

On **official harness releases (rc.8 and later)** the bundle's patch seams are
deliberately minimal (see [Replacing the built-in editor](#replacing-the-built-in-editor)):
`dsh plugin add` reconciles the profile, disables the shipped
`str_replace_editor` tool, and the rich editor is then mounted by adding the
provided [agent preset](#replacing-the-built-in-editor) row. Installing the
bundle alone never breaks boot and never claims the `edit` name on the host
plane.

You can also just depend on the packages from your own tooling as normal npm
dependencies:

```bash
npm install @hy-sde-org/dsh-tool-edit   # or pnpm add / yarn add
npm install @hy-sde-org/dsh-hashline    # the engine, if you need it directly
```

> **Registry notes.** `latest` is `0.1.1-rc.2` after the next publish. The
> `0.1.1-rc.2` bundle (like `0.1.0-rc.7` before it) uses the minimal-patch
> posture that boots on official harness releases; the earlier `0.1.0-rc.6` and
> `0.1.0-rc.5` of `dsh-tool-edit` were published before the rc.7 bundle posture
> (they mounted a self-contained fs realm that requires the
> `enableEdit` harness feature and fails boot on stock rc.7/rc.8) — do not
> install them on an official harness.

### From the git checkout (pre-publish / development)

Before the registry publish (or when hacking on the repo itself), install
from the built tarballs — and pin the unpublished dependency so `pnpm add`
doesn't query the registry for `@hy-sde-org/dsh-hashline`:

```bash
git clone git@github.com:hy-sde/dsh-tool-edit.git
cd dsh-tool-edit
pnpm install
pnpm run build

HASHLINE_TGZ="$(cd packages/hashline && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$HASHLINE_TGZ"

# Pin hashline locally so the tool-edit tarball's dependency resolves offline.
printf 'overrides:\n  "@hy-sde-org/dsh-hashline": "file:%s/packages/hashline"\n' "$PWD" >> "$DSH_HOME/profiles/web/pnpm-workspace.yaml"

TOOLEDIT_TGZ="$(cd packages/tool-edit && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$TOOLEDIT_TGZ"
```

(The `overrides` entry is a pre-publication shim; delete it once you're on
the released registry package.)

> **Install order note:** don't try to satisfy the dependency by installing the
> hashline tarball "first" — pnpm re-resolves the full graph on every `add`
> and will 404 on an unpublished `@hy-sde-org/dsh-hashline` unless the override
> above pins it.

### Verify

```bash
dsh web --dump-config   # the tool-str-replace-editor row is patched to disabled: true
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-edit
dsh plugin --profile web remove @hy-sde-org/dsh-hashline
# remove the preset directory you copied from examples/agent-preset/ as well
```

## Replacing the built-in editor (official harness, rc.8+)

The official harness ships TWO editing surfaces host-wide: the `tool-fs`
`read`/`write`/`edit` suite and a dedicated Anthropic-style `str_replace_editor`
tool. On stock releases this plugin replaces them like this:

1. **Installing the bundle disables `str_replace_editor`** — the plugin's
   `cordis.patch.yml` patches the shipped `tool-str-replace-editor` row to
   `disabled: true` (re-enable later with `disabled: null`).
2. **The rich `edit` replaces the stock `edit` by agent scope shadowing** —
   harness scoped-tools semantics let a tool registered in the agent's own
   scope layer shadow a global tool of the same name. Mounting the plugin's
   `tool-edit` row in a user agent preset makes `edit` resolve to the rich
   editor, while `read`/`write` keep resolving from the deployment's host
   `tool-fs`. No host-plane bundle row can do this: the official `tool-fs` has
   no way to disable its own `edit` (the `enableEdit: false` key exists only
   in the hy-sde fork), so a second `edit`-owner on the host plane fails boot
   with "prompt section `tool:edit` is already registered".

The ready-to-copy preset ships in the package under
`examples/agent-preset/` (`agent.cordis.yml` + `preset.yml`). Install:

```bash
# from the installed package or this repo:
mkdir -p ~/.dsh/.agent-presets/my-edit
cp packages/tool-edit/examples/agent-preset/agent.cordis.yml \
   packages/tool-edit/examples/agent-preset/preset.yml \
   ~/.dsh/.agent-presets/my-edit/
# then select "Edit Mode (rich)" in the Web UI preset picker (or `dsh agent`)
```

The example preset mounts the rich editor beside the LSP seam in an entry-local
realm (`isolate: { lsp: true }`) so format-on-write and diagnostics-on-edit
work with zero upstream changes, and explicitly omits `tool-fs` — keeping the
per-session `tool-fs` row would register the stock `edit` in the same scope and
fail the preset boot. Copy the other rows you normally use (bash, todo,
ask-user, skills, …) from your current preset next to these; only the
filesystem-editing rows are special. `read`/`write` always keep coming from the
deployment's host `tool-fs`.

## What the bundle does

On official releases the plugin's `cordis.patch.yml` is intentionally *not*
self-contained: a host-plane fs realm cannot own the `edit` name because the
official `tool-fs` always registers `edit` (no `enableEdit` switch) — every
variant collides at boot. What the patch does instead:

- `tool-str-replace-editor` → `disabled: true` — retires the standalone
  `str_replace_editor` tool the harness ships host-wide (matches the hy-sde
  fork, which deleted the package outright).
- No rows inserted — the rich editor is mounted at the agent plane per the
  section above, where scoped shadowing makes it THE `edit` tool.

The **hy-sde fork** already integrates the rich editor directly in its shipped
presets (`code-edit`, `minimal`); there you keep mounting
`@hy-sde-org/dsh-tool-edit` in a preset beside `tool-fs` with
`enableEdit: false` (fork-only key), and the bundle patch above is a harmless
no-op (the `str_replace_editor` row does not exist there — the loader warns and
continues).

Configure the tool by patching the `tool-edit` row in your preset by id:

```yaml
- id: tool-edit
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
packages/hashline/    @hy-sde-org/dsh-hashline — the engine (no runtime deps)
packages/tool-edit/   @hy-sde-org/dsh-tool-edit — the plugin (embedds the LSP client)
  cordis.patch.yml    the installable harness bundle
  src/lsp/            embedded client: stdio framing, LSP client, provider,
                      writethrough (port of oh-my-pi's lsp writethrough)
```

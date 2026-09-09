# @hy-sde-org/dsh-tool-edit

The rich `edit` tool plugin for DeepSeek Harness: replace / patch / apply_patch / hashline modes with an embedded LSP client (format-on-write + diagnostics).

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-edit
```

> **Official harness releases (rc.8+):** installing the bundle disables the
> shipped `str_replace_editor` tool, and the rich editor replaces the stock
> `edit` by agent-scope shadowing. Mount the provided preset row — see the
> [Replacing the built-in editor](https://github.com/hy-sde/dsh-tool-edit#replacing-the-built-in-editor-official-harness-rc8)
> section and `examples/agent-preset/` in this package. Installing the bundle
> alone never breaks boot.

Full usage, configuration, and the benchmark against the built-in `str_replace_editor`: https://github.com/hy-sde/dsh-tool-edit#readme

## TypeScript 7 native LSP (opt-in)

TypeScript 7 dropped the JS `lib/tsserver.js` that `typescript-language-server`
wraps and speaks the language protocol natively via `tsc --lsp --stdio`, so the
wrapper fails at `initialize` on TypeScript 7 projects. Set
`typescriptNative` (off unless set — exactly as upstream oh-my-pi commit
`530664c8f5`) to make the embedded client pick exactly one server per
workspace:

```yaml
- id: tool-edit
  config:
    lspCommand: npx --yes typescript-language-server --stdio
    typescriptNative: {}        # enabled; native launcher defaults to `tsc`
    # typescriptNative:
    #   command: tsc             # override the native launcher name/path,
    #                            # e.g. a tsc wrapper or `tsgo`
```

Selection runs once per workspace at first spawn, from the workspace root of
the edit (`workspaceRoot`): a workspace TypeScript install (walking up to the
repo root, so monorepo workspaces use the root install) with no
`lib/tsserver.js` spawns the workspace's own `tsc` (`.bin/tsc`, with win32
`.exe`/`.cmd`/`.bat` candidates, falling back to the package's `bin/tsc`) with
`--lsp --stdio`; a classic install (has `lib/tsserver.js`) or no install keeps
`lspCommand` unchanged; with no workspace install, the native launcher resolved
on PATH is used only when its install also lacks `lib/tsserver.js`; anything
undetectable keeps `lspCommand` exactly as today.

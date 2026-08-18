# @hy-sde-org/dsh-tool-edit

The rich `edit` tool plugin for DeepSeek Harness: replace / patch / apply_patch / hashline modes with an embedded LSP client (format-on-write + diagnostics).

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-edit
```

> **Official harness releases (rc.7+):** installing the bundle disables the
> shipped `str_replace_editor` tool, and the rich editor replaces the stock
> `edit` by agent-scope shadowing. Mount the provided preset row — see the
> [Replacing the built-in editor](https://github.com/hy-sde/dsh-tool-edit#replacing-the-built-in-editor-official-harness-rc7)
> section and `examples/agent-preset/` in this package. Installing the bundle
> alone never breaks boot.

Full usage, configuration, and the benchmark against the built-in `str_replace_editor`: https://github.com/hy-sde/dsh-tool-edit#readme

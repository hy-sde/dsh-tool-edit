# Contributing

Thanks for helping with `dsh-tool-edit`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-hashline` (it must stay a
  zero-import engine) and no new `@deepseek-ai` dependencies for
  `@hy-sde-org/dsh-tool-edit` beyond its declared peers. Runtime Node builtins
  are fine (the host runs Node).
- **The embedded LSP client must stay standalone.** Never re-introduce the
  harness `ctx.lsp` seam (`@deepseek-ai/dsh-lsp`) as a hard dependency — the
  whole point is that this plugin works on stock deliveries of DeepSeek
  Harness. Preferred surface: `EditLspProvider` in
  `packages/tool-edit/src/lsp/provider.ts`.
- **Degrade, don't throw.** Every LSP operation resolves `undefined`/`null`
  on failure so the edit tool falls back to pass-through instead of erroring.
- Preserve the per-file upstream attribution headers
  (`Ported from @oh-my-pi/...` — MIT, see `THIRD-PARTY-NOTICES.md`).

## Workflow

1. Make your change in the appropriate `packages/*`.
2. `pnpm -r check` and `pnpm -r test` (hashline: 235, tool-edit: 20 tests).
3. Add/extend a spec next to the behavior you changed. The LSP client has a
   fake server fixture (`tests/fixtures/fake-lsp-server.mjs`) so client
   behavior can be tested without network or a real language server.
4. `pnpm -r build`, then `bash scripts/release-public.sh --check`.
5. Open a PR against `main`.

## Releasing

Release authority lives with the maintainers. The flow is guarded by
`scripts/release-public.sh` (clean tree, checks, tests, build, pack, org
membership, absence check, interactive confirm). Publish order is pinned:
`@hy-sde-org/dsh-hashline` first, then `@hy-sde-org/dsh-tool-edit`.

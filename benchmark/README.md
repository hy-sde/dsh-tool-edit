# Benchmark: rich `edit` vs the built-in `str_replace_editor`

This directory records the A/B run that answers the question the tool was
built for: **does the ported rich `edit` tool improve over DeepSeek Harness's
built-in `str_replace_editor`?** It exists because a port's value claim has to
be evidenced, not asserted — see **Why this benchmark is here** below.

## Setup

- **Tasks**: the [oh-my-pi TypeScript edit benchmark] fixture suite
  (`packages/typescript-edit-benchmark`, 106 tasks total) — pre-rendered
  `prompt.md` per task, byte-for-byte success against `expected/`.
- **Two waves** (all tasks, 1 run per arm):
  - **Mutation wave — 41 tasks** (operator, identifier, literal, duplicate,
    multi-composite): telegraphic, exact-snippet edits.
  - **Structural wave — 61 tasks** (duplicate-block, move-distant-block,
    remove-case-label, swap-adjacent-lines, swap-if-else, swap-sibling-blocks,
    wrap-redundant-if): block-level edits where exact matching is hardest.
- **Model**: `deepseek-v4-flash-0731` (local OpenAI-compatible route, the
  deployment's default).
- **Arms** (differ in exactly one variable — the edit tool):
  - `minimal`: persistent bash + `str_replace_editor` (built-in).
  - `minimal-code-edit`: persistent bash + `read`/`write` + rich `edit`
    (replace / patch / apply_patch / hashline).
- **Harness**: the real headless profile boot; host-plane tool rows disabled
  exactly like the shipped `web` profile so each arm sees **only** its preset's
  tools; a fresh agent/session per task; byte-for-byte verification.

Raw per-task results live in [`results/`](./results) and can be re-derived
with [`compare.mjs`](./compare.mjs).

## Mutation wave (41 tasks, 1 run)

| metric | `minimal` (str_replace_editor) | `minimal-code-edit` (rich edit) | Δ |
|---|---|---|---|
| pass rate | 41/41 (100.0%) | 41/41 (100.0%) | tie — ceiling |
| total wall time | 3202s | 2187s | −31.7% |
| mean per task | 78091ms | 53335ms | −31.7% |
| median per task | 53673ms | 43228ms | −19.5% |
| str_replace_editor calls | 166 | 0 | |
| edit calls | 0 | 155 | |
| read calls | 0 | 60 | (pairs with edit) |
| bash calls | 189 | 134 | −29.1% |
| non-fatal FsError retries | 53 | 75 | +41.5% |
| prompt tokens | 193,865 | 201,720 | +4.1% |
| completion tokens | 50,759 | 54,005 | +6.4% |

Per-category mean duration (rich edit faster in every category):

| category | baseline | rich edit | Δ |
|---|---|---|---|
| duplicate-line-flip | 102333ms | 41628ms | −59% |
| identifier-multi-edit | 66367ms | 63579ms | −4% |
| literal-flip-boolean | 32642ms | 21565ms | −34% |
| literal-off-by-one | 171398ms | 26156ms | **−85%** |
| multi-composite-multi-edit | 82599ms | 61980ms | −25% |
| operator-remove-negation | 35490ms | 30261ms | −15% |
| operator-swap-* | 60487ms | 38586ms | −36% |

## Structural wave (61 tasks, 1 run)

| metric | `minimal` (str_replace_editor) | `minimal-code-edit` (rich edit) | Δ |
|---|---|---|---|
| pass rate | 53/61 (86.9%) | 56/61 (91.8%) | **+4.9 pp** |
| total wall time | 7711s | 5144s | −33.3% |
| mean per task | 126415ms | 84330ms | −33.3% |
| median per task | 125920ms | 66024ms | −47.6% |
| str_replace_editor calls | 206 | 0 | |
| edit calls | 0 | 148 | |
| read calls | 0 | 119 | (pairs with edit) |
| bash calls | 361 | 200 | −44.6% |
| non-fatal FsError retries | 60 | 88 | +46.7% |
| prompt tokens | 444,826 | 396,306 | **−10.9%** |
| completion tokens | 161,745 | 167,716 | +3.7% |

Divergent per-task outcomes (11): rich edit wins **7**, loses **4** — the
losses concentrate in `remove-case-label` (1) and `wrap-redundant-if` (3).

```
structural-duplicate-block-003   baseline=PASS  edit=FAIL
structural-duplicate-block-005   baseline=FAIL  edit=PASS
structural-move-distant-block-006 baseline=FAIL  edit=PASS
structural-move-distant-block-008 baseline=FAIL  edit=PASS
structural-move-distant-block-009 baseline=FAIL  edit=PASS
structural-remove-case-label-005 baseline=PASS  edit=FAIL
structural-swap-sibling-blocks-003 baseline=FAIL  edit=PASS
structural-wrap-redundant-if-002 baseline=PASS  edit=FAIL
structural-wrap-redundant-if-005 baseline=PASS  edit=FAIL
structural-wrap-redundant-if-011 baseline=FAIL  edit=PASS
structural-wrap-redundant-if-014 baseline=FAIL  edit=PASS
```

## Reading

1. **Pass rate only discriminates on the structural wave** (+4.9 pp). The
   mutation tasks embed the exact replacement in the prompt, so a strong
   model nails both arms (ceiling). Block-level edits (move blocks,
   redundant-if unwrapping, sibling swaps) are where `str_replace_editor`'s
   exact-match burden bites and the rich editor's fuzzy/multi-mode paths
   carry: it flips 7 fails to passes while giving up 4.
2. **Wall time −32%/−33% on both waves**, median −48% on structural, faster
   in every category. The rich tool commits the exact change in fewer, cheaper
   round trips: bash inspection drops 29% (mutation) / 45% (structural).
3. **Prompt tokens −11% on structural** (the longest-running wave), driven by
   the halved bash round trips: the rich editor stops the
   read-verify-in-bash-then-replace churn.
4. **Tool strictness costs**: ~40–47% more non-fatal `FsError` first-tries on
   the rich arm (mandatory read-before-write, stricter matching). The model
   recovers from all of them — they show up as retry time, not task failures.
5. **Scope**: single model, 1 run per arm per wave. The direction is
   consistent across both waves and categories; 2–3 more runs (or a weaker
   model, which historically amplifies harness-side deltas) would firm the
   pass-rate estimate against per-run noise.

## Why this benchmark is here

The port exists to *improve on the harness's built-in editor*, so the claim
has to be demonstrable rather than assumed:

- **Evidence over assertion** — the numbers above quantify correctness
  (structural pass rate), efficiency (wall time), and cost (tokens, tool
  churn) on a public, reproducible task suite.
- **Regression floor** — future changes to the tool (or the LSP client, or
  the patch engine) can be diffed against these recorded runs; the benchmark
  is the guardrail that turns "I think it's still fine" into
  "it is still fine".
- **Honest accounting** — it also records the tool's known costs (the extra
  non-fatal `FsError` retries) so the trade-off is visible, not hidden.
- **Harness context** — this is exactly the "harness problem" class of
  work the [Stencil blog post on the harness problem] describes: when the
  harness's tool surface is the bottleneck, improving the tool itself — not
  the model — is where the leverage is. This benchmark measures that lever.

## Structured results

The JSON in [`results/`](./results) is per-task (pass, duration, tokens,
tool calls, tool failures) plus per-arm aggregates, exactly as the driver
wrote it — no paths, no session data, nothing machine-specific.

| wave | file |
|---|---|
| mutation | `results/mutation-minimal.json` · `results/mutation-minimal-code-edit.json` |
| structural | `results/structural-minimal.json` · `results/structural-minimal-code-edit.json` |

## Reproduce

The driver (`scripts/run-edit-benchmark.ts`) runs in the DeepSeek Harness
repo (its imports cross into harness internals, so it cannot live in this
plugin repo). From the harness checkout root:

```bash
pnpm exec tsx scripts/run-edit-benchmark.ts \
  --preset minimal \
  --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures \
  --out benchmark/results/mutation-minimal.json
pnpm exec tsx scripts/run-edit-benchmark.ts \
  --preset minimal-code-edit \
  --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures \
  --out benchmark/results/mutation-minimal-code-edit.json
```

(Repeat for the 61-task structural suite by passing `--tasks` with the
`structural-*` fixture ids, or by extending the driver's category slice.)
The `minimal-code-edit` preset used by the driver is the harness-side
equivalent of this plugin's `cordis.patch.yml` — the same row set, mounted
inside a preset realm instead of as a profile bundle.

`benchmark/compare.mjs` regenerates the comparison tables from any two
results JSONs.

[oh-my-pi TypeScript edit benchmark]: https://github.com/can1357/oh-my-pi/tree/main/packages/typescript-edit-benchmark
[Stencil blog post on the harness problem]: https://stencil.so/blog/the-harness-problem

# Benchmark: rich `edit` vs the built-in editor

This directory records the A/B run that answers the question the tool was
built for: **does the ported rich `edit` tool improve over DeepSeek Harness's
built-in editor?** It exists because a port's value claim has to be evidenced,
not asserted — see **Why this benchmark is here** below.

Two things live here:

- **Recorded evidence** ([`results/`](./results)) — a completed A/B run, with
  the tables below regenerated from it by [`compare.mjs`](./compare.mjs).
- **The tooling to re-run it** — the harness-side driver
  ([`run-edit-benchmark.ts`](./run-edit-benchmark.ts)) and two agent presets
  ([`presets/`](./presets)) that reproduce the A/B on today's harness releases.

An important honesty note up front: **the recorded run and a re-run today use
different arm definitions, so new numbers are NOT directly comparable to the
recorded tables** (details under [Setup](#setup) and
[Reproduce](#reproduce)). The tables below remain the regression floor for the
tool's behavior.

## Setup

### What the recorded run used (Aug 2026, hy-sde fork harness)

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
  - `minimal`: persistent bash + `str_replace_editor` (built-in Anthropic-style
    tool).
  - `minimal-code-edit`: persistent bash + `read`/`write` + rich `edit`
    (replace / patch / apply_patch / hashline).
- **Harness**: the real headless profile boot; host-plane tool rows disabled
  exactly like the shipped `web` profile so each arm sees **only** its preset's
  tools; a fresh agent/session per task; byte-for-byte verification.

### Re-running today (rc.7 posture)

The fork harness that produced the recorded run later **deleted
`str_replace_editor` and the benchmark driver**, and stock releases ship a
`tool-fs` without the `enableEdit` switch that the old self-contained rich
preset relied on. Re-running on current harnesses therefore needs the arms
redefined so the A/B stays single-variable:

- Both arms share the **deployment's host `tool-fs`** (`read`/`write`/`edit`)
  plus a fixed persona; the bench driver's patch disables the other
  host-plane rows and the standalone `str_replace_editor` tool.
- `baseline` ([`presets/baseline/`](./presets/baseline)) — no editor row, so
  the host **stock `edit`** resolves.
- `rich` ([`presets/rich/`](./presets/rich)) — a `tool-edit` row whose scoped
  `edit` **shadows** the host stock one; `read`/`write` still come from the
  host.

The tool surface is identical on both arms (read / write / edit); only the
`edit` implementation differs. Because the baseline is now the stock `tool-fs`
`edit` (not `str_replace_editor`) and the rich arm no longer owns its own
filesystem, **re-run numbers are not comparable to the recorded tables** —
treat a re-run as its own fresh A/B on the current release.

## Mutation wave (41 tasks, 1 run — recorded on the fork)

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

## Structural wave (61 tasks, 1 run — recorded on the fork)

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

Re-running requires a **DeepSeek Harness checkout** plus the **oh-my-pi
fixtures**; the driver boots the real `headless` profile so it must live where
it can import the harness CLI internals.

### 1. Prerequisites

- A harness checkout (stock release ≥ `rc.7`, or a fork) with `pnpm i` done,
  and **the rich `edit` plugin installed into it** so the harness resolves
  `@hy-sde-org/dsh-tool-edit`:
  ```bash
  dsh plugin --profile web add @hy-sde-org/dsh-tool-edit   # or the fork's equivalent
  ```
- The oh-my-pi fixture suite:
  ```bash
  git clone https://github.com/can1357/oh-my-pi
  # fixtures: <oh-my-pi>/packages/typescript-edit-benchmark/fixtures
  ```
- The plugin's bundled LSP client and hashline engine ship inside the plugin
  package — no extra installs for the default `mode: auto` arms.

### 2. Copy the driver into the harness

`benchmark/run-edit-benchmark.ts` imports `runProfile` from the harness CLI
internals (`apps/cli/src/profile-boot.ts`), which are not published to npm, so
copy it into the harness checkout at the exact location its relative imports
expect — the harness `scripts/` directory:

```bash
cp benchmark/run-edit-benchmark.ts <harness>/scripts/run-edit-benchmark.ts
cp benchmark/summarize-edit-benchmark.ts <harness>/scripts/summarize-edit-benchmark.ts
```

They are plain `.ts` files — no build step; run them with `pnpm exec tsx`.

### 3. Install the bench presets

The driver mounts presets by id, resolving them from the harness roster
(including the user preset root, which its overlay patch enables). Copy the
two arms into your user preset root and rename the directories to `baseline`
and `rich` (the preset ids):

```bash
cp -R benchmark/presets/rich      ~/.dsh/.agent-presets/rich
cp -R benchmark/presets/baseline  ~/.dsh/.agent-presets/baseline
```

(Adjust for a non-default `DSH_HOME`/user preset root.) The driver's
`--preset` argument names whatever id you installed.

### 4. Run the arms

From the **harness checkout root** (the driver's relative imports resolve
there), one invocation per arm per wave. Each run of the full 106-task suite
takes roughly 1–2 hours on a local route; use `--limit` for a pilot slice
first and benchmark/compare.mjs to eyeball the delta before committing hours:

```bash
# pilot check (a few tasks) — mutation-ish categories by default:
pnpm exec tsx scripts/run-edit-benchmark.ts --preset baseline --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures --out /tmp/bench/baseline-pilot.json --limit 3
pnpm exec tsx scripts/run-edit-benchmark.ts --preset rich     --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures --out /tmp/bench/rich-pilot.json     --limit 3

# full mutation wave (41 tasks, default slice):
pnpm exec tsx scripts/run-edit-benchmark.ts --preset baseline --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures --out /tmp/bench/mutation-baseline.json
pnpm exec tsx scripts/run-edit-benchmark.ts --preset rich     --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures --out /tmp/bench/mutation-rich.json

# full structural wave (61 tasks — pass --tasks with the structural-* ids, or
# extend the driver's category slice):
pnpm exec tsx scripts/run-edit-benchmark.ts --preset baseline --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures --out /tmp/bench/structural-baseline.json --tasks structural-duplicate-block-001,structural-move-distant-block-001
pnpm exec tsx scripts/run-edit-benchmark.ts --preset rich     --fixtures <oh-my-pi>/packages/typescript-edit-benchmark/fixtures --out /tmp/bench/structural-rich.json     --tasks structural-duplicate-block-001,structural-move-distant-block-001
```

### 5. Compare

```bash
node <dsh-tool-edit>/benchmark/compare.mjs /tmp/bench/mutation-baseline.json /tmp/bench/mutation-rich.json
```

### Caveats

- **Not comparable to the recorded tables** (different baseline tool and arm
  layout — see [Setup](#setup)). A re-run is a fresh A/B on the current
  release; if you want a like-for-like lineage with the recorded numbers, run
  both arms of the recorded definition (that requires a harness that still
  ships `str_replace_editor` and the old self-contained rich preset).
- Model route comes from the checkout's `agent-default-model` settings; the
  recorded numbers were produced on the `deepseek-v4-flash-0731` local route.
- Each task agent additionally gets whatever non-disabled host rows the
  headless profile exports; the overlay patch disables the model-facing ones
  (shell, skills, goals, todo, web, subagents, `str_replace_editor`, …) and
  keeps `tool-fs`, so both arms see `read`/`write`/`edit` only.

[oh-my-pi TypeScript edit benchmark]: https://github.com/can1357/oh-my-pi/tree/main/packages/typescript-edit-benchmark
[Stencil blog post on the harness problem]: https://stencil.so/blog/the-harness-problem

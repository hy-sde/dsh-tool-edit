/**
 * Mode descriptions and guidance adapted from the oh-my-pi prompts
 * (prompts/tools/replace.md, prompts/tools/patch.md, prompts/tools/
 * apply-patch.md and hashline/src/prompt.md). Concise but faithful.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

/** Guidance embedded for the `hashline` mode (from packages/hashline/src/prompt.md). */
export const HASHLINE_GUIDANCE = `
<guidance>
Section: [PATH#TAG]; TAG: 4-hex snapshot from latest read/search, REQUIRED each section.
HEADER FORMS:
- PUT N.=M: — replace original inclusive lines N–M with body (body rows)
- PUT N*: — replace the syntactic block beginning N (closing line resolved)
- PUT <N: — insert body rows before line N (PUT <1: = file head)
- PUT >N: — insert body rows after line N (PUT >$: = file tail)
- CUT N.=M / CUT N* — delete and capture lines / block; optional @name register
- REM — delete section file; MV DEST — move/rename section file
- Body rows ONLY below \`:\` headers; row is verbatim +TEXT (leading whitespace preserved).
  Literal initial dash/plus: \`- item\` → \`+- item\`; \`+ item\` → \`++ item\`.
- Numbers are original, never shifted by hunks. Each edit renumbers and changes #TAG.
- Touch displayed lines only; undisplayed hunks rejected. Elisions (…, .., collapsed N-M: rows) unseen.
- Ranges: changed lines only; never widen over keepers. Separate changes → separate hunks.
- NEVER format/restyle with this tool; run the project formatter.
Full prompt guidance lives in the package's hashline prompt (not duplicated here).
</guidance>
`.trim()

/** Single rich `edit` tool description covering all four modes. */
export const EDIT_TOOL_DESCRIPTION = `
Single-file edit tool. The mode is fixed by configuration, not per-call;
the appropriate argument shape is documented in <parameters>.

Mode "replace" (default) — literal string replacement with fuzzy whitespace
matching. MUST use the smallest old_string uniquely identifying the change.
A non-unique old_string MUST add context or use replace_all: true for all
occurrences. Renaming a string across the file → replace_all: true.

Mode "patch" — apply diff hunks. Hunk headers: bare \`@@\` when context lines
are unique, else \`@@ $ANCHOR\` copied verbatim from the file. Each hunk body
contains only lines starting with ' ' | '+' | '-', and at least one change
(+ or -). Use enough \` \`-prefixed context lines to make the match unique
(usually 2–8). When editing structured blocks, include the opening and
closing lines so the edit stays inside the block. NEVER use line numbers
as anchors. If a patch fails, re-read the file and produce a fresh patch —
never retry the same diff.

Mode "apply_patch" — Codex-style envelope:
*** Begin Patch
*** Add File: <path>
+<initial contents lines>
*** Update File: <path> [*** Move to: <new path>]
@@ <optional anchor/class/function>
- <old line>
+ <new line>
  <context line>
*** Delete File: <path>
*** End Patch
File references relative, never absolute. New-file lines MUST start \`+\`.

Mode "hashline" — a line-anchored patch language. ${HASHLINE_GUIDANCE}

<parameters>
replace mode: { path: string, old_string: string, new_string: string, replace_all?: boolean }
patch mode:   { path: string, edits: Array<{ op: "create"|"delete"|"update", rename?: string, diff?: string }> }
apply_patch / hashline mode: { input: string }
</parameters>

<critical>You MUST read the target file before editing it.
Missing reads are caught by the fs-observation-policy when mounted;
otherwise the edit proceeds from whatever content the tool can read.</critical>
`.trim()

/** The replace mode parameter JSON schema annotations. */
export const REPLACE_SCHEMA_DESCRIPTIONS = {
  path: 'the file path (relative to the working directory)',
  old_string: 'the exact existing text to replace (fuzzy whitespace matching when fuzzyMatch is enabled)',
  new_string: 'the replacement text',
  replace_all: 'when true, replaces every occurrence.',
} as const

/** The patch mode parameter JSON schema annotations. */
export const PATCH_SCHEMA_DESCRIPTIONS = {
  path: 'the file path (relative to the working directory)',
  edits: 'list of edit entries: { op: "create"|"delete"|"update", rename?: string, diff?: string }',
} as const

/** The apply_patch mode parameter schema annotations. */
export const APPLY_PATCH_SCHEMA_DESCRIPTIONS = {
  input: 'a full *** Begin Patch ... *** End Patch envelope',
} as const

/** The hashline mode parameter schema annotations. */
export const HASHLINE_SCHEMA_DESCRIPTIONS = {
  input: 'a hashline patch document ([path#tag] sections)',
} as const

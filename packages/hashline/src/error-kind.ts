/**
 * Machine-readable rejection kinds for edit failures (oh-my-pi 3c2b968909).
 * Errors keep their model-facing prose message; the kind is a stable
 * identifier so tooling can branch on the failure class without matching
 * message text.
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

/** Every rejection kind the edit surface reports. */
export const EDIT_ERROR_KINDS = [
  'stale_tag',
  'unknown_tag',
  'other_file_tag',
  'missing_tag',
  'header_only',
  'unseen_lines',
  'out_of_range',
  'ambiguous_boundary',
  'no_change',
  'no_match',
  'file_not_found',
] as const

/** One machine-readable edit rejection kind. */
export type EditErrorKind = (typeof EDIT_ERROR_KINDS)[number]

/** The rejection kinds, for consumers that enumerate them (anonymizer). */
export function editErrorKinds(): readonly EditErrorKind[] {
  return EDIT_ERROR_KINDS
}

const ERROR_KINDS = new WeakMap<Error, EditErrorKind>()

/** Attach `kind` to `error` and return it, so throw sites stay one-liners. */
export function withErrorKind<T extends Error>(error: T, kind: EditErrorKind): T {
  ERROR_KINDS.set(error, kind)
  return error
}

/** The kind attached with {@link withErrorKind}, or `undefined` for untagged errors. */
export function errorKindOf(error: unknown): EditErrorKind | undefined {
  // `instanceof` can throw on hostile thrown values (a Proxy whose
  // getPrototypeOf trap throws, e.g. the tool framework's hostile-value
  // sanitizer fixtures); the kind lookup must be total and never become the
  // failure it was trying to classify.
  try {
    return error instanceof Error ? ERROR_KINDS.get(error) : undefined
  } catch {
    return undefined
  }
}

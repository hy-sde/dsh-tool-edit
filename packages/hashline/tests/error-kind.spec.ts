import { describe, expect, it } from 'vitest'
// Ported from oh-my-pi 3c2b968909 + 6ba3c30845: every edit rejection carries a
// stable `kind` so tool layers can branch on failure mode instead of parsing
// prose.
import {
  EDIT_ERROR_KINDS,
  MismatchError,
  editErrorKinds,
  errorKindOf,
  validateLineRef,
  withErrorKind,
} from '../src/index.ts'

describe('edit error kinds', () => {
  it('exposes the oh-my-pi rejection kinds in order', () => {
    expect(EDIT_ERROR_KINDS).toEqual([
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
    ])
    expect(editErrorKinds()).toEqual(EDIT_ERROR_KINDS)
  })

  it('round-trips a kind through withErrorKind without mutating the error surface', () => {
    const error = withErrorKind(new Error('boom'), 'no_change')
    expect(errorKindOf(error)).toBe('no_change')
    expect(error.message).toBe('boom')
    expect(error).toBeInstanceOf(Error)
  })

  it('returns undefined for errors without a kind and for non-errors', () => {
    expect(errorKindOf(new Error('plain'))).toBeUndefined()
    expect(errorKindOf('not an error')).toBeUndefined()
    expect(errorKindOf(undefined)).toBeUndefined()
  })

  it('derives the mismatch kind in upstream precedence order', () => {
    const details = {
      expectedFileHash: 'AB12',
      actualFileHash: 'CD34',
      fileLines: ['one'],
    }
    expect(new MismatchError({ ...details, hashRecognized: true }).kind).toBe('stale_tag')
    expect(new MismatchError({ ...details, hashRecognized: false }).kind).toBe('unknown_tag')
    expect(new MismatchError({ ...details, hashRecognized: false, tagOriginPaths: ['/tmp/a.ts'] }).kind).toBe(
      'other_file_tag',
    )
    expect(
      new MismatchError({ ...details, hashRecognized: true, expectedFileHash: '', tagOriginPaths: ['/tmp/a.ts'] }).kind,
    ).toBe('stale_tag')
    expect(new MismatchError({ ...details, expectedFileHash: '', hashRecognized: false }).kind).toBe('missing_tag')
    // The constructor also tags the error itself, so the kind travels on the
    // thrown error even where the tool framework does not surface it.
    expect(errorKindOf(new MismatchError({ ...details, hashRecognized: true }))).toBe('stale_tag')
  })

  it('tags out-of-range line refs', () => {
    let thrown: Error | undefined
    try {
      validateLineRef({ line: 99 }, ['one'])
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(errorKindOf(thrown)).toBe('out_of_range')
  })
})

import { describe, expect, it } from 'vitest'
import { applyEdits, parsePatch } from '../src/index.ts'

/**
 * Applies with a code path, so the probe can judge whether an authored range
 * boundary broke the file — the shape every production call site (patcher,
 * recovery, section apply, preview) supplies.
 */
function apply(text: string, diff: string): { text: string; warnings: string[] } {
  const result = applyEdits(text, parsePatch(diff).edits, { path: 'fixture.ts' })
  return { text: result.text, warnings: result.warnings ?? [] }
}

/** Applies with a Rust path, for Rust-shaped fixtures. */
function applyRust(text: string, diff: string): { text: string; warnings: string[] } {
  const result = applyEdits(text, parsePatch(diff).edits, { path: 'fixture.rs' })
  return { text: result.text, warnings: result.warnings ?? [] }
}

function boundaryRepairWarnings(warnings: readonly string[]): string[] {
  return warnings.filter(warning => /Auto-repaired (?:a )?replacement boundar/.test(warning))
}

// The doc-restoration incident: `cargo fmt` shifted line numbers under the
// model, so a `PUT N.=N` meant to prepend doc lines above `#[napi]` landed one
// line high. Each body ended by restating the `#[napi]` that survives just
// below the range, duplicating the attribute. The result PARSES (attributes
// may repeat syntactically), so the probe-judged variant search never runs —
// only exact-text normalization with annotation-row evidence can catch it.
describe('single-line annotation echoes (the #[napi] doc-restoration incident)', () => {
  it('drops a trailing attribute echo in a single-line replacement', () => {
    const file = [
      '/// Unified-diff hunks with jsdiff',
      '/// `structuredPatch(_, _, oldText, newText, _, _, { context }).hunks`',
      '#[napi]',
      'pub fn structured_patch_hunks() {}',
    ].join('\n')
    const diff = ['PUT 2.=2:', '+/// semantics. `context` defaults to 4 like jsdiff.', '+#[napi]'].join('\n')
    const { text, warnings } = applyRust(file, diff)
    expect(text).toBe(
      [
        '/// Unified-diff hunks with jsdiff',
        '/// semantics. `context` defaults to 4 like jsdiff.',
        '#[napi]',
        'pub fn structured_patch_hunks() {}',
      ].join('\n'),
    )
    expect(text.split('\n').filter(line => line === '#[napi]')).toHaveLength(1)
    expect(boundaryRepairWarnings(warnings)).toHaveLength(1)
  })

  it('drops the echo when the body carries several new doc rows', () => {
    const file = [
      '/// Wrap text to a visible width, preserving ANSI escape codes across line',
      '/// breaks.',
      '#[napi]',
      'pub fn wrap_text_with_ansi() {}',
    ].join('\n')
    const diff = [
      'PUT 2.=2:',
      '+///',
      '+/// Returns UTF-16 lines with active SGR codes carried across line boundaries.',
      '+#[napi]',
    ].join('\n')
    const { text, warnings } = applyRust(file, diff)
    expect(text).toBe(
      [
        '/// Wrap text to a visible width, preserving ANSI escape codes across line',
        '///',
        '/// Returns UTF-16 lines with active SGR codes carried across line boundaries.',
        '#[napi]',
        'pub fn wrap_text_with_ansi() {}',
      ].join('\n'),
    )
    expect(text.split('\n').filter(line => line === '#[napi]')).toHaveLength(1)
    expect(boundaryRepairWarnings(warnings)).toHaveLength(1)
  })

  // Mirror direction: the range landed one line low and the body opens by
  // restating the attribute that survives just above it.
  it('drops a leading attribute echo in a single-line replacement', () => {
    const file = ['#[napi]', '/// Old summary.', 'pub fn f() {}'].join('\n')
    const diff = ['PUT 2.=2:', '+#[napi]', '+/// New summary.'].join('\n')
    const { text, warnings } = applyRust(file, diff)
    expect(text).toBe(['#[napi]', '/// New summary.', 'pub fn f() {}'].join('\n'))
    expect(text.split('\n').filter(line => line === '#[napi]')).toHaveLength(1)
    expect(boundaryRepairWarnings(warnings)).toHaveLength(1)
  })

  // Under-filled: the body is nothing but the echo. Dropping it would turn
  // the replace into a bare delete of the range line; applying it would
  // duplicate the attribute. Reject rather than guess.
  it('rejects a single-line annotation echo whose body cannot fill the range', () => {
    const file = ['/// Old doc.', '#[napi]', 'pub fn f() {}'].join('\n')
    expect(() => applyRust(file, 'PUT 1.=1:\n+#[napi]')).toThrow(/ends by restating/)
  })

  // Same shape in TypeScript: duplicate adjacent decorators parse, so the
  // annotation-row evidence is what fires, not the syntax probe.
  it('drops a trailing decorator echo in a single-line replacement', () => {
    const file = ['/** Old summary. */', '@Injectable()', 'class Service {}'].join('\n')
    const diff = ['PUT 1.=1:', '+/** Creates request-scoped services. */', '+@Injectable()'].join('\n')
    const { text, warnings } = apply(file, diff)
    expect(text).toBe(['/** Creates request-scoped services. */', '@Injectable()', 'class Service {}'].join('\n'))
    expect(text.split('\n').filter(line => line === '@Injectable()')).toHaveLength(1)
    expect(boundaryRepairWarnings(warnings)).toHaveLength(1)
  })

  // Statement echoes on single-line ranges stay literal (pinned above by the
  // balance-preserving tests): the annotation gate must not widen to them.
  it('keeps a trailing statement echo literal on a single-line range', () => {
    const file = ['foo();', 'old();', 'bar();'].join('\n')
    const { text, warnings } = apply(file, 'PUT 2.=2:\n+fresh();\n+bar();')
    expect(text).toBe(['foo();', 'fresh();', 'bar();', 'bar();'].join('\n'))
    expect(warnings).toHaveLength(0)
  })
})

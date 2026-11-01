import { describe, expect, it } from 'vitest'
// Ported from oh-my-pi ff0d7262f8 + 2995614a54: the stale-tag remedy names
// CURRENT line numbers and hands back the live tag; the line map is the
// shared shift resolution it builds on.
import { currentLineMap, staleUnseenLinesMessage } from '../src/index.ts'

describe('staleUnseenLinesMessage', () => {
  it('names the unseen lines, their current positions, and the live tag', () => {
    const message = staleUnseenLinesMessage('src/a.ts', [3, 5, 6], 'AB12', [4, 7, 8], 'CD34')
    expect(message).toContain('anchors to lines 3, 5-6 of src/a.ts')
    expect(message).toContain('[src/a.ts#AB12] never displayed in full')
    expect(message).toContain('those lines are now lines 4, 7-8, under [src/a.ts#CD34]')
    expect(message).toContain('Read `src/a.ts:4,7-8` with the read tool\'s maxLineLength input raised above its default')
    expect(message).toContain('re-issue the edit under [src/a.ts#CD34] with current line numbers')
  })

  it('keeps the range re-read selector free of spaces', () => {
    const message = staleUnseenLinesMessage('src/a.ts', [2], 'AB12', [10, 11, 12], 'CD34')
    expect(message).toContain('Read `src/a.ts:10-12`')
  })
})

describe('currentLineMap', () => {
  it('maps identical texts onto themselves', () => {
    const text = 'a\nb\nc\n'
    const map = currentLineMap(text, text)
    expect(map.get(1)).toBe(1)
    expect(map.get(3)).toBe(3)
  })

  it('maps lines through a pure shift', () => {
    const map = currentLineMap('a\nb\nc\n', 'x\ny\na\nb\nc\n')
    expect(map.get(1)).toBe(3)
    expect(map.get(2)).toBe(4)
    expect(map.get(3)).toBe(5)
  })

  it('drops lines removed since the previous text', () => {
    const map = currentLineMap('a\nb\nc\n', 'a\nc\n')
    expect(map.get(1)).toBe(1)
    expect(map.get(2)).toBeUndefined()
    expect(map.get(3)).toBe(2)
  })
})

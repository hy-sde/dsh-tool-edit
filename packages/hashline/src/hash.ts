/**
 * Harness-native replacements for the original package's hash utilities.
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 *
 * These are standalone replacements for the hash functions the original
 * obtained from Bun (`Bun.hash`), so the package runs on plain Node 20. Both
 * are deterministic; stability within a process (and across restarts, for
 * the xxHash32) is all the original semantics require.
 */

/** FNV-1a 32-bit hash of `input` (over UTF-16 code units), deterministic. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

const XXH_PRIME32_1 = 2654435761
const XXH_PRIME32_2 = 2246822519
const XXH_PRIME32_3 = 3266489917
const XXH_PRIME32_4 = 668265263
const XXH_PRIME32_5 = 374761393

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0
}

function readU32LE(input: Uint8Array, offset: number): number {
  return (
    (input[offset] ?? 0) |
		((input[offset + 1] ?? 0) << 8) |
		((input[offset + 2] ?? 0) << 16) |
		((input[offset + 3] ?? 0) << 24)
  ) >>> 0
}

function round(acc: number, input: number, mul1: number, rot: number, mul2: number): number {
  let value = (acc + Math.imul(input, mul1)) >>> 0
  value = rotl32(value, rot)
  return Math.imul(value, mul2) >>> 0
}

/**
 * Standard xxHash32 over `input` with the given `seed`, matching
 * `Bun.hash.xxHash32(input, seed)` semantics (returns the full unsigned 32-bit
 * hash; callers apply their own mask). Implemented from the public algorithm
 * for portability — no native addon.
 */
export function xxhash32(seed: number, input: Uint8Array): number {
  const len = input.length
  let hash: number
  let position = 0
  if (len >= 16) {
    const limit = len - 16
    let v1 = (seed + XXH_PRIME32_1) >>> 0
    let v2 = (seed + XXH_PRIME32_2) >>> 0
    let v3 = (seed + XXH_PRIME32_3) >>> 0
    let v4 = (seed + XXH_PRIME32_4) >>> 0
    do {
      v1 = round(v1, readU32LE(input, position), XXH_PRIME32_2, 13, XXH_PRIME32_1)
      v2 = round(v2, readU32LE(input, position + 4), XXH_PRIME32_4, 11, XXH_PRIME32_3)
      v3 = round(v3, readU32LE(input, position + 8), XXH_PRIME32_2, 13, XXH_PRIME32_1)
      v4 = round(v4, readU32LE(input, position + 12), XXH_PRIME32_4, 11, XXH_PRIME32_3)
      position += 16
    } while (position <= limit)
    hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0
  } else {
    hash = (seed + XXH_PRIME32_5) >>> 0
  }
  hash = (hash + len) >>> 0
  while (position + 4 <= len) {
    hash = (hash + readU32LE(input, position)) >>> 0
    hash = Math.imul(rotl32(hash, 17), XXH_PRIME32_4) >>> 0
    position += 4
  }
  while (position < len) {
    hash = (hash + (input[position] ?? 0) * XXH_PRIME32_5) >>> 0
    hash = Math.imul(rotl32(hash, 11), XXH_PRIME32_1) >>> 0
    position++
  }
  hash ^= hash >>> 15
  hash = Math.imul(hash, XXH_PRIME32_2) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, XXH_PRIME32_3) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

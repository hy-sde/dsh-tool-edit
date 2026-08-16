/**
 * Harness-native replacement for the original's `LRUCache` (imported from
 * `@oh-my-pi/pi-utils/lru`). Ported from @oh-my-pi/hashline
 * (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025
 * Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 *
 * Minimal bounded LRU covering exactly what snapshots.ts uses: `max` count
 * eviction plus optional `maxSize` / `sizeCalculation` byte-style eviction,
 * with `get`/`set`/`has`/`delete`/`keys`/`values`/`clear`. Backed by
 * insertion-order Map recency (delete + reinsert to bump). This is intentionally
 * a small subset of the pi-utils LRU API — keep it that way.
 */
export interface LRUCacheOptions<K, V> {
  /** Maximum number of entries retained before eviction begins. */
  max: number
  /** Optional ceiling on the summed calculated size of retained entries. */
  maxSize?: number
  /** Optional per-entry size function; default size is 1 (count-based). */
  sizeCalculation?: (value: V, key: K) => number
}

export class LRUCache<K, V> {
  readonly max: number
  readonly #maxSize: number | undefined
  readonly #sizeCalculation: ((value: V, key: K) => number) | undefined
  #map = new Map<K, V>()

  constructor(options: LRUCacheOptions<K, V>) {
    this.max = options.max
    this.#maxSize = options.maxSize
    this.#sizeCalculation = options.sizeCalculation
  }

  #sizeOf(value: V, key: K): number {
    return this.#sizeCalculation ? this.#sizeCalculation(value, key) : 1
  }

  #totalSize(): number {
    let total = 0
    for (const [key, value] of this.#map) total += this.#sizeOf(value, key)
    return total
  }

  get size(): number {
    return this.#map.size
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key)
    if (value === undefined) return undefined
    // Reading refreshes recency.
    this.#map.delete(key)
    this.#map.set(key, value)
    return value
  }

  has(key: K): boolean {
    return this.#map.has(key)
  }

  set(key: K, value: V): this {
    if (this.#map.has(key)) this.#map.delete(key)
    this.#map.set(key, value)
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value
      if (oldest === undefined) break
      this.#map.delete(oldest)
    }
    if (this.#maxSize !== undefined) {
      while (this.#totalSize() > this.#maxSize) {
        const oldest = this.#map.keys().next().value
        if (oldest === undefined) break
        this.#map.delete(oldest)
      }
    }
    return this
  }

  delete(key: K): boolean {
    return this.#map.delete(key)
  }

  keys(): IterableIterator<K> {
    return this.#map.keys()
  }

  values(): IterableIterator<V> {
    return this.#map.values()
  }

  clear(): void {
    this.#map.clear()
  }
}

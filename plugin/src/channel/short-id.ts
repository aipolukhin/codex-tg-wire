// 5-letter short id used by both the permission relay (consumed from CC)
// and the AskUserQuestion relay (generated locally). The alphabet matches
// Claude Code's canonical form: lowercase a-z minus `l` (visually
// ambiguous with `1`/`i`). Keeping it identical lets the same regex set
// in `permissions.ts` (`[a-km-z]{5}`) validate both surfaces uniformly,
// and lets operator grep audit logs with one pattern.
//
// 25^5 = ~9.7M IDs — plenty for low-QPS request flows. We do NOT attempt
// uniqueness here (it's the caller's job to retry on collision against
// its own map) — generation stays pure.
//
// Crypto-grade randomness via Web Crypto's getRandomValues. Bun/Node 22
// expose `globalThis.crypto.getRandomValues` natively; we read it once
// at module load so the test surface is small (no DI required) and a
// future shim can monkey-patch globalThis.crypto before import.
//
// Bias note: 25 doesn't divide 256, so naive `byte % 25` skews the
// distribution slightly toward the first 6 letters. We rejection-sample
// the upper region (>= 250 = 25 * 10) — at most ~2.3% of bytes are
// discarded, negligible for callers.

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz' // 25 chars, 'l' removed
const SHORT_ID_LEN = 5
const ACCEPT_MAX = ALPHABET.length * 10 // 250 — reject bytes in [250, 256)

interface RandomSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T
}

// Captured at module load so tests can monkey-patch globalThis.crypto
// before requiring this module. We re-read on every call so a later
// stub still works — tiny overhead, big test ergonomics.
function rng(): RandomSource {
  // Allow tests to install a custom RNG via setShortIdRandomSource() so we
  // can deterministically force a collision (Phase 5 FIX-T3 F2 test).
  if (rngOverride !== null) return rngOverride
  const c = (globalThis as { crypto?: RandomSource }).crypto
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('short-id: globalThis.crypto.getRandomValues is unavailable')
  }
  return c
}

// Test seam — when non-null this overrides the global crypto. Restore by
// calling with `null`. Keeps tests from monkey-patching globalThis.crypto
// (which would leak across the test process).
let rngOverride: RandomSource | null = null
export function setShortIdRandomSource(src: RandomSource | null): void {
  rngOverride = src
}

// Strict validator — identical alphabet/length to the wire regex used by
// the permission relay. Exported so callers (webhook, telegram handler)
// can defensively re-check incoming payloads.
export const SHORT_ID_RE = /^[a-km-z]{5}$/

export function isShortId(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ID_RE.test(value)
}

/** Generate one 5-letter id from the constrained alphabet. */
export function generateShortId(): string {
  const source = rng()
  // Slightly oversized buffer so the inner loop almost never has to
  // refill — average byte yield is ~25/26 per draw.
  const buf = new Uint8Array(SHORT_ID_LEN * 2)
  let out = ''
  while (out.length < SHORT_ID_LEN) {
    source.getRandomValues(buf)
    for (let i = 0; i < buf.length && out.length < SHORT_ID_LEN; i++) {
      const b = buf[i] ?? 0
      if (b >= ACCEPT_MAX) continue // rejection sample
      out += ALPHABET[b % ALPHABET.length]
    }
  }
  return out
}

// Anything callable as a "is this id already taken?" predicate. Accepts
// both the natural Set/Map shape (`{ has(id) }`) and a free function so
// callers can compose multiple sources (pending + completedIds + ...).
export type ShortIdExistsPredicate =
  | { has(id: string): boolean }
  | ((id: string) => boolean)

function existsViaPredicate(pred: ShortIdExistsPredicate, id: string): boolean {
  if (typeof pred === 'function') return pred(id)
  return pred.has(id)
}

/**
 * Generate a short id that does not collide with the given existence
 * predicate. The predicate can be a Set/Map (`{ has(id) }`) or a free
 * function — callers should compose all storage layers that may still
 * own an id (e.g. `pending.has(id) || completedIds.has(id)`) so a TTL'd
 * cache entry cannot be reused for a fresh request. After `maxAttempts`
 * failed draws we throw — callers should treat this as a fatal logic
 * error (the map is unbounded or near-saturated).
 */
export function generateUniqueShortId(
  existing: ShortIdExistsPredicate,
  maxAttempts = 32,
): string {
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateShortId()
    if (!existsViaPredicate(existing, id)) return id
  }
  throw new Error(`short-id: failed to generate unique id after ${maxAttempts} attempts`)
}

// Seeded deck shuffle (Fisher–Yates with a mulberry32 PRNG). Pure and
// deterministic: the same seed always yields the same order, so a duel stays
// reproducible from its seed. Kept apart from session.ts so it can be unit
// tested without loading the ocgcore WASM.

export function shuffleDeck(cards: readonly number[], seed: bigint): number[] {
  const out = [...cards];
  // Fold the 64-bit duel seed down to a 32-bit PRNG state.
  let s = Number((seed ^ (seed >> 32n)) & 0xffffffffn) >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

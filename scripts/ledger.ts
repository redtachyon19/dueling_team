// scripts/ledger.ts
//
// BUILD-TIME ONLY. Shared by the importer scripts; never imported by the app.
//
// THE CARD LEDGER — engine/cards/ledger.json — is the single source of truth for
// which passcodes are in the game and which are blacklisted, and why.
//
// Before this existed, every import re-derived those decisions from live
// upstream state (Yugipedia's OCG-only query, .cdb filenames, TCG release
// dates). That meant the same command could silently produce a different card
// pool on a different day: one flaky Yugipedia response and a legitimate TCG
// card vanishes from the app with nothing to point at. The ledger freezes each
// decision the first time it is made, so the pool only changes when the ledger
// changes — and that change shows up as a reviewable git diff.
//
// RECONCILIATION RULES (see `reconcile`):
//   1. Unknown passcode  → take the importer's derived decision, record it,
//                          report it as new.
//   2. Known passcode    → THE LEDGER WINS. Upstream cannot silently flip a
//                          card; a disagreement is reported as drift.
//   3. `locked: true`    → hand-pinned. Never re-derived, drift never applied.
//   4. Temporal reasons  → re-derived every run (see REEVALUATE). "unreleased"
//                          MUST be, or a card would stay excluded forever once
//                          its set finally ships.
//
// Each entry records the `origin` importer that owns it, so `import-cards` and
// `import-ocg` can each rewrite their own decisions without clobbering the
// other's half of the file.

import { PATHS, readJson, writeJson } from "./_lib.ts";

/** Which importer owns a decision. An importer only rewrites its own entries. */
export type LedgerOrigin = "cards" | "ocgcore";

/** Why a passcode is excluded. `tcg` is the reason an entry is *included*. */
export type LedgerReason =
  | "tcg" // included: a released TCG card
  | "ocg-only" // OCG/Master-Duel exclusive (Yugipedia Medium::OCG-only)
  | "skill-card" // Speed Duel Skill Card
  | "unreleased" // announced but not yet on shelves — no official English text
  | "manual" // hand-curated removal (see MANUAL_EXCLUDE in import-cards.ts)
  | "rush-duel" // Rush Duel — a different game
  | "anime-unofficial" // anime / manga / video-game-only
  | "goat" // Goat-format alternate entry
  | "prerelease"; // upstream prerelease cdb

/** Reasons that describe a moment in time, not a permanent decision, and so are
 *  re-derived on every import. Without this an "unreleased" card would stay
 *  excluded forever once its set actually shipped. */
const REEVALUATE = new Set<LedgerReason>(["unreleased"]);

export const REASON_LEGEND: Record<LedgerReason, string> = {
  "tcg": "Released TCG card — in the pool",
  "ocg-only": "OCG / Master Duel exclusive, never printed for the TCG",
  "skill-card": "Speed Duel Skill Card — not a playable card here",
  "unreleased": "Announced but not yet released; no official English text yet",
  "manual": "Hand-curated removal (video-game-only, OCG dupe, …)",
  "rush-duel": "Rush Duel — a different game entirely",
  "anime-unofficial": "Anime / manga / video-game-only card",
  "goat": "Goat-format alternate card entry",
  "prerelease": "Upstream prerelease data — unofficial translation",
};

export interface LedgerEntry {
  name?: string;
  reason: LedgerReason;
  /** Where the decision came from: a set code, a .cdb filename, a rule name. */
  source?: string;
  origin: LedgerOrigin;
  /** Hand-pinned: never re-derived, and drift is reported but never applied. */
  locked?: boolean;
}

export interface Ledger {
  _comment?: string;
  generatedAt?: string;
  counts?: { include: number; exclude: number };
  reasons?: Record<string, string>;
  include: Record<string, LedgerEntry>;
  exclude: Record<string, LedgerEntry>;
}

/** One importer's proposed decision for a single passcode. */
export interface Decision {
  code: number;
  name?: string;
  status: "include" | "exclude";
  reason: LedgerReason;
  source?: string;
}

/** Reported rows carry whatever name we have, which may be nothing. */
type Named = { code: number; name?: string | undefined };

export interface ReconcileResult {
  added: Array<Named & { status: "include" | "exclude"; reason: LedgerReason }>;
  /** Ledger and importer disagree; the ledger's decision was kept. */
  drift: Array<Named & { was: LedgerReason; now: LedgerReason; applied: boolean }>;
  /** Passcodes the ledger owned for this origin that upstream no longer returns. */
  vanished: Array<Named & { status: "include" | "exclude" }>;
  held: Array<Named & { status: "include" | "exclude"; reason: LedgerReason }>;
  /** Same verdict, different reason — e.g. a card BabelCDB files under
   *  "prerelease" that YGOPRODeck already told us is "ocg-only". The card is out
   *  either way, so this is trivia: counted, not listed. */
  reasonOnly: number;
}

const EMPTY: Ledger = { include: {}, exclude: {} };

export async function readLedger(): Promise<Ledger> {
  const raw = await readJson<Ledger>(PATHS.cardsLedger);
  if (!raw) return { ...EMPTY, include: {}, exclude: {} };
  return { include: raw.include ?? {}, exclude: raw.exclude ?? {} };
}

const entryOf = (l: Ledger, code: number): { entry: LedgerEntry; status: "include" | "exclude" } | null => {
  const k = String(code);
  if (l.include[k]) return { entry: l.include[k]!, status: "include" };
  if (l.exclude[k]) return { entry: l.exclude[k]!, status: "exclude" };
  return null;
};

/**
 * Fold one importer's decisions into the ledger, applying the rules above.
 *
 * `strict` holds brand-new passcodes out of the ledger entirely (reported as
 * `held`) so nothing reaches the app until it is accepted by hand.
 */
export function reconcile(
  ledger: Ledger,
  decisions: readonly Decision[],
  origin: LedgerOrigin,
  { strict = false } = {},
): ReconcileResult {
  const res: ReconcileResult = { added: [], drift: [], vanished: [], held: [], reasonOnly: 0 };
  const seen = new Set<string>();

  for (const d of decisions) {
    const k = String(d.code);
    seen.add(k);
    const current = entryOf(ledger, d.code);

    // 1. New passcode.
    if (!current) {
      if (strict) {
        res.held.push({ code: d.code, name: d.name, status: d.status, reason: d.reason });
        continue;
      }
      place(ledger, d, origin);
      res.added.push({ code: d.code, name: d.name, status: d.status, reason: d.reason });
      continue;
    }

    // Refresh the display name even when the decision itself is unchanged.
    if (d.name) current.entry.name = d.name;

    if (current.status === d.status && current.entry.reason === d.reason) continue;

    // Same verdict, different label. Only the reason moves, and only when the
    // ledger has no opinion worth keeping (a temporal reason). Never noisy.
    if (current.status === d.status) {
      if (!current.entry.locked && REEVALUATE.has(current.entry.reason)) current.entry.reason = d.reason;
      res.reasonOnly++;
      continue;
    }

    // 3/4. Locked entries never move. Temporal reasons are re-derived; anything
    // else keeps the ledger's decision and is reported as drift.
    const temporal = REEVALUATE.has(current.entry.reason) || REEVALUATE.has(d.reason);
    const applied = !current.entry.locked && temporal;
    if (applied) {
      remove(ledger, d.code);
      place(ledger, d, origin);
    }
    res.drift.push({
      code: d.code,
      name: d.name ?? current.entry.name,
      was: current.entry.reason,
      now: d.reason,
      applied,
    });
  }

  // Passcodes this origin owns that upstream stopped returning. Reported, never
  // auto-removed — a card silently disappearing upstream is exactly the failure
  // this ledger exists to make visible.
  for (const [k, e] of [
    ...Object.entries(ledger.include).map(([k, e]) => [k, e, "include"] as const),
    ...Object.entries(ledger.exclude).map(([k, e]) => [k, e, "exclude"] as const),
  ] as Array<readonly [string, LedgerEntry, "include" | "exclude"]>) {
    if (e.origin === origin && !seen.has(k)) {
      res.vanished.push({ code: Number(k), name: e.name, status: k in ledger.include ? "include" : "exclude" });
    }
  }

  return res;
}

function place(ledger: Ledger, d: Decision, origin: LedgerOrigin): void {
  const entry: LedgerEntry = { reason: d.reason, origin };
  if (d.name) entry.name = d.name;
  if (d.source) entry.source = d.source;
  (d.status === "include" ? ledger.include : ledger.exclude)[String(d.code)] = entry;
}

function remove(ledger: Ledger, code: number): void {
  delete ledger.include[String(code)];
  delete ledger.exclude[String(code)];
}

/** Every passcode currently marked for inclusion. */
export function includedCodes(ledger: Ledger): Set<number> {
  return new Set(Object.keys(ledger.include).map(Number));
}

export async function writeLedger(ledger: Ledger): Promise<void> {
  const sortNum = (a: string, b: string) => Number(a) - Number(b);
  const sorted = (rec: Record<string, LedgerEntry>) =>
    Object.fromEntries(Object.keys(rec).sort(sortNum).map((k) => [k, rec[k]!]));
  await writeJson(PATHS.cardsLedger, {
    _comment:
      "SINGLE SOURCE OF TRUTH for the card pool. Generated by the importers (scripts/ledger.ts); " +
      "safe to hand-edit — set \"locked\": true on an entry to pin it so no import can move it. " +
      "The ledger wins over upstream: a passcode already listed here keeps its decision.",
    generatedAt: new Date().toISOString(),
    counts: { include: Object.keys(ledger.include).length, exclude: Object.keys(ledger.exclude).length },
    reasons: REASON_LEGEND,
    include: sorted(ledger.include),
    exclude: sorted(ledger.exclude),
  } satisfies Ledger);
}

/** Console summary shared by both importers. */
export function reportReconcile(res: ReconcileResult, ledger: Ledger, label: string): void {
  const show = 8;
  if (res.added.length) {
    console.log(`  ${res.added.length} new passcode(s) recorded in the ledger:`);
    for (const a of res.added.slice(0, show)) {
      console.log(`    +${a.status.padEnd(7)} ${String(a.code).padEnd(10)} ${(a.name ?? "").slice(0, 34).padEnd(36)}${a.reason}`);
    }
    if (res.added.length > show) console.log(`    … and ${res.added.length - show} more`);
  }
  if (res.held.length) {
    console.log(`  ⚠ ${res.held.length} new passcode(s) HELD (--strict) — not imported until accepted:`);
    for (const h of res.held.slice(0, show)) {
      console.log(`    ?${h.status.padEnd(7)} ${String(h.code).padEnd(10)} ${(h.name ?? "").slice(0, 34).padEnd(36)}${h.reason}`);
    }
    if (res.held.length > show) console.log(`    … and ${res.held.length - show} more`);
  }
  for (const d of res.drift) {
    const verb = d.applied ? "updated" : "KEPT ledger";
    console.log(`  ~ ${d.code} ${(d.name ?? "").slice(0, 34)}: upstream says "${d.now}", ledger says "${d.was}" — ${verb}`);
  }
  if (res.reasonOnly) {
    console.log(`  ${res.reasonOnly} passcode(s) already blacklisted under a different reason — kept as-is`);
  }
  if (res.vanished.length) {
    console.log(`  ⚠ ${res.vanished.length} ledger passcode(s) upstream no longer returns (kept, review):`);
    for (const v of res.vanished.slice(0, show)) console.log(`    - ${v.code} ${v.name ?? ""}`);
    if (res.vanished.length > show) console.log(`    … and ${res.vanished.length - show} more`);
  }
  console.log(
    `  ledger [${label}]: ${Object.keys(ledger.include).length.toLocaleString()} include / ` +
      `${Object.keys(ledger.exclude).length.toLocaleString()} exclude → ${PATHS.cardsLedger}`,
  );
}

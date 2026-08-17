import { readLedger, REASON_LEGEND, type LedgerEntry } from "./ledger.ts";
import { PATHS, hasFlag } from "./_lib.ts";

type Row = { code: string; entry: LedgerEntry; status: "include" | "exclude" };

function rowsOf(l: Awaited<ReturnType<typeof readLedger>>): Row[] {
  return [
    ...Object.entries(l.include).map(([code, entry]) => ({ code, entry, status: "include" as const })),
    ...Object.entries(l.exclude).map(([code, entry]) => ({ code, entry, status: "exclude" as const })),
  ];
}

function printRow(r: Row): void {
  const lock = r.entry.locked ? " [locked]" : "";
  const src = r.entry.source ? `  (${r.entry.source})` : "";
  console.log(
    `  ${r.status === "include" ? "✓" : "✗"} ${r.code.padEnd(10)} ${(r.entry.name ?? "—").slice(0, 44).padEnd(46)}` +
      `${r.entry.reason}${src}${lock}`,
  );
}

async function main() {
  const ledger = await readLedger();
  const rows = rowsOf(ledger);
  if (rows.length === 0) {
    console.error(`✗ ${PATHS.cardsLedger} is empty or missing. Run \`pnpm import:cards\` first.`);
    process.exit(1);
  }

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const reasonFlag = process.argv.find((a) => a.startsWith("--reason="))?.slice("--reason=".length);

  if (reasonFlag) {
    const hits = rows.filter((r) => r.entry.reason === reasonFlag);
    console.log(`${hits.length.toLocaleString()} passcode(s) with reason "${reasonFlag}" — ${REASON_LEGEND[reasonFlag as keyof typeof REASON_LEGEND] ?? "unknown reason"}`);
    const show = hasFlag("list") ? hits : hits.slice(0, 20);
    for (const r of show) printRow(r);
    if (show.length < hits.length) console.log(`  … and ${hits.length - show.length} more (--list for all)`);
    return;
  }

  if (args.length) {
    const q = args.join(" ");
    const byCode = rows.filter((r) => r.code === q);
    const hits = byCode.length ? byCode : rows.filter((r) => (r.entry.name ?? "").toLowerCase().includes(q.toLowerCase()));
    if (!hits.length) {
      console.log(`No ledger entry matches "${q}".`);
      console.log("  A passcode absent from the ledger has never been seen upstream.");
      return;
    }
    console.log(`${hits.length} match(es) for "${q}":`);
    for (const r of hits.slice(0, 40)) printRow(r);
    if (hits.length > 40) console.log(`  … and ${hits.length - 40} more`);
    for (const r of hits.slice(0, 40)) {
      if (r.status === "exclude") {
        console.log(`\n  ${r.code} is NOT in the game: ${REASON_LEGEND[r.entry.reason] ?? r.entry.reason}`);
        if (r.entry.locked) console.log("  This entry is locked — no import can move it.");
        else console.log('  To force it in: move the entry to "include" in the ledger and set "locked": true.');
        break;
      }
    }
    return;
  }

  const byReason = new Map<string, number>();
  for (const r of rows) byReason.set(r.entry.reason, (byReason.get(r.entry.reason) ?? 0) + 1);
  const inc = Object.keys(ledger.include).length;
  const exc = Object.keys(ledger.exclude).length;
  console.log(`Card ledger — ${PATHS.cardsLedger}`);
  console.log(`  ${inc.toLocaleString()} included · ${exc.toLocaleString()} blacklisted · ${(inc + exc).toLocaleString()} known passcodes\n`);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(7)}  ${reason.padEnd(18)} ${REASON_LEGEND[reason as keyof typeof REASON_LEGEND] ?? ""}`);
  }
  const locked = rows.filter((r) => r.entry.locked).length;
  if (locked) console.log(`\n  ${locked} entr(y/ies) locked by hand — imports will never move them.`);
  console.log("\n  pnpm ledger <passcode|name>   why a card is in or out");
  console.log("  pnpm ledger --reason=<reason> everything filed under one reason");
}

main().catch((err) => {
  console.error("✗ ledger-query failed:", err);
  process.exit(1);
});

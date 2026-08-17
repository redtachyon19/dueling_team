// scripts/ledger.test.ts
//
// The reconciliation rules decide the entire card pool, so they get tested even
// though the rest of scripts/ is manual build-time tooling. Pure logic — no
// network, no disk.
//
//   pnpm test:scripts

import { describe, expect, it } from "vitest";
import { reconcile, includedCodes, type Decision, type Ledger } from "./ledger.ts";

const ledger = (): Ledger => ({
  include: { "100": { name: "Kept Card", reason: "tcg", origin: "cards" } },
  exclude: {
    "200": { name: "Pinned Out", reason: "manual", origin: "cards", locked: true },
    "300": { name: "Future Card", reason: "unreleased", origin: "cards" },
    "400": { name: "Rush Thing", reason: "rush-duel", origin: "ocgcore" },
  },
});

const run = (decisions: Decision[], opts: { strict?: boolean } = {}) => {
  const l = ledger();
  const r = reconcile(l, decisions, "cards", opts);
  return { l, r };
};

describe("ledger reconciliation", () => {
  it("records a passcode it has never seen", () => {
    const { l, r } = run([{ code: 999, name: "New", status: "include", reason: "tcg" }]);
    expect(l.include["999"]).toMatchObject({ name: "New", reason: "tcg", origin: "cards" });
    expect(r.added).toHaveLength(1);
  });

  // The reason this file exists: a flaky Yugipedia response must not be able to
  // evict a card that is already in the pool.
  it("keeps an included card when upstream suddenly calls it OCG-only", () => {
    const { l, r } = run([{ code: 100, name: "Kept Card", status: "exclude", reason: "ocg-only" }]);
    expect(l.include["100"]).toBeDefined();
    expect(l.exclude["100"]).toBeUndefined();
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toMatchObject({ code: 100, was: "tcg", now: "ocg-only", applied: false });
  });

  it("never moves a locked entry", () => {
    const { l } = run([{ code: 200, name: "Pinned Out", status: "include", reason: "tcg" }]);
    expect(l.exclude["200"]).toBeDefined();
    expect(l.include["200"]).toBeUndefined();
  });

  // Without this an announced card would stay excluded forever once it shipped.
  it("re-derives 'unreleased' so a card enters the pool when its set ships", () => {
    const { l, r } = run([{ code: 300, name: "Future Card", status: "include", reason: "tcg" }]);
    expect(l.include["300"]).toBeDefined();
    expect(r.drift[0]?.applied).toBe(true);
  });

  it("holds brand-new passcodes out of the pool under --strict", () => {
    const { l, r } = run([{ code: 888, name: "Held", status: "include", reason: "tcg" }], { strict: true });
    expect(l.include["888"]).toBeUndefined();
    expect(r.held).toHaveLength(1);
  });

  it("leaves another importer's entries alone", () => {
    const { l, r } = run([{ code: 100, name: "Kept Card", status: "include", reason: "tcg" }]);
    expect(l.exclude["400"]).toBeDefined();
    expect(r.vanished.some((v) => v.code === 400)).toBe(false);
  });

  it("reports — but never deletes — a passcode upstream stopped returning", () => {
    const { l, r } = run([]);
    expect(l.include["100"]).toBeDefined();
    expect(r.vanished.map((v) => v.code).sort()).toEqual([100, 200, 300]);
  });

  it("collapses a same-verdict reason change into a count, not drift", () => {
    const { r } = run([{ code: 200, name: "Pinned Out", status: "exclude", reason: "prerelease" }]);
    expect(r.drift).toHaveLength(0);
    expect(r.reasonOnly).toBe(1);
  });

  it("exposes the include set the card database is built from", () => {
    expect(includedCodes(ledger())).toEqual(new Set([100]));
  });
});

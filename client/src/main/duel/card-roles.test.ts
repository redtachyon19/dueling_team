import { describe, it, expect } from "vitest";
import { classifyScript, setCardRoles, getRoles, isDisruption, isHandtrap } from "./card-roles.ts";

describe("classifyScript (Lua effect-role mining)", () => {
  it("flags negate + handtrap for a quick hand effect that negates", () => {
    const src = "e1:SetType(EFFECT_TYPE_QUICK_O) e1:SetRange(LOCATION_HAND) Duel.NegateEffect(ev)";
    expect(classifyScript(src)).toEqual(expect.arrayContaining(["negate", "handtrap"]));
  });
  it("flags a searcher", () => {
    expect(classifyScript("Duel.SearchMatchingCard(...) Duel.SendtoHand(...)")).toContain("search");
  });
  it("flags draw and special summon", () => {
    expect(classifyScript("Duel.Draw(p,2,REASON_EFFECT)")).toContain("draw");
    expect(classifyScript("Duel.SpecialSummon(c,0,...)")).toContain("spsummon");
  });
  it("returns no roles for an effectless / vanilla script", () => {
    expect(classifyScript("-- nothing interesting\nlocal s = c:GetCode()")).toEqual([]);
  });
  it("does NOT call a plain searcher a handtrap (needs hand + quick + interaction)", () => {
    expect(classifyScript("Duel.SearchMatchingCard(...)")).not.toContain("handtrap");
  });
});

describe("runtime role lookup", () => {
  it("round-trips roles and derives disruption / handtrap", () => {
    setCardRoles({ "111": ["negate"], "222": ["handtrap", "draw"], "333": ["floodgate"], "444": ["search"] });
    try {
      expect(getRoles(111)).toEqual(["negate"]);
      expect(isDisruption(111)).toBe(true); // negate
      expect(isDisruption(333)).toBe(true); // floodgate
      expect(isDisruption(444)).toBe(false); // a searcher is not disruption
      expect(isHandtrap(222)).toBe(true);
      expect(getRoles(999)).toEqual([]); // unknown code
    } finally {
      setCardRoles({}); // reset so other suites see no roles
    }
  });
});

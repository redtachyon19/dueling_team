import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { Cards } from "./pages/Cards";
import { Deck } from "./pages/Deck";
import { Duel } from "./pages/Duel";
import { Social } from "./pages/Social";
import { Settings } from "./pages/Settings";
import { TabActiveContext } from "./tab-active.ts";

const TABS = ["Home", "Cards", "Deck", "Duel", "Social"] as const;
type Tab = (typeof TABS)[number];
type View = Tab | "Settings";

const PAGES: Record<Tab, () => JSX.Element> = {
  Home,
  Cards,
  Deck,
  Duel,
  Social,
};

function GearIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function App(): JSX.Element {
  const [active, setActive] = useState<View>("Home");
  const Page = active === "Settings" ? Settings : PAGES[active];

  // The Duel page is kept mounted once visited and merely hidden when you
  // switch tabs. Unmounting it runs DuelBoard's cleanup, which calls
  // match.end() and kills a duel in progress — so browsing to Cards or Settings
  // mid-duel used to forfeit the game.
  const [duelMounted, setDuelMounted] = useState(false);
  useEffect(() => {
    if (active === "Duel") setDuelMounted(true);
  }, [active]);
  const duelVisible = active === "Duel";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < TABS.length) {
        e.preventDefault();
        setActive(TABS[i]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <nav className="tabs" role="tablist" aria-label="Primary">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={active === t}
            className={`tab${active === t ? " tab--active" : ""}`}
            onClick={() => setActive(t)}
          >
            {t}
          </button>
        ))}
        <button
          type="button"
          aria-label="Settings"
          aria-selected={active === "Settings"}
          className={`tab-icon${active === "Settings" ? " tab-icon--active" : ""}`}
          onClick={() => setActive("Settings")}
        >
          <GearIcon />
        </button>
      </nav>
      <main className={`page${duelVisible ? " page--duel" : ""}`} role="tabpanel" aria-label={active}>
        {!duelVisible && (
          <TabActiveContext.Provider value={true}>
            <Page />
          </TabActiveContext.Provider>
        )}
        {duelMounted && (
          <div className={`page__layer${duelVisible ? "" : " page__layer--hidden"}`} aria-hidden={!duelVisible}>
            <TabActiveContext.Provider value={duelVisible}>
              <Duel />
            </TabActiveContext.Provider>
          </div>
        )}
      </main>
    </div>
  );
}

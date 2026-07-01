// client/src/renderer/pages/Settings.tsx
//
// Settings page, reached from the gear icon at the right of the nav bar.
// App info plus gesture references.

type Gesture = { keys: string[]; action: string };

/** Deck-builder gestures. Keep in sync with the handlers in pages/Deck.tsx. */
const DECK_GESTURES: Gesture[] = [
  { keys: ["Hover"], action: "Preview a card in the viewer" },
  { keys: ["Click"], action: "Pin a card to the viewer (click again to unpin)" },
  { keys: ["Shift", "Click"], action: "Extend the selection to a range of cards" },
  { keys: ["Double-click"], action: "Add a search-pool card to the deck" },
  { keys: ["Arrow keys"], action: "Move the selection between cards" },
  { keys: ["Shift", "Arrow keys"], action: "Select multiple cards (extend the range)" },
  { keys: ["Enter"], action: "Add the selected pool cards to the deck" },
  { keys: ["Delete / Backspace"], action: "Remove the selected cards from the deck" },
  { keys: ["Esc"], action: "Clear the current selection" },
  { keys: ["Drag pool card", "→ a zone"], action: "Add the card to the deck" },
  { keys: ["Drag deck card", "→ another zone"], action: "Move it between Main / Extra / Side" },
  { keys: ["Drag deck card", "within a zone"], action: "Reorder it (drop where you want it)" },
  { keys: ["Drag a card", "out of the deck"], action: "Remove it instantly" },
  { keys: ["Drag a selection"], action: "Add / move / remove every selected card at once" },
];

/** In-duel gestures. Keep in sync with the gesture handlers in pages/DuelBoard.tsx. */
const DUEL_GESTURES: Gesture[] = [
  { keys: ["Hold deck 3s"], action: "Surrender the duel" },
  { keys: ["Drag spell/trap", "→ Spell/Trap zone"], action: "Activate the card" },
  { keys: ["Shift", "Drag spell/trap", "→ Spell/Trap zone"], action: "Set the card face-down" },
  { keys: ["Drag monster", "→ field"], action: "Normal Summon (or Special Summon if that's its only play)" },
  { keys: ["Shift", "Drag monster", "→ field"], action: "Set the monster face-down" },
  { keys: ["⌘ / Ctrl", "Drag monster", "→ field"], action: "Special Summon (if its conditions are met)" },
  { keys: ["Click Extra Deck card"], action: "Special Summon from the Extra Deck (when summonable)" },
  { keys: ["Click Graveyard / Banished"], action: "Browse that pile's cards" },
  { keys: ["G"], action: "Open / close your Graveyard" },
  { keys: ["Space"], action: "On a response prompt — respond / activate (Yes)" },
  { keys: ["Shift"], action: "On a response prompt — No Response / decline (auto after 5s)" },
  { keys: ["Esc"], action: "Cancel the current action / close a popup" },
];

function GestureList({ items }: { items: Gesture[] }): JSX.Element {
  return (
    <ul className="settings__gestures">
      {items.map((g) => (
        <li key={g.action} className="settings__gesture">
          <span className="settings__gesture-keys">
            {g.keys.map((k, i) => (
              <kbd key={i} className="settings__kbd">{k}</kbd>
            ))}
          </span>
          <span className="settings__gesture-action">{g.action}</span>
        </li>
      ))}
    </ul>
  );
}

export function Settings(): JSX.Element {
  const version = window.duel?.version ?? "—";
  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="settings__section">
        <h2 className="settings__heading">About</h2>
        <dl className="settings__about">
          <dt>App</dt>
          <dd>Dueling Team</dd>
          <dt>Version</dt>
          <dd>{version}</dd>
        </dl>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Deck Builder Gestures</h2>
        <GestureList items={DECK_GESTURES} />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Duel Gestures</h2>
        <GestureList items={DUEL_GESTURES} />
      </section>

      <p className="settings__note">More settings coming soon.</p>
    </div>
  );
}

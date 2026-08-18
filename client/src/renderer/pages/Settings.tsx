import { LIMITS, DEFAULTS, useSettings, writeSetting, type AppSettings } from "../settings.ts";

type Gesture = { keys: string[]; action: string };

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

function Slider({ setting, label, hint, format }: {
  setting: keyof AppSettings;
  label: string;
  hint: string;
  format: (v: number) => string;
}): JSX.Element {
  const value = useSettings()[setting];
  const { min, max, step } = LIMITS[setting];
  return (
    <div className="settings__row">
      <div className="settings__row-text">
        <label className="settings__label" htmlFor={setting}>{label}</label>
        <p className="settings__hint">{hint}</p>
      </div>
      <div className="settings__control">
        <input
          id={setting}
          className="settings__range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => writeSetting(setting, Number(e.target.value))}
        />
        <span className="settings__value">{format(value)}</span>
        <button
          className="btn settings__reset"
          type="button"
          onClick={() => writeSetting(setting, DEFAULTS[setting])}
          disabled={value === DEFAULTS[setting]}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export function Settings(): JSX.Element {
  const version = window.duel?.version ?? "—";
  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="settings__section">
        <h2 className="settings__heading">Duel Board</h2>
        <div className="settings__rows">
          <Slider
            setting="boardScale"
            label="Field size"
            hint="Zooms the whole field — zones, cards, piles and counters all scale together. Above 100% the board can run past the window edges."
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Slider
            setting="deckThickness"
            label="Deck thickness"
            hint="How tall the deck, extra deck, graveyard and banished piles stand. 100% is a real card's thickness (0.305 mm); higher just makes the stacks taller."
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Slider
            setting="boardTilt"
            label="Board tilt"
            hint="How far the field leans away from you. 0° is flat top-down; 90° is fully edge-on."
            format={(v) => `${v}°`}
          />
          <Slider
            setting="boardShiftX"
            label="Board position — horizontal"
            hint="Nudges the field left or right within the window. 0 keeps it centred."
            format={(v) => `${v > 0 ? "+" : ""}${v} px`}
          />
          <Slider
            setting="boardShiftY"
            label="Board position — vertical"
            hint="Nudges the field up or down within the window. 0 keeps it centred."
            format={(v) => `${v > 0 ? "+" : ""}${v} px`}
          />
        </div>
      </section>

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

    </div>
  );
}

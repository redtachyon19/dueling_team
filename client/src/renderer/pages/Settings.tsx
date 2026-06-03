// client/src/renderer/pages/Settings.tsx
//
// Settings page, reached from the gear icon at the right of the nav bar.
// Scaffold for now — app info plus room for future preferences.

/** In-duel gestures, shown as a reference list on the Settings page. Keep this
 *  in sync with the gesture handlers in pages/DuelBoard.tsx. */
const GESTURES: { keys: string[]; action: string }[] = [
  { keys: ["Hold deck 3s"], action: "Surrender the duel" },
  { keys: ["Drag spell/trap", "→ Spell/Trap zone"], action: "Activate the card" },
  { keys: ["Shift", "Drag spell/trap", "→ Spell/Trap zone"], action: "Set the card face-down" },
  { keys: ["Drag monster", "→ field"], action: "Normal Summon" },
  { keys: ["Shift", "Drag monster", "→ field"], action: "Set the monster face-down" },
  { keys: ["⌘ / Ctrl", "Drag monster", "→ field"], action: "Special Summon (if applicable)" },
];

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
        <h2 className="settings__heading">Gestures</h2>
        <ul className="settings__gestures">
          {GESTURES.map((g) => (
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
      </section>

      <p className="settings__note">More settings coming soon.</p>
    </div>
  );
}

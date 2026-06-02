// client/src/renderer/pages/Settings.tsx
//
// Settings page, reached from the gear icon at the right of the nav bar.
// Scaffold for now — app info plus room for future preferences.

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

      <p className="settings__note">More settings coming soon.</p>
    </div>
  );
}

# Dueling Team

A local-first Yu-Gi-Oh-style TCG simulator. Portfolio project, non-commercial,
friends-only. The IP is not mine — there's no pricing, accounts, ranked play,
monetization, or anti-cheat anywhere in scope. **TCG format only**; OCG is out
of scope.

## Architecture principles

These are binding, not aspirational.

1. **Local-first.** Solo play runs fully offline. Online play with friends is
   an optional thin layer added later.
2. **No external API calls at runtime, ever.** External card data sources are
   touched only by manual build-time scripts in `scripts/`, which write into
   `assets/konami/` (gitignored). If the upstream source disappears, what's
   already on disk keeps working.
3. **Konami IP is isolated.** Every piece of Konami's intellectual property —
   card data, card art, card text, banlists, Genesys lists, set lists, set
   images, card frame templates — lives under a single folder, `assets/konami/`,
   which is gitignored. Nothing inside `assets/konami/` is mine; nothing of
   mine lives inside it. The boundary is visible at a glance.
4. **One engine, never duplicated.** The engine is a pure, dependency-free
   TypeScript package — `(State, Command) -> State`, no I/O, no networking,
   no UI, no storage.
5. **Command-sourced state.** The whole game is reconstructible from
   `seed + ordered Command log`. Replays, saves, and reconnect are the same
   mechanism.
6. **Narrow, frozen contracts in `shared`.** `State`, the `Command` union, the
   socket protocol, the AI interface `(redactedState) => Command`, and the
   card-data shape all live in `@duel/shared`. Everything else depends on it;
   it depends on nothing.

## Package layout

| Package           | Role                                                      |
| ----------------- | --------------------------------------------------------- |
| `shared/`         | Types + protocol only. Zero runtime deps.                 |
| `engine/`         | Pure rules engine. Depends only on `shared`.              |
| `ai/`             | Opponent AI. Consumes redacted state, returns a `Command`.|
| `ui/`             | Presentational components, no game logic.                 |
| `client/`         | The Electron app (main + preload + renderer). Wires engine + ai + ui + local-backend. |
| `local-backend/`  | Local saves, decks, settings.                             |
| `relay-server/`   | Optional thin relay for friends-only online play.         |

Top-level:

- `scripts/` — build-time importers. Manual only. Never imported by the
  running app.
  - `import-cards.ts` — TCG card database
  - `import-sets.ts` — boosters, structure decks, starter decks, promos
  - `update-banlists.ts` — every TCG banlist revision (append-only)
  - `update-genesys.ts` — every Genesys list revision (append-only)
  - `build-image-pack.ts` — card art + set logos/box art
- `assets/konami/` — **gitignored. Konami IP only, TCG only.** Single
  isolation folder for everything Konami-owned. Populated by the scripts
  above. Layout:
  ```
  assets/konami/
  ├── cards/{db.json, images/{id}.jpg}
  ├── banlists/{index.json, YYYY-MM-DD.json}
  ├── genesys/{index.json, YYYY-MM-DD.json}
  ├── sets/{index.json, boosters/, structure-decks/,
  │          starter-decks/, promotional/, images/}
  └── templates/{attributes, backgrounds, fonts, icons, other}
  ```

## Getting started

```bash
pnpm install
pnpm typecheck
pnpm test
```

Refresh local Konami data (manual, build-time only — all writes land in
`assets/konami/`, none of it is committed):

```bash
pnpm import:cards
pnpm import:sets
pnpm import:banlists   # archives every historical TCG banlist revision
pnpm import:genesys    # archives every historical Genesys list revision
pnpm build:images
```

Run the Electron app:

```bash
pnpm dev
```

This launches `client/` via `electron-vite`: main process + preload + renderer
with HMR for the React UI. There is intentionally **no separate browser/web
build** — the renderer is Electron-only and lives in one place. Launching
opens the window with the five primary tabs: Home, Cards, Deck, Duel, Social.

## Status

Scaffold only. First milestone is a complete vanilla-monster duel through the
engine — tracked by `engine/test/vanilla-duel.test.ts`.

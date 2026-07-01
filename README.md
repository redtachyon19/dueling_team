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

## Duel engine (ygopro-core / ocgcore)

The duel rules engine is **ygopro-core (ocgcore)** — the real EDOPro C++/Lua
engine — via the prebuilt WASM package `@n1xx1/ocgcore-wasm` (sync mode). It
runs in the **main process** and is the authoritative source of rules and board
truth. This intentionally supersedes the "pure dependency-free TS engine"
principle for the duel itself; the spirit is preserved by keeping `engine/` a
pure, tested projection layer:

- **`assets/ocg/`** (build-time, `pnpm import:ocg`): the Lua `script/` library
  (ProjectIgnis CardScripts) + `carddata.json` (decoded from ProjectIgnis
  BabelCDB). Local-only, like the rest of `assets/`; no network at runtime.
- **`client/src/main/duel/`**: hosts ocgcore — loads the core, drives the
  process/message/response loop, queries the board, and translates to the
  `@duel/shared` contracts (`DuelState` / `DuelEvent` / `DuelPrompt`). Goldfish
  mode auto-passes the opponent.
- **`engine/`**: pure `(DuelState, DuelEvent) -> DuelState` reducer + phase/
  position decoders, unit-tested by `engine/test/vanilla-duel.test.ts`.
- **`client/src/renderer/pages/Duel*.tsx`**: the board UI, driven entirely by
  the `window.duel.match` IPC stream.

## Online play (friends-only)

An optional thin layer over the local game. Both players connect to a relay by
room code; the **host machine runs the relay automatically**, so there's nothing
extra to launch for the common case.

1. In the app's **Duel → Online Play**: the **host** picks a deck + format and
   creates a room (gets a code). Hosting spins up an in-process relay on
   `:41923` (bound to `0.0.0.0`), so the host needs that port reachable from the
   guest — on the same LAN directly, or over the internet with the port
   forwarded.

2. The **guest** enters the host's address + the room code and joins with their
   deck. (Same machine for both? Leave the relay address at `127.0.0.1`.)

Prefer a dedicated/neutral relay box instead of the host's machine? Run one
manually and point both players at its address:

```
pnpm --filter @duel/relay-server start        # listens on :41923
```

The host only auto-starts a relay when the relay address is local; a non-local
address connects to that relay instead.

The **host** runs ocgcore as the rules authority; the **guest** is a thin client
with no game logic. The host sends each player only their own redacted view, so a
player never receives the opponent's hand, face-downs, or Extra Deck. The relay
forwards messages verbatim and never runs game logic or holds any Konami data —
keeping online play consistent with the IP-isolation rule above.

## Status

Playable goldfish duel plus the **DuelBot** AI opponent and friends-only online
play. Draw, Normal/Tribute Summon/Set, position, battle, Spell/Trap and Pendulum,
and Fusion/Synchro/Xyz/Link all run end-to-end through ocgcore, in both Advanced
and Genesys formats.

The opponent picker offers **Goldfish** (passes on everything) or **DuelBot**.
DuelBot is driven by `client/src/main/duel/`:

- An evaluation-driven brain (`ai.ts`): a learnable linear board evaluation
  (`evaluate`/`features`) that is **effect- and role-aware** — beyond LP / card
  advantage / board power it counts effect monsters, Extra-Deck bosses,
  **disruption** (negate/floodgate) monsters, hand-traps held in hand, and
  archetype **cohesion**, so a combo end-board (e.g. an omni-negate) outscores a
  stat-equal pile of vanillas, for any deck. Card roles come from a build-time
  classifier (`pnpm classify:roles`) that mines the local ProjectIgnis Lua
  scripts into `assets/ocg/card-roles.json` (negate / handtrap / searcher / …).
  Plus strategic posture, lethal detection, and proactive Main-Phase effect
  **activation** (`m.activates`) — the prerequisite for playing combo decks.
- **Real-time opponent adaptation** (`opponent-model.ts`): reads the opponent
  from PUBLIC info only (graveyard, board, revealed roles/archetype, open
  backrow, hand size — never peeking at hidden cards) into a 0–1 disruption-risk
  estimate, and adapts to the specific opponent as the game reveals it — it holds
  non-essential attacks into a loaded control opponent and presses a tapped-out
  one (risk-graded combat), and practises **over-extension control**: against a
  likely board-breaker the search stops committing bodies to the board sooner
  (holds combo pieces back) rather than dumping everything into a wipe. The
  search leaves are scored by a **survival-adjusted** value — it enumerates the
  opponent's plausible disruption (wipe / removal / negate, from the public
  belief model) and weights a line by how much of it *survives*, so it prefers
  boards that don't fold to the opponent's likely interaction. And it **times**
  its own traps/quick-effects — spending them on a real board threat (or when
  behind) rather than at the first opening, holding them against a quiet board.
- **Within-turn forward search** (`search.ts` + `resim.ts`): for each Main-Phase
  decision it re-simulates candidate lines on a separate ocgcore instance
  (replaying a recorded response log, since the binding has no `duelDuplicate`)
  and scores the resulting board with `evaluate()`, under a wall-clock budget —
  so it *sequences* combos rather than greedily taking one action. Falls back to
  the heuristic when the budget trips or a replay check fails.
- Build-time tools (manual, never imported by the app): `pnpm classify:roles`
  mines card roles from the Lua scripts; `pnpm train:ai` tunes the evaluation
  weights from self-play across a diverse corpus — synthetic flavors + real
  **archetype decks** built from `setcodes` + any `.ydk` decks in `decks/`
  (`deck-pool.ts`) — regularized toward the hand-tuned priors, and only ships the
  result (`assets/ai/eval-weights.json`) if it **beats the defaults** in a
  search-vs-search measurement (so training can never regress the bot; today it
  doesn't beat the well-tuned priors, so the defaults stay); `pnpm verify:search
  [deck.ydk]` checks replay fidelity and measures search vs. the heuristic.

Known limits: the search is 1-ply greedy-to-quiescence (no deep beam yet); the
role classifier is a Lua-text heuristic (some false positives, and it can't
grade a negate's *strength* — omni-negate vs. one-time); opponent play-around is
survival-adjusted *evaluation* from a public belief model (not true card-level
determinization — infeasible to inject sampled cards mid-game, and using the
opponent's real hidden cards would be cheating); and it runs on the synchronous
driver behind a ~120 ms budget (a Worker offload is the planned escape hatch).

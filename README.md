# Dueling Team

A local-first Yu-Gi-Oh-style TCG simulator. Portfolio project, non-commercial,
friends-only. The IP is not mine — there's no pricing, accounts, ranked play,
monetization, or anti-cheat anywhere in scope. **TCG format only**; OCG is out of
scope, and so is anything not yet released.

**This repo is private and must stay private.** It carries Konami card data, card
text and art. Never push it to a public mirror.

---

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test
```

A fresh clone has an **empty `assets/`** — it holds only gitignored, rebuildable
files. The app cannot run a duel until the engine data is fetched:

```bash
pnpm import:ocg      # card effects + engine card data (required)
pnpm build:images    # card art (optional; tiles fall back to a card back)
```

Then:

```bash
pnpm dev
```

That launches `client/` via `electron-vite` — main process + preload + renderer
with HMR for the React UI. There is intentionally **no browser/web build**; the
renderer is Electron-only. The window opens on five tabs: **Home, Cards, Deck,
Duel, Social**.

---

## How the repo is split

There is exactly one rule, and it is the gitignore boundary:

> **Everything gitignored lives in `assets/`, and nothing outside `assets/` is
> ignored.**

So the disposable half of the repo is one folder you can delete and rebuild.

### `assets/` — disposable, gitignored (~4.3 GB)

```
assets/
├── cards/{passcode}.jpg   full card art          ┐ pnpm build:images
├── art/{passcode}.jpg     cropped artwork        │
├── sets/                  set logos + box art    ┘ pnpm build:set-images
└── ocgcore/                                        pnpm import:ocg
    ├── script/*.lua       the card effects (~22.6k files, ~93 MB)
    ├── carddata.json      numeric card data the core loads (no card text)
    └── card-roles.json    optional, from `pnpm classify:roles`
```

Nothing here is hand-edited and nothing is permanent.

### `engine/` — the data, tracked

| Path | What |
| ---- | ---- |
| `engine/cards/ledger.json` | **Single source of truth for the card pool** — every passcode ever seen, `include` or `exclude`, with a reason. See [The card ledger](#the-card-ledger). |
| `engine/cards/db.json` | The card database, built from the ledger's `include` set. |
| `engine/sets/` | Set database + manifest. |
| `engine/banlists/`, `engine/genesys/` | Append-only archives, one immutable `YYYY-MM-DD.json` per revision. |
| `engine/ocgcore.lock.json` | The exact ProjectIgnis commits `assets/ocgcore/` is rebuilt from. 4 KB that makes 93 MB of Lua safe to throw away. |
| `engine/src/`, `engine/test/` | The pure projection layer (see [Duel engine](#duel-engine-ygopro-core--ocgcore)). |

The banlist and Genesys archives are the **one category that cannot be
re-downloaded** — upstream publishes only the *current* list, so a lost revision
is gone for good. Everything else here is regenerable; it is tracked because it
is what every script and the app resolve against.

### `ui/assets/` — hand-made, tracked

Card-frame templates (attributes, backgrounds, icons, borders), card sleeves,
Yu-Gi-Oh fonts, logos. No script can re-download these, and the renderer imports
a sleeve at build time, so losing them breaks the build rather than leaving a
blank tile.

---

## Packages

| Package | Role | State |
| ------- | ---- | ----- |
| `shared/` | Types + protocol only. Zero runtime deps. | ~580 lines |
| `engine/` | Pure `(DuelState, DuelEvent) -> DuelState` reducer + phase/position decoders. | ~140 lines |
| `client/` | The Electron app: main + preload + renderer. Hosts ocgcore, DuelBot, and the whole UI. | ~10.6k lines — **where the work is** |
| `local-backend/` | Local saves, decks, settings. | small |
| `relay-server/` | Thin relay for friends-only online play. | small |
| `ai/` | **Placeholder** (`export {}`). DuelBot actually lives in `client/src/main/duel/`. | stub |
| `ui/` | **Placeholder** (`export {}`) for shared presentational components. Only `ui/assets/` is real today. | stub |

`ai/` and `ui/` are reserved names in the workspace, not working packages — don't
go looking for the AI in `ai/`.

---

## The data pipeline

All importers are **manual, build-time only** and live in `scripts/`. They are
never imported by the running app, and they are the only place in the project
allowed to touch the network. The app reads local files and never fetches.

```bash
pnpm import:cards      # card database ← YGOPRODeck + Yugipedia
pnpm import:sets       # set database  ← YGOPRODeck + Yugipedia
pnpm import:banlists   # every historical TCG banlist revision (append-only)
pnpm import:genesys    # current Genesys points list (Konami official)
pnpm import:ocg        # Lua card effects + carddata ← ProjectIgnis
pnpm build:images      # card art, cropped art, set logos ← YGOPRODeck
pnpm build:set-images  # official box art ← yugioh-card.com
```

`pnpm refresh` chains the common three: `import:cards && import:ocg &&
check:scripts`.

**TCG only, released only.** `import:cards` and `import:sets` drop anything whose
TCG release date is still in the future — an announced-but-unshipped set has no
official English text, so upstream carries a fan translation of the OCG print.
`--include-unreleased` on either overrides it.

**Sources worth knowing about:**

- `import:genesys` scrapes Konami's official Genesys page, which publishes the
  current list in full as an HTML table. The third-party API this script used to
  read has drifted badly and is no longer trusted.
- `import:genesys:history` still anchors on that drifted API and **rewrites every
  dated snapshot**. Do not re-run it without re-verifying the anchor — see the
  warning at the top of the script.
- `import:ocg` reproduces the commits pinned in `engine/ocgcore.lock.json`, so it
  is byte-identical every time. `--latest` bumps both upstreams and re-pins.
  Don't pass a commit SHA to `--ref`: it applies to both repos, and a SHA exists
  in only one of them.
- `build:set-images` scrapes a site with a WAF. It is deliberately slow
  (1 request at a time) and resumable; use `--codes=CORI,LAVD` after a new set
  drops rather than re-walking all ~650 product pages.

---

## The card ledger

`engine/cards/ledger.json` decides what is in the game.

Upstream offers ~14.5k cards from YGOPRODeck and ~24.7k rows from ProjectIgnis's
BabelCDB. Roughly **10.4k of those are excluded** — Rush Duel, anime/manga-only
cards, Speed Duel Skills, OCG exclusives, Goat entries, prereleases, unreleased
sets. The ledger lists every one of them individually, by passcode, with a name
and a reason.

It exists because those decisions used to be re-derived on every run from live
upstream state — a Yugipedia query, a `.cdb` filename, a release date. The same
command could quietly produce a different pool on a different day: one flaky
response and a legitimate TCG card disappears from the app with nothing to point
at. Now each decision is frozen the first time it is made, and the pool changes
only when the ledger changes — as a reviewable diff.

`db.json` is built from the ledger's `include` set, so the ledger is not a report
*about* the pipeline; it *is* the pipeline's input.

**Reasons:** `tcg` (included), `ocg-only`, `skill-card`, `rush-duel`,
`anime-unofficial`, `goat`, `prerelease`, `unreleased`, `manual`.

**How a run reconciles:**

| Situation | What happens |
| --------- | ------------ |
| Passcode not in the ledger | Classified, recorded, and listed in the run output. `--strict` holds it out of the pool until you accept it. |
| Passcode already in the ledger | **The ledger wins.** Upstream disagreeing is reported as drift, not applied. |
| `"locked": true` | Hand-pinned. No import can ever move it. |
| Reason is `unreleased` | Re-derived every run — otherwise a card would stay excluded forever once its set finally shipped. |
| Passcode vanishes upstream | Reported and **kept**. Silent disappearance is the exact failure this guards against. |

**Query it:**

```bash
pnpm ledger                     # totals by reason
pnpm ledger 91025875            # why is this passcode in or out?
pnpm ledger "Blue-Eyes"         # by name
pnpm ledger --reason=rush-duel  # everything under one reason
```

To force a card in or out regardless of upstream, move its entry between
`include` and `exclude` and set `"locked": true`. The reconciliation rules are
unit-tested in `scripts/ledger.test.ts` (`pnpm test:scripts`).

---

## Duel engine (ygopro-core / ocgcore)

The rules engine is **ygopro-core (ocgcore)** — the real EDOPro C++/Lua engine —
via the prebuilt WASM package `@n1xx1/ocgcore-wasm` (sync mode). It runs in the
**main process** and is the authoritative source of rules and board truth.

This deliberately supersedes the "pure dependency-free TS engine" idea for the
duel itself; the spirit survives by keeping `engine/` a pure, tested projection
layer.

- **`assets/ocgcore/`** — the Lua `script/` library (ProjectIgnis CardScripts) +
  `carddata.json` (decoded from BabelCDB with the `sqlite3` CLI, so no SQLite
  dependency ships at runtime). Gitignored; rebuilt from the lockfile. Scope is
  the TCG card game: BabelCDB's Rush Duel, anime/video-game, Speed Duel Skill,
  Goat and prerelease files are skipped — except for codes our pool actually
  references, since the World Championship promos are real TCG prints filed under
  placeholder passcodes.
- **`client/src/main/duel/`** — hosts ocgcore: loads the core, drives the
  process/message/response loop, queries the board, and translates to the
  `@duel/shared` contracts (`DuelState` / `DuelEvent` / `DuelPrompt`).
- **`engine/src`** — the pure reducer + decoders, unit-tested by
  `engine/test/vanilla-duel.test.ts`.
- **`client/src/renderer/pages/Duel*.tsx`** — the board UI, driven entirely by
  the `window.duel.match` IPC stream.

`pnpm check:scripts` reports any card in `db.json` the engine data can't
represent — missing `carddata` (won't load at all) or a missing Lua script (loads
but its effects can't resolve). It also flags whether any gap lands on the
current Genesys list.

---

## The app

**Cards** — browse the full pool. Free-text search over name, set code and card
text, plus category/attribute/type/frame/archetype/level filters. The grid sorts
by **Newest** release by default; the Sort control also offers Best match (text
relevance), Name, Type, ATK, DEF and Level. Alternate artworks each get their own
tile. Drill into a card, a set, an archetype, or the full set list.

**Deck** — deck editor with its own filtered card pool, `.ydk` import/export, PNG
export, and format validation against the TCG banlist or a Genesys points list
(Genesys enforces the point cap and rejects Link/Pendulum monsters).

**Duel** — solo play against **Goldfish** (passes on everything) or **DuelBot**,
in Advanced or Genesys format, plus online play.

---

## DuelBot

DuelBot lives in `client/src/main/duel/`:

- **Evaluation-driven brain** (`ai.ts`): a learnable linear board evaluation
  (`evaluate`/`features`) that is **effect- and role-aware** — beyond LP / card
  advantage / board power it counts effect monsters, Extra-Deck bosses,
  **disruption** (negate/floodgate) monsters, hand-traps held in hand, and
  archetype **cohesion**, so a combo end-board (an omni-negate, say) outscores a
  stat-equal pile of vanillas, for any deck. Card roles come from a build-time
  classifier (`pnpm classify:roles`) that mines the local Lua scripts into
  `assets/ocgcore/card-roles.json` (negate / handtrap / searcher / …). Plus
  strategic posture, lethal detection, and proactive Main-Phase effect
  **activation** — the prerequisite for playing combo decks.
- **Real-time opponent adaptation** (`opponent-model.ts`): reads the opponent
  from PUBLIC info only (graveyard, board, revealed roles/archetype, open
  backrow, hand size — never peeking at hidden cards) into a 0–1 disruption-risk
  estimate. It holds non-essential attacks into a loaded control opponent and
  presses a tapped-out one, and practises **over-extension control**: against a
  likely board-breaker the search stops committing bodies sooner rather than
  dumping everything into a wipe. Search leaves are scored by a
  **survival-adjusted** value — it enumerates the opponent's plausible disruption
  and weights a line by how much of it *survives*. It also **times** its own
  traps and quick-effects, spending them on a real threat rather than at the
  first opening.
- **Within-turn forward search** (`search.ts` + `resim.ts`): for each Main-Phase
  decision it re-simulates candidate lines on a separate ocgcore instance
  (replaying a recorded response log, since the binding has no `duelDuplicate`)
  and scores the resulting board with `evaluate()`, under a wall-clock budget —
  so it *sequences* combos instead of greedily taking one action. Falls back to
  the heuristic when the budget trips or a replay check fails.
- **Build-time tools** (manual, never imported by the app): `pnpm classify:roles`
  mines card roles from the Lua scripts; `pnpm train:ai` tunes the evaluation
  weights from self-play across synthetic flavours + real archetype decks built
  from `setcodes` and any `.ydk` in `decks/`, regularized toward the hand-tuned
  priors — and only ships the result (`assets/ai/eval-weights.json`) if it
  **beats the defaults** in a search-vs-search measurement, so training can never
  regress the bot. Today it doesn't beat the priors, so the defaults stay.
  `pnpm verify:search [deck.ydk]` checks replay fidelity and measures search vs.
  the heuristic.

**Known limits:** the search is 1-ply greedy-to-quiescence (no deep beam yet);
the role classifier is a Lua-text heuristic with some false positives, and it
can't grade a negate's *strength* (omni-negate vs. one-time); play-around is
survival-adjusted *evaluation* from a public belief model, not true card-level
determinization (injecting sampled cards mid-game is infeasible, and using the
opponent's real hidden cards would be cheating); and it runs on the synchronous
driver behind a ~120 ms budget, with a Worker offload as the planned escape
hatch.

---

## Online play (friends-only)

A thin layer over the local game. Both players connect to a relay by room code;
the **host machine runs the relay automatically**, so there's nothing extra to
launch in the common case.

1. In **Duel → Online Play**, the **host** picks a deck + format and creates a
   room, getting a code. Hosting spins up an in-process relay on `:41923` (bound
   to `0.0.0.0`), so that port must be reachable from the guest — same LAN
   directly, or over the internet with the port forwarded.
2. The **guest** enters the host's address + room code and joins with their deck.
   (Both on one machine? Leave the relay address at `127.0.0.1`.)

Prefer a neutral relay box? Run one and point both players at it:

```bash
pnpm --filter @duel/relay-server start   # listens on :41923
```

The host only auto-starts a relay when the relay address is local; a non-local
address connects to that relay instead.

The **host** runs ocgcore as the rules authority; the **guest** is a thin client
with no game logic. The host sends each player only their own redacted view, so a
player never receives the opponent's hand, face-downs, or Extra Deck. The relay
forwards messages verbatim and never runs game logic or holds any Konami data.

---

## Architecture principles

Binding, not aspirational.

1. **Local-first.** Solo play runs fully offline. Online play is an optional thin
   layer.
2. **No external API calls at runtime, ever.** External sources are touched only
   by the manual build-time scripts. If an upstream disappears, what's on disk
   keeps working.
3. **Konami IP is isolated** to `assets/`, `engine/` and `ui/assets/`. Nothing in
   them is mine; nothing of mine lives inside them.
4. **One gitignore boundary.** Everything ignored is in `assets/`; nothing
   outside it is ignored. The disposable half of the repo is one folder.
5. **The ledger decides the card pool.** Not upstream, not a filter re-derived at
   runtime.
6. **Command-sourced state.** A game is reconstructible from `seed + ordered
   Command log`. Replays, saves and reconnect are the same mechanism.
7. **Narrow, frozen contracts in `shared`.** `DuelState`, the `Command` union,
   the socket protocol, and the card-data shape live in `@duel/shared`.
   Everything depends on it; it depends on nothing.

> Principle 3 has a caveat worth stating plainly: the ocgcore Lua scripts are
> ProjectIgnis's own third-party code, not Konami's publication. They live in
> `assets/ocgcore/` and are referenced by pinned commit rather than vendored into
> version control.

---

## Status

Playable goldfish duel plus the DuelBot opponent and friends-only online play.
Draw, Normal/Tribute Summon/Set, position, battle, Spell/Trap and Pendulum, and
Fusion/Synchro/Xyz/Link all run end-to-end through ocgcore, in both Advanced and
Genesys formats.

Current data on disk:

| | |
| --- | --- |
| Cards in the pool | 13,961 |
| Blacklisted passcodes | 10,388 |
| Sets | 655 |
| Banlist revisions | 81 |
| Genesys revisions | 9 (latest 2026-08-03, 751 cards) |
| Engine card data | 14,721 entries · ~22.6k Lua scripts |
| Cards the engine can't load | 3 (new LAVD cards, awaiting upstream scripts) |

---

## Command reference

| Command | What |
| ------- | ---- |
| `pnpm dev` | Run the Electron app |
| `pnpm test` | All package tests + the `scripts/` tests |
| `pnpm test:scripts` | Just the ledger/reconciliation tests |
| `pnpm typecheck` | Typecheck every package |
| `pnpm typecheck:scripts` | Typecheck `scripts/` |
| `pnpm build` | Build every package |
| `pnpm import:cards` | Card database (`--include-unreleased`, `--strict`, `--limit=N`) |
| `pnpm import:sets` | Set database (`--include-unreleased`) |
| `pnpm import:banlists` | TCG banlist archive |
| `pnpm import:genesys` | Current Genesys list |
| `pnpm import:ocg` | Engine data (`--latest`, `--ref=`, `--all-cdb`, `--strict`) |
| `pnpm refresh` | `import:cards && import:ocg && check:scripts` |
| `pnpm ledger` | Query the card ledger |
| `pnpm check:scripts` | Engine-data coverage report |
| `pnpm build:images` | Card art + set logos (`--force`, `--variant=`, `--concurrency=`) |
| `pnpm build:set-images` | Official box art (`--codes=`, `--limit=`) |
| `pnpm classify:roles` | Mine card roles from the Lua scripts |
| `pnpm train:ai` | Tune DuelBot's evaluation weights from self-play |
| `pnpm verify:search` | Check replay fidelity, measure search vs. heuristic |
| `pnpm verify:script` | Run a single card's Lua script in the core |
| `pnpm gen:script` | Draft a Lua script for an unscripted card (human-reviewed) |
| `pnpm fill:set` | Add a single missing card by set number |

// Duel contracts (the missing State/Command-style types).
//
// ocgcore (running in the main process) is the rules AUTHORITY. It projects the
// duel into three things the rest of the app consumes:
//   - DuelState  : the board, queried from the core each step (what to render)
//   - DuelEvent  : a normalized stream of things-that-happened (for animation/log)
//   - DuelPrompt : what the LOCAL player must answer right now (drives the UI)
// The renderer answers a prompt with a DuelResponse; the main-process host
// translates that back into the core's native response. No game logic lives in
// the renderer.

export type DuelPlayer = 0 | 1;

/** Face-up attack, face-up defense, or face-down (set). */
export type CardPosition = "atk" | "def" | "set";

/** A card as shown on the board (code is null when hidden from the viewer). */
export interface DuelCard {
  /** Sequence (index) within its zone/location, as ocgcore tracks it. */
  seq: number;
  /** Passcode, or null when face-down / hidden. */
  code: number | null;
  position: CardPosition;
  faceUp: boolean;
  atk?: number | null;
  def?: number | null;
  level?: number | null;
}

export interface DuelPlayerState {
  lp: number;
  hand: DuelCard[];
  /** Monster zones: 0–4 main + 5–6 Extra Monster Zones (length 7); null = empty. */
  monsters: (DuelCard | null)[];
  /** Main spell/trap zones (length 5); null = empty. */
  spells: (DuelCard | null)[];
  /** The field-spell zone card, or null when empty. */
  field: DuelCard | null;
  /** The owner's Extra Deck contents (face-up to its owner); empty for the opponent. */
  extra: DuelCard[];
  /** Full Graveyard contents (public), oldest→newest; for the pile browser. */
  grave: DuelCard[];
  /** Full Banished contents (public; face-down banished stay hidden). */
  banished: DuelCard[];
  graveCount: number;
  /** Passcode of the top (most recent) graveyard card, shown face-up; null when empty. */
  graveTop: number | null;
  banishCount: number;
  extraCount: number;
  deckCount: number;
}

export type DuelPhase =
  | "draw"
  | "standby"
  | "main1"
  | "battle"
  | "main2"
  | "end"
  | "unknown";

export interface DuelState {
  turn: number;
  turnPlayer: DuelPlayer;
  phase: DuelPhase;
  /** [local player (0), opponent (1)]. */
  players: [DuelPlayerState, DuelPlayerState];
  over: boolean;
  winner: DuelPlayer | null;
}

// --- Events (animation / log only; NOT the source of board truth) ----------
export type DuelEvent =
  | { kind: "draw"; player: DuelPlayer; count: number; codes: number[] }
  | { kind: "summon"; player: DuelPlayer; code: number; position: CardPosition }
  | { kind: "spellset"; player: DuelPlayer; code: number }
  | { kind: "move"; code: number }
  | { kind: "attack"; attacker: DuelPlayer; target: DuelPlayer | null }
  | { kind: "damage"; player: DuelPlayer; amount: number }
  | { kind: "recover"; player: DuelPlayer; amount: number }
  | { kind: "phase"; phase: DuelPhase }
  | { kind: "turn"; turn: number; player: DuelPlayer }
  | { kind: "win"; player: DuelPlayer }
  | { kind: "log"; text: string };

// --- Prompts (what the local player must answer) ----------------------------
/** A card referenced by a prompt (e.g. a selectable target / attacker). */
export interface PromptCard {
  /** Opaque ref the host understands; the renderer echoes it back to choose. */
  ref: string;
  code: number | null;
  location: string; // "hand" | "mzone" | "szone" | "grave" | ...
  seq: number;
  controller: DuelPlayer;
}

/** A clickable, labeled choice (menus, yes/no, option, position, place, chain). */
export interface DuelOption {
  id: string;
  label: string;
  /** Card this option acts on, if any (so the renderer can show its art). */
  code?: number | null;
  /** The acting card's board location ("hand" | "mzone" | "szone" | "fzone"),
   *  so the renderer can attach this action to the clicked card. Absent for
   *  global actions like entering the Battle Phase or ending the turn. */
  loc?: string;
  /** The acting card's sequence within `loc`. */
  seq?: number;
}

export type DuelPromptKind =
  | "idle"
  | "battle"
  | "selectCard"
  | "selectUnselect"
  | "selectPlace"
  | "selectPosition"
  | "selectChain"
  | "yesno"
  | "option"
  | "effectyn";

export interface DuelPrompt {
  /** Monotonic id; responses must cite it (stale responses are ignored). */
  id: number;
  player: DuelPlayer;
  kind: DuelPromptKind;
  title: string;
  /** Generic clickable choices (menus / yes-no / option / position / place / chain). */
  options: DuelOption[];
  /** Cards to highlight as selectable (selectCard / selectChain / battle). */
  cards?: PromptCard[];
  min?: number;
  max?: number;
  cancelable?: boolean;
}

export type DuelResponse =
  | { promptId: number; type: "option"; id: string }
  | { promptId: number; type: "cards"; refs: string[] }
  | { promptId: number; type: "cancel" };

// --- IPC payloads (main → renderer pushes; renderer → main calls) -----------
export interface DuelStartOptions {
  deckId: string;
  /** Goldfish: the opponent passes on everything. Defaults true. */
  goldfish?: boolean;
}

export interface DuelUpdate {
  state: DuelState;
  /** The pending prompt for the local player, or null while the core works. */
  prompt: DuelPrompt | null;
  /** Events since the previous update (for animation/log). */
  events: DuelEvent[];
}

export interface DuelStartResult {
  ok: boolean;
  error?: string;
  /** Passcodes in the deck that ocgcore has no data for (skipped). */
  unsupported?: number[];
}

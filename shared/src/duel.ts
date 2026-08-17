export type DuelPlayer = 0 | 1;

export type CardPosition = "atk" | "def" | "set";

export interface DuelCard {
  seq: number;
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
  monsters: (DuelCard | null)[];
  spells: (DuelCard | null)[];
  field: DuelCard | null;
  extra: DuelCard[];
  grave: DuelCard[];
  banished: DuelCard[];
  graveCount: number;
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
  players: [DuelPlayerState, DuelPlayerState];
  over: boolean;
  winner: DuelPlayer | null;
  winReason?: string | null;
}

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
  | { kind: "toss"; player: DuelPlayer; dice: boolean; results: number[] }
  | { kind: "log"; text: string };

export interface PromptCard {
  ref: string;
  code: number | null;
  location: string;
  seq: number;
  controller: DuelPlayer;
  max?: number;
}

export interface DuelOption {
  id: string;
  label: string;
  code?: number | null;
  loc?: string;
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
  | "effectyn"
  | "selectCounter"
  | "announce"
  | "announceCard";

export interface DuelPrompt {
  id: number;
  player: DuelPlayer;
  kind: DuelPromptKind;
  title: string;
  options: DuelOption[];
  cards?: PromptCard[];
  min?: number;
  max?: number;
  cancelable?: boolean;
}

export type DuelResponse =
  | { promptId: number; type: "option"; id: string }
  | { promptId: number; type: "cards"; refs: string[] }
  | { promptId: number; type: "counters"; counts: number[] }
  | { promptId: number; type: "cancel" };

export type DuelFormat = "advanced" | "genesys";

export type DuelDifficulty = "easy" | "normal" | "hard";

export interface DuelStartOptions {
  deckId: string;
  goldfish?: boolean;
  opponent?: "goldfish" | "ai";
  difficulty?: DuelDifficulty;
  aiDeckId?: string | undefined;
  format?: DuelFormat;
  seed?: string | undefined;
}

export interface DuelUpdate {
  state: DuelState;
  prompt: DuelPrompt | null;
  events: DuelEvent[];
}

export interface DuelStartResult {
  ok: boolean;
  error?: string;
  unsupported?: number[];
}

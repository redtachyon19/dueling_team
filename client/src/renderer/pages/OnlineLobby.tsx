import { useEffect, useRef, useState } from "react";
import type { DeckSummary, DuelFormat, NetStatus } from "@duel/shared";

/** Friends-only online lobby. Host a room (this client runs the duel) or join
 *  one by code. Both connect to a shared relay (default localhost — run the
 *  relay yourself and share its address with your friend). When the duel starts,
 *  `onPlay` hands off to the networked board. */
export function OnlineLobby({ onBack, onPlay }: { onBack: () => void; onPlay: (deckId: string, format: DuelFormat) => void }): JSX.Element {
  const [tab, setTab] = useState<"host" | "join">("host");
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [deckId, setDeckId] = useState("");
  const [relayHost, setRelayHost] = useState("127.0.0.1");
  const [relayPort, setRelayPort] = useState("41923");
  const [room, setRoom] = useState("");
  const [format, setFormat] = useState<DuelFormat>("advanced");
  const [seed, setSeed] = useState("");
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Refs so the status subscription always sees the latest values without
  // re-subscribing, and so unmount-on-play doesn't tear down the new session.
  const deckRef = useRef("");
  const formatRef = useRef<DuelFormat>("advanced");
  const handingOff = useRef(false);
  deckRef.current = deckId;

  useEffect(() => {
    window.duel.decks.list().then((d) => { setDecks(d ?? []); if (d?.length) setDeckId(d[0]!.id); }).catch(() => setDecks([]));
  }, []);

  useEffect(() => {
    const off = window.duel.net.onStatus((s) => {
      setStatus(s);
      if (s.phase === "error") { setErr(s.message ?? "Connection error."); setBusy(false); }
      if (s.phase === "peer-left") { setErr("The other player left."); setBusy(false); }
      if (s.phase === "ended") setBusy(false);
      if (s.phase === "playing") { handingOff.current = true; onPlay(deckRef.current, s.format ?? formatRef.current); }
    });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the lobby (back / unmount) tears down any pending connection —
  // unless we're handing off to the board, which owns the session from here.
  useEffect(() => () => { if (!handingOff.current) window.duel.net.leave().catch(() => {}); }, []);

  const portNum = () => Number(relayPort) || 41923;
  const host = async () => {
    if (!deckId) return;
    setErr(null); setBusy(true); formatRef.current = format;
    const res = await window.duel.net.host({ deckId, format, seed: /^\d+$/.test(seed.trim()) ? seed.trim() : undefined, relayHost: relayHost.trim(), relayPort: portNum(), room: room.trim() || undefined });
    if (!res.ok) { setErr(res.error ?? "Could not host."); setBusy(false); return; }
    if (res.room) setRoom(res.room);
  };
  const join = async () => {
    if (!deckId || !room.trim()) return;
    setErr(null); setBusy(true);
    const res = await window.duel.net.join({ deckId, relayHost: relayHost.trim(), relayPort: portNum(), room: room.trim() });
    if (!res.ok) { setErr(res.error ?? "Could not join."); setBusy(false); }
  };
  const cancel = () => { window.duel.net.leave().catch(() => {}); setBusy(false); setStatus(null); setErr(null); setCopied(false); };

  const switchTab = (next: "host" | "join") => { if (busy) return; setTab(next); setErr(null); };

  const waiting = busy && (status?.phase === "waiting" || status?.phase === "connecting");
  const connecting = status?.phase === "connecting";
  const roomCode = status?.room ?? room;

  const copyRoom = async () => {
    if (!roomCode) return;
    try { await navigator.clipboard.writeText(roomCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable — code is on screen to read */ }
  };

  return (
    <div className="duelsetup online">
      <div className="duelsetup__head">
        <button className="btn" onClick={onBack}>← Modes</button>
        <h1>Online Play <span className="online__beta">friends-only · beta</span></h1>
      </div>
      <p className="duelsetup__hint">
        Play a friend over a relay. Just <strong>Host</strong> — your machine runs the relay
        automatically; share the room code, and your friend joins with your address (your port
        41923 must be reachable). Or point both of you at a relay you run yourself.
      </p>

      {decks === null ? (
        <div className="decklist__msg">Loading decks…</div>
      ) : decks.length === 0 ? (
        <div className="decklist__msg">No decks yet. Build one in the Deck tab first.</div>
      ) : waiting ? (
        <div className="online__wait">
          {connecting ? (
            <>
              <div className="online__spinner" aria-hidden />
              <div className="online__wait-title">Connecting…</div>
              <div className="online__wait-sub">Reaching the relay at {relayHost.trim()}:{portNum()}</div>
            </>
          ) : (
            <>
              <div className="online__code-label">Room code — share it with your friend</div>
              <div className="online__code-row">
                <span className="online__code">{roomCode || "…"}</span>
                <button className="btn" onClick={copyRoom} disabled={!roomCode}>{copied ? "Copied ✓" : "Copy"}</button>
              </div>
              <div className="online__wait-status"><span className="online__spinner online__spinner--sm" aria-hidden />Waiting for opponent to join…</div>
            </>
          )}
          <button className="btn btn--danger" onClick={cancel}>Cancel</button>
        </div>
      ) : (
        <>
          <div className="online__roles">
            <button className={`online__role ${tab === "host" ? "is-active" : ""}`} onClick={() => switchTab("host")}>
              <span className="online__role-name">Host</span>
              <span className="online__role-desc">Run the duel · create a room code</span>
            </button>
            <button className={`online__role ${tab === "join" ? "is-active" : ""}`} onClick={() => switchTab("join")}>
              <span className="online__role-name">Join</span>
              <span className="online__role-desc">Enter a friend's room code</span>
            </button>
          </div>

          <div className="duelsetup__opts">
            <label className="duelsetup__opt">
              <span>Deck</span>
              <select className="cards__input" value={deckId} onChange={(e) => setDeckId(e.target.value)} disabled={busy}>
                {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            {tab === "host" ? (
              <>
                <label className="duelsetup__opt">
                  <span>Format</span>
                  <select className="cards__input" value={format} onChange={(e) => setFormat(e.target.value as DuelFormat)} disabled={busy}>
                    <option value="advanced">Advanced</option>
                    <option value="genesys">Genesys</option>
                  </select>
                </label>
                <label className="duelsetup__opt">
                  <span>Room code (optional)</span>
                  <input className="cards__input" value={room} onChange={(e) => setRoom(e.target.value.toUpperCase())} disabled={busy} placeholder="auto" />
                </label>
              </>
            ) : (
              <label className="duelsetup__opt">
                <span>Room code</span>
                <input className="cards__input" value={room} onChange={(e) => setRoom(e.target.value.toUpperCase())} disabled={busy} placeholder="from host" />
              </label>
            )}
          </div>

          <details className="online__adv">
            <summary>Relay connection{tab === "host" ? " · shuffle" : ""}</summary>
            <div className="duelsetup__opts">
              <label className="duelsetup__opt">
                <span>Relay address</span>
                <input className="cards__input" value={relayHost} onChange={(e) => setRelayHost(e.target.value)} disabled={busy} placeholder="127.0.0.1" />
              </label>
              <label className="duelsetup__opt">
                <span>Relay port</span>
                <input className="cards__input" value={relayPort} onChange={(e) => setRelayPort(e.target.value.replace(/[^\d]/g, ""))} disabled={busy} placeholder="41923" />
              </label>
              {tab === "host" && (
                <label className="duelsetup__opt">
                  <span>Shuffle seed</span>
                  <input className="cards__input" value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))} disabled={busy} placeholder="random" />
                </label>
              )}
            </div>
          </details>

          {err && <div className="duelsetup__legality is-bad"><span className="duelsetup__legality-title">{err}</span></div>}

          {tab === "host" ? (
            <button className="btn btn--primary online__go" disabled={!deckId || busy} onClick={host}>Create Room</button>
          ) : (
            <button className="btn btn--primary online__go" disabled={!deckId || !room.trim() || busy} onClick={join}>Join Room</button>
          )}
        </>
      )}
    </div>
  );
}

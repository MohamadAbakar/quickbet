import { useEffect, useState } from "react";
import { fmtUsdc } from "../../../../sdk/src/index.ts";
import { Avatar, RefundNote } from "../../components.tsx";
import type { GameProps } from "../TableView.tsx";

const STREETS = ["Preflop", "Flop", "Turn", "River"];
const f = (n: number) => fmtUsdc(BigInt(n));

export function PokerGame({ room, table: t, seat, nameOf, act, onReview, error }: GameProps) {
  const g = room.game;
  const [raiseTo, setRaiseTo] = useState(0);
  const [picks, setPicks] = useState<number[]>([]);
  const [split, setSplit] = useState(false);
  const [confirmCash, setConfirmCash] = useState(false);

  const handKey = g ? `${g.hand}-${g.street}-${g.currentBet}-${g.toAct}` : "";
  const myMax = g ? g.bets[seat] + Math.min(g.stacks[seat], g.cap - g.committed[seat]) : 0;
  const myMin = g ? Math.min(g.currentBet + g.minRaise, myMax) : 0;
  useEffect(() => {
    setRaiseTo(myMin);
  }, [handKey, myMin]);
  useEffect(() => {
    setPicks([]);
    setSplit(false);
  }, [g?.hand, g?.phase]);

  if (!g || g.kind !== "poker") return <div className="screen body">Shuffling…</div>;
  if (g.cashedOut) {
    return (
      <div className="screen">
        <div className="eyebrow">Poker table · cashed out</div>
        <h1>{t.name}</h1>
        <div className="body">The host cashed out the table. Everyone signs the final stacks.</div>
        <div className="spacer" />
        <button className="btn" onClick={onReview}>Review final stacks and sign</button>
      </div>
    );
  }

  const pot = g.committed.reduce((a: number, b: number) => a + b, 0);
  const escrow = BigInt(t.buyIn) * BigInt(t.players.length);
  const myTurn = g.phase === "bet" && g.toAct === seat;
  const owed = g.currentBet - g.bets[seat];
  const isHost = seat === 0;
  const isRunner = isHost || seat === g.dealer;
  const step = g.bb;
  const canRaise = myMax > g.currentBet;
  const last = g.lastResult ? JSON.parse(g.lastResult) : null;

  const status = (i: number): [string, string] => {
    if (g.stacks[i] === 0 && g.committed[i] === 0 && g.phase !== "hand_over" && !g.inHand[i]) return ["Out · waiting for cash out", "var(--muted)"];
    if (g.phase === "bet" && g.toAct === i) return [i === seat ? "Your turn" : "Thinking…", "var(--accent)"];
    if (!g.inHand[i]) return [g.lastActions[i] ?? "Folded", "var(--muted)"];
    const tags = [];
    if (i === g.dealer) tags.push("Dealer");
    if (g.lastActions[i]) tags.push(g.lastActions[i]);
    if (g.committed[i]) tags.push(`in ${f(g.committed[i])}`);
    return [tags.join(" · ") || "Waiting", "var(--soft)"];
  };

  const togglePick = (i: number) => {
    if (!split) return setPicks([i]);
    setPicks((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].slice(-2)));
  };
  const myVote = g.showVotes?.[seat];
  const inHandCount = g.inHand.filter(Boolean).length;
  const votesIn = g.showVotes.filter((v: string | null, i: number) => v && g.inHand[i]).length;

  return (
    <div className="screen" style={{ gap: 14 }}>
      <div className="between" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="eyebrow">Poker table · Hand {g.hand} · {STREETS[g.street]}</div>
          <h1>{t.name}</h1>
        </div>
        <div className="small" style={{ textAlign: "right" }}>
          Escrow
          <br />
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmtUsdc(escrow)} USDC</span>
        </div>
      </div>

      <div className="card between" style={{ padding: "16px 20px" }}>
        <div className="stack" style={{ gap: 2 }}>
          <div className="label">Hand pot</div>
          <div className="big-num">{f(pot)}</div>
        </div>
        <div className="small" style={{ textAlign: "right" }}>
          Blinds
          <br />
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{f(g.sb)} / {f(g.bb)}</span>
          <br />
          Max bet this hand
          <br />
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{f(g.cap)}</span>
        </div>
      </div>

      <div className="stack">
        {g.stacks.map((stack: number, i: number) => {
          const [s, c] = status(i);
          return (
            <div key={i} className="seat plain">
              <Avatar label={nameOf(i)} />
              <div className="grow stack" style={{ gap: 1 }}>
                <div className="name">{nameOf(i)}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: c }}>{s}</div>
              </div>
              <div className="small" style={{ textAlign: "right", fontSize: 12 }}>
                Stack
                <br />
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{f(stack)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="notice err">{error}</div>}
      <div className="spacer" />

      {g.phase === "bet" && !myTurn && (
        <div className="body" style={{ textAlign: "center" }}>
          {g.toAct !== null ? `Waiting for ${nameOf(g.toAct)}` : "Waiting…"}
          {g.inHand[seat] ? "" : " · you folded this hand"}
        </div>
      )}

      {myTurn && (
        <div className="stack-12">
          <div className="between">
            <div className="body" style={{ fontSize: 14 }}>
              To call: <span style={{ fontWeight: 600, color: "var(--text)" }}>{f(Math.max(0, Math.min(owed, myMax - g.bets[seat])))}</span>
            </div>
            {canRaise && (
              <div className="row" style={{ gap: 10 }}>
                <button className="stepper" aria-label="Lower the raise" disabled={raiseTo <= myMin} onClick={() => setRaiseTo(Math.max(myMin, raiseTo - step))}>
                  −
                </button>
                <div style={{ minWidth: 52, textAlign: "center", fontWeight: 600 }}>{f(raiseTo)}</div>
                <button className="stepper" aria-label="Increase the raise" disabled={raiseTo >= myMax} onClick={() => setRaiseTo(Math.min(myMax, raiseTo + step))}>
                  +
                </button>
              </div>
            )}
          </div>
          <div className="grid3">
            <button className="btn ghost" style={{ fontSize: 16 }} onClick={() => act({ type: "fold" })}>Fold</button>
            {owed > 0 ? (
              <button className="btn outline" style={{ fontSize: 16 }} onClick={() => act({ type: "call" })}>
                Call {f(Math.min(owed, myMax - g.bets[seat]))}
              </button>
            ) : (
              <button className="btn outline" style={{ fontSize: 16 }} onClick={() => act({ type: "check" })}>Check</button>
            )}
            <button className="btn" style={{ fontSize: 16 }} disabled={!canRaise} onClick={() => act({ type: "raise", to: raiseTo })}>
              {raiseTo >= myMax ? "All in" : `Raise ${f(raiseTo)}`}
            </button>
          </div>
        </div>
      )}

      {g.phase === "street_done" && (
        isRunner ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="body" style={{ fontSize: 14 }}>Betting round done. Deal the next card, or go to showdown.</div>
            <div className="grid2">
              <button className="btn ghost" disabled={g.street >= 3} onClick={() => act({ type: "next_street" })}>
                {g.street >= 3 ? "River done" : `Deal ${STREETS[g.street + 1]}`}
              </button>
              <button className="btn" onClick={() => act({ type: "showdown" })}>Showdown</button>
            </div>
          </div>
        ) : (
          <div className="body" style={{ textAlign: "center" }}>Round done. {nameOf(g.dealer)} deals next.</div>
        )
      )}

      {g.phase === "showdown" && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="body" style={{ fontSize: 14 }}>
            Betting is closed. Show your cards, then pick who took the hand. {votesIn} of {inHandCount} picked.
          </div>
          {g.inHand[seat] ? (
            <>
              <div className="grid2">
                {g.inHand.map((on: boolean, i: number) =>
                  on ? (
                    <button key={i} className="chip" style={{ fontSize: 15, border: `2px solid ${picks.includes(i) ? "var(--accent)" : "var(--line)"}`, background: "var(--card)", color: "var(--text)" }} aria-pressed={false} onClick={() => togglePick(i)}>
                      {nameOf(i)}
                    </button>
                  ) : null
                )}
                <button
                  className="chip"
                  style={{ fontSize: 15, border: `2px solid ${split ? "var(--accent)" : "var(--line)"}`, background: "var(--card)", color: "var(--text)" }}
                  onClick={() => {
                    setSplit(!split);
                    setPicks([]);
                  }}
                >
                  Split pot
                </button>
              </div>
              <button
                className="btn"
                disabled={split ? picks.length !== 2 : picks.length !== 1}
                onClick={() => act({ type: "show_vote", winners: picks })}
              >
                {myVote ? "Change my pick" : split ? "Confirm split" : "Confirm hand winner"}
              </button>
            </>
          ) : (
            <div className="small">You folded, so the players still in the hand pick the winner.</div>
          )}
        </div>
      )}

      {g.phase === "hand_over" && (
        <div className="stack" style={{ gap: 10 }}>
          {last && (
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {last.winners.length === 1
                ? `${nameOf(last.winners[0])} ${nameOf(last.winners[0]) === "You" ? "take" : "takes"} ${f(last.pot)} USDC${last.folded ? " (everyone else folded)" : ""}`
                : `${nameOf(last.winners[0])} and ${nameOf(last.winners[1])} split ${f(last.pot)} USDC`}
            </div>
          )}
          {isHost ? (
            confirmCash ? (
              <div className="grid2">
                <button className="btn ghost" onClick={() => setConfirmCash(false)}>Keep playing</button>
                <button className="btn warn" onClick={() => act({ type: "cash_out" })}>Yes, cash out</button>
              </div>
            ) : (
              <div className="grid2">
                <button className="btn ghost" disabled={g.stacks.filter((s: number) => s > 0).length < 2} onClick={() => act({ type: "next_hand" })}>
                  Deal next hand
                </button>
                <button className="btn" onClick={() => setConfirmCash(true)}>Cash out table</button>
              </div>
            )
          ) : (
            <div className="small">Waiting for the host to deal the next hand or cash out.</div>
          )}
        </div>
      )}
      <RefundNote />
    </div>
  );
}

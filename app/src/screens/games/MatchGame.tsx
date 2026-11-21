import { fmtUsdc } from "../../../../sdk/src/index.ts";
import { RefundNote } from "../../components.tsx";
import type { GameProps } from "../TableView.tsx";

export function MatchGame({ room, table: t, nameOf, act, onReview, error }: GameProps) {
  const g = room.game;
  if (!g || g.kind !== "match") return <div className="screen body">Loading the scoreboard…</div>;
  const pot = BigInt(t.buyIn) * BigInt(t.players.length);
  const top = Math.max(...g.scores);
  const leaders = g.scores.filter((s: number) => s === top).length;
  const last = g.log[0];

  return (
    <div className="screen">
      <div className="stack" style={{ gap: 4 }}>
        <div className="eyebrow">Score match · First to {g.target}</div>
        <h1>{t.name}</h1>
      </div>
      <div className="card-sm between">
        <div className="body" style={{ fontSize: 14 }}>Winner takes</div>
        <div className="display" style={{ fontSize: 22 }}>{fmtUsdc(pot)} USDC</div>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        {g.scores.map((score: number, i: number) => {
          const won = g.winner === i;
          const leading = g.winner === null && top > 0 && leaders === 1 && score === top;
          return (
            <div key={i} className={`score-row${won ? " won" : ""}`}>
              <div className="grow stack" style={{ gap: 2 }}>
                <div className="name" style={{ fontSize: 16 }}>{nameOf(i)}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                  {won ? `Reached ${g.target}` : leading ? "Leading" : ""}
                </div>
              </div>
              <button className="stepper" aria-label={`Remove a point from ${nameOf(i)}`} onClick={() => act({ type: "score", seat: i, delta: -1 })}>
                −
              </button>
              <div className="display" style={{ width: 36, textAlign: "center", fontSize: 32 }}>{score}</div>
              <button
                className="stepper solid"
                aria-label={`Add a point for ${nameOf(i)}`}
                disabled={g.winner !== null}
                onClick={() => act({ type: "score", seat: i, delta: 1 })}
              >
                +
              </button>
            </div>
          );
        })}
      </div>
      {last && (
        <div className="small">
          Last change: {nameOf(last.by)} gave {nameOf(last.seat)} {last.delta > 0 ? "+1" : "−1"}
        </div>
      )}
      {error && <div className="notice err">{error}</div>}
      <RefundNote />
      <div className="spacer" />
      {g.winner === null ? (
        <div className="body" style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
          Tap + as points are scored
        </div>
      ) : (
        <button className="btn" onClick={onReview}>
          {nameOf(g.winner) === "You" ? "Confirm your win" : `Confirm ${nameOf(g.winner)} as winner`}
        </button>
      )}
    </div>
  );
}

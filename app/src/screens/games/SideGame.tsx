import { fmtUsdc } from "../../../../sdk/src/index.ts";
import { RefundNote } from "../../components.tsx";
import type { GameProps } from "../TableView.tsx";

const LABEL = { yes: "Yes", no: "No" } as const;
type Side = "yes" | "no";

export function SideGame({ room, table: t, seat, nameOf, act, onReview, error }: GameProps) {
  const g = room.game;
  if (!g || g.kind !== "side") return <div className="screen body">Loading…</div>;
  const buyIn = BigInt(t.buyIn);
  const pot = buyIn * BigInt(t.players.length);
  const mine: Side | null = g.picks[seat];
  const isHost = seat === 0;
  const backers = (s: Side) => g.picks.map((p: Side | null, i: number) => (p === s ? i : -1)).filter((i: number) => i >= 0);
  const allPicked = g.picks.every((p: Side | null) => p !== null);
  const myCall: Side | null = g.calls[seat];
  const callCount = (s: Side) => g.calls.filter((c: Side | null) => c === s).length;

  let preview = "Pick a side to see your payout.";
  if (mine) {
    const n = backers(mine).length;
    preview = `If ${LABEL[mine]} wins, ${n === 1 ? "you take " : n + " players split "}${fmtUsdc(pot)} USDC. Your payout: ${fmtUsdc(pot / BigInt(n))} USDC.`;
  }

  return (
    <div className="screen">
      <div className="stack" style={{ gap: 4 }}>
        <div className="eyebrow">Pick a side · {fmtUsdc(pot)} USDC in escrow</div>
        <h1>{t.name}</h1>
      </div>
      <div className="grid2" style={{ gap: 12 }}>
        {(["yes", "no"] as Side[]).map((s) => {
          const b = backers(s);
          return (
            <button
              key={s}
              className="side-card"
              aria-pressed={mine === s}
              disabled={g.locked}
              onClick={() => act({ type: "pick", side: s })}
            >
              <span className="display" style={{ fontSize: 32 }}>{LABEL[s]}</span>
              <span className="small">Pool</span>
              <span style={{ fontWeight: 600, fontSize: 18 }}>{fmtUsdc(buyIn * BigInt(b.length))} USDC</span>
              <span style={{ fontSize: 13, lineHeight: 1.4, color: "var(--soft)" }}>
                {b.length ? b.map(nameOf).join(", ") : "Nobody yet"}
              </span>
              <span style={{ marginTop: "auto", fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>
                {mine === s ? "Your side" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="card-sm body" style={{ fontSize: 14, padding: 16 }}>{preview}</div>
      {!allPicked && (
        <div className="small">
          Still picking: {g.picks.map((p: Side | null, i: number) => (p ? null : nameOf(i))).filter(Boolean).join(", ")}
        </div>
      )}
      {error && <div className="notice err">{error}</div>}
      <RefundNote />
      <div className="spacer" />

      {!g.locked && !mine && (
        <div className="body" style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>Tap Yes or No</div>
      )}
      {!g.locked && mine && isHost && (
        <button className="btn" disabled={!allPicked} onClick={() => act({ type: "lock" })}>
          {allPicked ? "Lock sides" : "Waiting for everyone to pick"}
        </button>
      )}
      {!g.locked && mine && !isHost && (
        <div className="body" style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
          You're on {LABEL[mine]}. The host locks sides when everyone has picked.
        </div>
      )}

      {g.locked && !g.outcome && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="body" style={{ fontSize: 14 }}>
            Sides are locked. When it's decided, the table calls the result.
            {myCall ? ` You called ${LABEL[myCall]}.` : ""} Yes {callCount("yes")} · No {callCount("no")}
          </div>
          <div className="grid2">
            <button className="btn" onClick={() => act({ type: "call", side: "yes" })}>Yes happened</button>
            <button className="btn outline" onClick={() => act({ type: "call", side: "no" })}>No, it didn't</button>
          </div>
        </div>
      )}
      {g.outcome && (
        <button className="btn" onClick={onReview}>
          {LABEL[g.outcome as Side]} wins. Review payout and sign
        </button>
      )}
    </div>
  );
}

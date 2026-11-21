import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { QRCodeSVG } from "qrcode.react";
import {
  TableState,
  cancelTableIx,
  explorerAddr,
  explorerTx,
  fmtUsdc,
  fromBase,
  joinTableIx,
  leaveTableIx,
  refundIx,
  short,
  startTableIx,
  submitResultIx,
  tableCode,
} from "../../../sdk/src/index.ts";
import { useApp } from "../App.tsx";
import { Avatar, TxButton } from "../components.tsx";
import { MODE_LABELS, addHistory, navigate, sendIxs, useRoom, useTx, type RoomState, type TableJson } from "../lib.ts";
import { MatchGame } from "./games/MatchGame.tsx";
import { SideGame } from "./games/SideGame.tsx";
import { PokerGame } from "./games/PokerGame.tsx";

export interface GameProps {
  room: RoomState;
  table: TableJson;
  seat: number;
  nameOf: (seat: number) => string;
  act: (a: unknown) => void;
  onReview: () => void;
  error: string | null;
}

export function TableView({ table: tableKey }: { table: string }) {
  const app = useApp();
  const me = app.wallet.publicKey.toBase58();
  const { room, connected, error, act, refresh } = useRoom(tableKey, me, app.name);
  const [reviewing, setReviewing] = useState(false);

  const t = room?.table ?? null;
  const nameOf = useMemo(
    () => (seat: number) => {
      if (!t) return "";
      const pk = t.players[seat];
      if (pk === me) return "You";
      return room?.names[pk] || `Seat ${seat + 1} · ${short(pk)}`;
    },
    [t, room?.names, me]
  );

  // A new on-chain result invalidates any earlier review.
  useEffect(() => {
    if (!room?.result) setReviewing(false);
  }, [room?.result]);

  if (!room) {
    return (
      <div className="screen">
        <div className="body">{connected ? "Loading table…" : "Connecting to the table…"}</div>
        {error && <div className="notice err">{error}</div>}
      </div>
    );
  }
  if (!t) {
    return (
      <div className="screen">
        <h1>Table not found</h1>
        <div className="body">This code doesn't match a QuickBet table on devnet.</div>
        <button className="btn" onClick={() => navigate("/")}>Back home</button>
      </div>
    );
  }

  const seat = room.seat;
  const banner = !connected && <div className="connection">Reconnecting…</div>;
  const common = { room, table: t, seat, nameOf, act, error, onReview: () => setReviewing(true) };

  if (t.state === TableState.Open) return <>{banner}<Lobby room={room} table={t} nameOf={nameOf} refresh={refresh} /></>;
  if (t.state === TableState.Settled) return <Payout room={room} table={t} nameOf={nameOf} />;
  if (t.state === TableState.Refunded) return <Refunded table={t} />;

  // Live
  if (seat < 0) {
    return (
      <div className="screen">
        <div className="eyebrow">{MODE_LABELS[t.mode]} · in progress</div>
        <h1>{t.name}</h1>
        <div className="body">This table already started, so it isn't taking new players.</div>
        <button className="btn" onClick={() => navigate("/")}>Back home</button>
      </div>
    );
  }
  const deadlinePassed = Date.now() / 1000 > Number(t.deadlineTs);
  if (deadlinePassed) return <RefundAvailable table={t} refresh={refresh} />;
  if (reviewing && room.result) return <>{banner}<Confirm {...common} result={room.result} back={() => setReviewing(false)} refresh={refresh} /></>;
  return (
    <>
      {banner}
      {t.mode === 2 ? <MatchGame {...common} /> : t.mode === 1 ? <SideGame {...common} /> : <PokerGame {...common} />}
    </>
  );
}

// ---------------- Lobby ----------------
function Lobby({
  room,
  table: t,
  nameOf,
  refresh,
}: {
  room: RoomState;
  table: TableJson;
  nameOf: (i: number) => string;
  refresh: () => void;
}) {
  const { wallet, connection, config, balance, refreshBalance } = useApp();
  const me = wallet.publicKey.toBase58();
  const seat = t.players.indexOf(me);
  const isHost = t.host === me;
  const full = t.players.length >= t.maxPlayers;
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const tablePk = new PublicKey(t.address);
  const link = `${window.location.origin}/t/${t.address}`;
  const buyIn = BigInt(t.buyIn);
  const tooPoor = balance !== null && balance < buyIn;

  const run = (label: string, ixs: () => Parameters<typeof sendIxs>[2]) =>
    tx.run(async () => {
      const sig = await sendIxs(connection, wallet, ixs());
      refresh();
      refreshBalance();
      return sig;
    });
  const seats = Array.from({ length: t.maxPlayers }, (_, i) => i);
  const players = t.players.map((p) => new PublicKey(p));

  return (
    <div className="screen" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 4 }}>
        <div className="eyebrow">
          {MODE_LABELS[t.mode]} · {fmtUsdc(buyIn).replace(/\.00$/, "")} USDC buy-in
          {t.mode === 2 ? ` · first to ${t.target}` : ""}
        </div>
        <h1>{t.name}</h1>
      </div>

      <div className="qr-wrap" aria-label={`QR code for table ${tableCode(t.tableId)}`}>
        <QRCodeSVG value={link} size={248} level="M" bgColor="#FFFFFF" fgColor="#0B0F14" />
      </div>
      <div className="between">
        <div className="stack" style={{ gap: 2 }}>
          <div className="label">Friends scan this to join</div>
          <div className="display" style={{ fontSize: 20 }}>{tableCode(t.tableId)}</div>
        </div>
        <button
          className="btn ghost sm"
          style={{ width: "auto", padding: "0 14px" }}
          onClick={() => {
            navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => {});
            if (navigator.share) navigator.share({ title: t.name, url: link }).catch(() => {});
          }}
        >
          {copied ? "Invite link copied" : "Copy invite link"}
        </button>
      </div>

      <div className="stack">
        <div className="between small">
          <div>Players {t.players.length} of {t.maxPlayers}</div>
          <div>In escrow: {fmtUsdc(BigInt(room.vault))} USDC</div>
        </div>
        {seats.map((i) => {
          const pk = t.players[i];
          if (!pk)
            return (
              <div key={i} className="seat open">
                <div className="avatar">+</div>
                <div className="grow name" style={{ color: "var(--muted)" }}>Open seat</div>
                <div className="status" style={{ color: "var(--muted)" }}>Waiting for scan</div>
              </div>
            );
          const label = nameOf(i) + (pk === t.host ? " · host" : "");
          return (
            <div key={i} className="seat">
              <Avatar label={nameOf(i)} />
              <div className="grow name">{label}</div>
              <div className="status ok">Locked</div>
            </div>
          );
        })}
      </div>

      <div className="spacer" />
      <div className="stack" style={{ gap: 10 }}>
        {seat < 0 && !full && (
          <>
            {tooPoor && <div className="notice warn">Your demo wallet has less than the buy-in. It tops up on first open; wait a moment.</div>}
            <TxButton
              tx={tx}
              label={`Lock ${fmtUsdc(buyIn).replace(/\.00$/, "")} USDC in escrow`}
              pendingLabel="Locking your buy-in…"
              disabled={tooPoor}
              onClick={() => run("join", () => [joinTableIx({ player: wallet.publicKey, table: tablePk, mint: config.mint, programId: config.programId })])}
            />
            <div className="small" style={{ textAlign: "center" }}>
              You get it back if the host cancels or nobody agrees on a result within 24 hours.
            </div>
          </>
        )}
        {seat < 0 && full && <div className="notice">This table is full.</div>}
        {seat > 0 && (
          <>
            <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }} className="body">
              You're in. Waiting for the host to start.
            </div>
            <TxButton
              tx={tx}
              className="btn text"
              label={`Leave and get ${fmtUsdc(buyIn)} back`}
              onClick={() => run("leave", () => [leaveTableIx({ player: wallet.publicKey, table: tablePk, mint: config.mint, programId: config.programId })])}
            />
          </>
        )}
        {isHost && (
          <>
            {t.players.length < 2 ? (
              <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }} className="body">
                Waiting for the table to fill
              </div>
            ) : (
              <TxButton
                tx={tx}
                label={full ? "Everyone's in. Start game" : `Start with ${t.players.length} players`}
                pendingLabel="Starting…"
                onClick={() => run("start", () => [startTableIx({ host: wallet.publicKey, table: tablePk, programId: config.programId })])}
              />
            )}
            {!confirmCancel ? (
              <button className="btn text" onClick={() => setConfirmCancel(true)}>Cancel table and refund everyone</button>
            ) : (
              <button
                className="btn warn md"
                onClick={() => {
                  setConfirmCancel(false);
                  run("cancel", () => [cancelTableIx({ signer: wallet.publicKey, table: tablePk, mint: config.mint, players, programId: config.programId })]);
                }}
              >
                Tap again to cancel and refund
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- Confirm result ----------------
function Confirm({
  table: t,
  seat,
  nameOf,
  result,
  back,
  refresh,
}: GameProps & { result: string[]; back: () => void; refresh: () => void }) {
  const { wallet, connection, config, refreshBalance } = useApp();
  const tx = useTx();
  const key = result.join(",");
  const confirmed = t.votes.filter((v, i) => t.voted[i] && v.join(",") === key).length;
  const mine = t.voted[seat] && t.votes[seat].join(",") === key;
  const need = Math.floor(t.players.length / 2) + 1;

  const words = result
    .map((amt, i) => `${nameOf(i)} ${i === seat ? "receive" : "receives"} ${fmtUsdc(BigInt(amt))}`)
    .join(", ");

  const sign = () =>
    tx.run(async () => {
      const sig = await sendIxs(connection, wallet, [
        submitResultIx({
          signer: wallet.publicKey,
          table: new PublicKey(t.address),
          mint: config.mint,
          players: t.players.map((p) => new PublicKey(p)),
          payouts: result.map(BigInt),
          programId: config.programId,
        }),
      ]);
      refresh();
      refreshBalance();
      return sig;
    });

  return (
    <div className="screen">
      <div className="eyebrow">Confirm result · {t.name}</div>
      <h1>Does this match what happened?</h1>
      <div className="card body" style={{ fontSize: 16 }}>{words}.</div>
      <div className="stack">
        {result.map((amt, i) => (
          <div key={i} className="seat plain">
            <Avatar label={nameOf(i)} />
            <div className="grow name">{nameOf(i)}</div>
            <div style={{ fontWeight: 600 }}>{fmtUsdc(BigInt(amt))} USDC</div>
            <div className="small" style={{ width: 70, textAlign: "right" }}>
              {t.voted[i] && t.votes[i].join(",") === key ? <span className="ok">Signed</span> : "Not yet"}
            </div>
          </div>
        ))}
      </div>
      <div className="notice">
        {confirmed} of {t.players.length} confirmed. The escrow pays out at {need}.
      </div>
      <div className="spacer" />
      {mine ? (
        <div className="body" style={{ textAlign: "center" }}>You signed. Waiting for {Math.max(0, need - confirmed)} more.</div>
      ) : (
        <TxButton tx={tx} label="Confirm and sign" pendingLabel="Signing on devnet…" onClick={sign} />
      )}
      <button className="btn text" onClick={back}>Back to the game</button>
    </div>
  );
}

// ---------------- Payout ----------------
function majorityVector(t: TableJson): bigint[] | null {
  const n = t.players.length;
  for (let i = 0; i < n; i++) {
    if (!t.voted[i]) continue;
    const key = t.votes[i].join(",");
    const c = t.votes.filter((v, j) => t.voted[j] && v.join(",") === key).length;
    if (c * 2 > n) return t.votes[i].map(BigInt);
  }
  return null;
}

function Payout({ room, table: t, nameOf }: { room: RoomState; table: TableJson; nameOf: (i: number) => string }) {
  const { wallet, balance, refreshBalance } = useApp();
  const me = wallet.publicKey.toBase58();
  const seat = t.players.indexOf(me);
  const buyIn = BigInt(t.buyIn);
  const v = majorityVector(t) ?? t.players.map(() => 0n);
  const key = v.join(",");
  const confirmedBy = t.votes.filter((x, i) => t.voted[i] && x.map(String).join(",") === key).length;
  const total = buyIn * BigInt(t.players.length);
  const top = v.indexOf(v.reduce((a, b) => (b > a ? b : a), 0n));
  const winners = v.filter((x) => x > 0n).length;
  const headline =
    winners === 1 ? (top === seat ? "You win the pot" : `${nameOf(top)} wins the pot`) : "Table settled";

  useEffect(() => {
    refreshBalance();
    if (seat >= 0) {
      addHistory({
        table: t.address,
        name: t.name,
        detail: `${MODE_LABELS[t.mode]} · ${t.players.length} players · settled`,
        net: fromBase(v[seat] - buyIn),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.address]);

  return (
    <div className="screen">
      <div className="row">
        <svg aria-hidden="true" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12.5l3 3 5-6" />
        </svg>
        <h1>{headline}</h1>
      </div>
      <div className="small">{fmtUsdc(total)} USDC paid out of escrow · {t.name}</div>
      <div className="stack">
        {v.map((amt, i) => {
          const net = amt - buyIn;
          return (
            <div key={i} className="seat plain" style={{ minHeight: 56 }}>
              <Avatar label={nameOf(i)} />
              <div className="grow name">{nameOf(i)}</div>
              <div style={{ textAlign: "right", fontWeight: 600, fontSize: 15 }}>
                {fmtUsdc(amt)} USDC
                <br />
                <span style={{ fontSize: 12, color: net >= 0n ? "var(--accent)" : "var(--muted)" }}>
                  {(net >= 0n ? "+" : "-") + fmtUsdc(net >= 0n ? net : -net)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="card stack" style={{ padding: 16, gap: 10, borderRadius: 16 }}>
        <div className="between" style={{ fontSize: 14 }}>
          <span className="label" style={{ fontSize: 14 }}>Result confirmed by</span>
          <span style={{ fontWeight: 600 }}>{confirmedBy} of {t.players.length} players</span>
        </div>
        <div className="between" style={{ fontSize: 14 }}>
          <span className="label" style={{ fontSize: 14 }}>House fee</span>
          <span style={{ fontWeight: 600 }}>None</span>
        </div>
        <div className="between" style={{ fontSize: 14 }}>
          <span className="label" style={{ fontSize: 14 }}>Your balance</span>
          <span style={{ fontWeight: 600 }}>{balance === null ? "…" : fmtUsdc(balance)} USDC</span>
        </div>
      </div>
      <a
        className="btn ghost md"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}
        href={room.settleSig ? explorerTx(room.settleSig) : explorerAddr(t.address)}
        target="_blank"
        rel="noreferrer"
      >
        {room.settleSig ? "View the settlement on Solana Explorer" : "View the table on Solana Explorer"}
      </a>
      <div className="spacer" />
      <button className="btn" onClick={() => navigate("/")}>Done</button>
    </div>
  );
}

// ---------------- Refunds ----------------
function RefundAvailable({ table: t, refresh }: { table: TableJson; refresh: () => void }) {
  const { wallet, connection, config, refreshBalance } = useApp();
  const tx = useTx();
  return (
    <div className="screen">
      <div className="eyebrow">{MODE_LABELS[t.mode]} · {t.name}</div>
      <h1>No agreed result in time</h1>
      <div className="body">The settle window has passed without a majority. Anyone at the table can return every buy-in now.</div>
      <div className="spacer" />
      <TxButton
        tx={tx}
        label={`Refund ${fmtUsdc(BigInt(t.buyIn))} USDC to every seat`}
        pendingLabel="Refunding…"
        onClick={() =>
          tx.run(async () => {
            const sig = await sendIxs(connection, wallet, [
              refundIx({
                signer: wallet.publicKey,
                table: new PublicKey(t.address),
                mint: config.mint,
                players: t.players.map((p) => new PublicKey(p)),
                programId: config.programId,
              }),
            ]);
            refresh();
            refreshBalance();
            return sig;
          })
        }
      />
    </div>
  );
}

function Refunded({ table: t }: { table: TableJson }) {
  return (
    <div className="screen">
      <div className="eyebrow">{MODE_LABELS[t.mode]}</div>
      <h1>{t.name}</h1>
      <div className="notice">This table was closed and every buy-in ({fmtUsdc(BigInt(t.buyIn))} USDC) went back to its player.</div>
      <a className="small" href={explorerAddr(t.address)} target="_blank" rel="noreferrer">View the table on Solana Explorer</a>
      <div className="spacer" />
      <button className="btn" onClick={() => navigate("/")}>Back home</button>
    </div>
  );
}

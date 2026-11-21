import { useState } from "react";
import {
  Mode,
  createTableIx,
  tablePda,
  toBase,
} from "../../../sdk/src/index.ts";
import { useApp } from "../App.tsx";
import { TxButton } from "../components.tsx";
import { navigate, sendIxs, useTx } from "../lib.ts";

const MODES = [
  { id: Mode.Poker, title: "Poker table", desc: "Raise, call and fold in the app. Cash out by chip stack.", def: "Friday poker" },
  { id: Mode.Side, title: "Pick a side", desc: "Yes or no on anything. Winners split the pot.", def: "Will Dre hit the half-court shot?" },
  { id: Mode.Match, title: "Score match", desc: "Darts, pool, pickup. First to the target takes the pot.", def: "Darts, first to 5" },
];
const STAKES = [5, 10, 25, 50];

export function Create() {
  const { wallet, config, connection, balance, refreshBalance } = useApp();
  const [mode, setMode] = useState<Mode>(Mode.Match);
  const [name, setName] = useState<string | null>(null);
  const [stake, setStake] = useState(5);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [target, setTarget] = useState(5);
  const tx = useTx();
  const betName = (name ?? MODES.find((m) => m.id === mode)!.def).slice(0, 40);
  const short = balance !== null && balance < toBase(stake);

  const create = () =>
    tx.run(async () => {
      const tableId = BigInt(1000 + Math.floor(Math.random() * 9000));
      const sig = await sendIxs(connection, wallet, [
        createTableIx({
          host: wallet.publicKey,
          mint: config.mint,
          tableId,
          mode,
          buyIn: toBase(stake),
          maxPlayers,
          target: mode === Mode.Match ? target : 0,
          name: betName,
          programId: config.programId,
        }),
      ]);
      refreshBalance();
      navigate(`/t/${tablePda(wallet.publicKey, tableId, config.programId).toBase58()}`);
      return sig;
    });

  return (
    <div className="screen">
      <h1 className="xl">Set up the bet</h1>
      <div className="stack">
        <div className="label">Game style</div>
        {MODES.map((m) => (
          <button key={m.id} className="choice" aria-pressed={m.id === mode} onClick={() => setMode(m.id)}>
            <span className="title">
              <span>{m.title}</span>
              <span className="tag">{m.id === mode ? "Selected" : ""}</span>
            </span>
            <span className="desc">{m.desc}</span>
          </button>
        ))}
      </div>

      <div className="stack">
        <label htmlFor="betName" className="label">
          {mode === Mode.Side ? "The yes/no question" : "What are you betting on?"}
        </label>
        <input id="betName" className="input" maxLength={40} value={betName} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="stack">
        <div className="label">Buy-in per player (USDC)</div>
        <div className="grid4">
          {STAKES.map((v) => (
            <button key={v} className="chip" aria-pressed={v === stake} onClick={() => setStake(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="between">
        <div className="label">Max players</div>
        <div className="row">
          <button className="stepper" aria-label="Fewer players" disabled={maxPlayers <= 2} onClick={() => setMaxPlayers(maxPlayers - 1)}>
            −
          </button>
          <div className="display" style={{ fontSize: 22, minWidth: 28, textAlign: "center" }}>{maxPlayers}</div>
          <button className="stepper" aria-label="More players" disabled={maxPlayers >= 6} onClick={() => setMaxPlayers(maxPlayers + 1)}>
            +
          </button>
        </div>
      </div>

      {mode === Mode.Match && (
        <div className="between">
          <div className="label">Target score</div>
          <div className="row">
            <button className="stepper" aria-label="Lower target" disabled={target <= 1} onClick={() => setTarget(target - 1)}>
              −
            </button>
            <div className="display" style={{ fontSize: 22, minWidth: 28, textAlign: "center" }}>{target}</div>
            <button className="stepper" aria-label="Raise target" disabled={target >= 50} onClick={() => setTarget(target + 1)}>
              +
            </button>
          </div>
        </div>
      )}

      <div className="spacer" />
      {short && <div className="notice warn">Your wallet has less than {stake} USDC (demo). It tops up on first open; try again in a moment.</div>}
      <div className="stack" style={{ gap: 6 }}>
        <TxButton tx={tx} label="Create table and show QR" pendingLabel="Locking your buy-in…" onClick={create} disabled={short} />
        <button className="btn text" onClick={() => navigate("/")}>
          Cancel
        </button>
      </div>
    </div>
  );
}

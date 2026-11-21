import { useState } from "react";
import { fmtUsdc, short } from "../../../sdk/src/index.ts";
import { useApp } from "../App.tsx";
import { loadHistory, navigate } from "../lib.ts";

export function Home() {
  const { wallet, balance, funding, name, setName } = useApp();
  const history = loadHistory();
  const [copied, setCopied] = useState(false);
  const addr = wallet.publicKey.toBase58();

  return (
    <div className="screen" style={{ gap: 20 }}>
      <div className="card stack" style={{ gap: 6 }}>
        <div className="between">
          <div className="label">Wallet balance</div>
          <button
            className="btn text"
            style={{ width: "auto", height: 32, fontSize: 13 }}
            onClick={() => {
              navigator.clipboard?.writeText(addr).then(() => setCopied(true)).catch(() => {});
            }}
          >
            {copied ? "Copied" : short(addr)}
          </button>
        </div>
        <div className="big-num">
          {balance === null ? "…" : fmtUsdc(balance)} <span className="unit">USDC (demo)</span>
        </div>
        {funding && <div className="small">Topping up your demo wallet…</div>}
      </div>

      <div className="stack">
        <label className="label" htmlFor="name">
          Your name at the table
        </label>
        <input
          id="name"
          className="input"
          value={name}
          maxLength={24}
          placeholder="e.g. Maya"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="stack-12">
        <button className="btn" onClick={() => navigate("/new")}>
          New bet
        </button>
        <button className="btn ghost" onClick={() => navigate("/scan")}>
          Scan QR to join a table
        </button>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <div className="label">Recent bets</div>
        {history.length === 0 && <div className="small">Nothing yet. Start a bet or join one.</div>}
        {history.map((h) => (
          <button
            key={h.table}
            className="card-sm between"
            style={{ border: 0, color: "inherit", cursor: "pointer", textAlign: "left", borderRadius: 14 }}
            onClick={() => navigate(`/t/${h.table}`)}
          >
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <div className="name">{h.name}</div>
              <div className="small">{h.detail}</div>
            </div>
            <div style={{ fontWeight: 600, fontSize: 15, color: h.net >= 0 ? "var(--accent)" : "var(--soft)" }}>
              {(h.net >= 0 ? "+" : "-") + Math.abs(h.net).toFixed(2)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

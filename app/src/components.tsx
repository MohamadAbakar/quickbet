import { explorerTx } from "../../sdk/src/index.ts";
import type { useTx } from "./lib.ts";

type Tx = ReturnType<typeof useTx>;

/** Primary action with clear pending / success / failure states and a retry. */
export function TxButton({
  tx,
  label,
  pendingLabel = "Confirming on devnet…",
  onClick,
  className = "btn",
  disabled,
}: {
  tx: Tx;
  label: string;
  pendingLabel?: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className="stack">
      {tx.status === "error" && (
        <div className="notice err" role="alert">
          {tx.error}
        </div>
      )}
      <button
        className={className}
        disabled={disabled || tx.status === "pending"}
        onClick={tx.status === "error" ? () => tx.retry() : onClick}
      >
        {tx.status === "pending" ? pendingLabel : tx.status === "error" ? `Retry: ${label}` : label}
      </button>
      {tx.status === "success" && tx.sig && (
        <a className="small" href={explorerTx(tx.sig)} target="_blank" rel="noreferrer" style={{ textAlign: "center" }}>
          Confirmed. View on explorer
        </a>
      )}
    </div>
  );
}

export function Avatar({ label }: { label: string }) {
  return <div className="avatar">{(label.trim()[0] ?? "?").toUpperCase()}</div>;
}

export function RefundNote() {
  return <div className="small">No agreed result within 24 hours? The vault refunds every buy-in.</div>;
}

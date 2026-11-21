// Burner wallet, config, transactions and the relay connection.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ata, readableError } from "../../sdk/src/index.ts";

// ---------- storage (every access guarded: private mode can throw) ----------
export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// ---------- burner wallet (devnet only, insecure by design) ----------
export function loadWallet(): Keypair {
  const raw = store.get("qb.wallet");
  if (raw) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {}
  }
  const kp = Keypair.generate();
  store.set("qb.wallet", JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// ---------- config ----------
const envServer = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, "");
export const SERVER_URL = envServer || window.location.origin;
export const WS_URL = SERVER_URL.replace(/^http/, "ws") + "/ws";

export interface AppConfig {
  programId: PublicKey;
  mint: PublicKey;
  rpcUrl: string;
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch(`${SERVER_URL}/config`);
  if (!res.ok) throw new Error(`Server not reachable (${res.status})`);
  const j = await res.json();
  return {
    programId: new PublicKey(j.programId),
    mint: new PublicKey(j.mint),
    rpcUrl: (import.meta.env.VITE_RPC_URL as string) || j.rpcUrl,
  };
}

export async function requestFaucet(pubkey: PublicKey) {
  const res = await fetch(`${SERVER_URL}/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubkey.toBase58() }),
  });
  if (res.status === 429) return null; // already funded recently
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Faucet failed");
  return res.json();
}

export async function lookupCode(code: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/tables/code/${encodeURIComponent(code)}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? "Table not found");
  return j.table;
}

export async function usdcBalance(connection: Connection, owner: PublicKey, mint: PublicKey) {
  try {
    const b = await connection.getTokenAccountBalance(ata(owner, mint), "confirmed");
    return BigInt(b.value.amount);
  } catch {
    return 0n;
  }
}

// ---------- transactions ----------
export async function sendIxs(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[]
): Promise<string> {
  const bh = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signer.publicKey, ...bh }).add(...ixs);
  tx.sign(signer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  const res = await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (res.value.err) throw new Error("Transaction failed on-chain");
  return sig;
}

export type TxStatus = "idle" | "pending" | "success" | "error";

export function useTx() {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const last = useRef<(() => Promise<string>) | null>(null);

  const run = useCallback(async (fn: () => Promise<string>) => {
    last.current = fn;
    setStatus("pending");
    setError(null);
    try {
      const s = await fn();
      setSig(s);
      setStatus("success");
      return s;
    } catch (e) {
      setError(readableError(e));
      setStatus("error");
      return null;
    }
  }, []);
  const retry = useCallback(() => (last.current ? run(last.current) : Promise.resolve(null)), [run]);
  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);
  return { status, error, sig, run, retry, reset };
}

// ---------- relay ----------
export interface TableJson {
  address: string;
  host: string;
  tableId: string;
  mint: string;
  buyIn: string;
  maxPlayers: number;
  mode: number;
  target: number;
  state: number;
  deadlineTs: string;
  createdTs: string;
  players: string[];
  voted: boolean[];
  votes: string[][];
  name: string;
}

export interface RoomState {
  table: TableJson | null;
  vault: string;
  seat: number;
  names: Record<string, string>;
  game: any;
  result: string[] | null;
  settleSig: string | null;
  online: string[];
}

/** Auto-reconnecting room socket. Phones lock and drop sockets constantly. */
export function useRoom(table: string, player: string, name: string) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const ws = new WebSocket(
        `${WS_URL}?table=${table}&player=${player}&name=${encodeURIComponent(name)}`
      );
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 15000);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "state") setRoom(m);
        if (m.type === "error") {
          setError(m.message);
          setTimeout(() => setError((cur) => (cur === m.message ? null : cur)), 5000);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        clearInterval(ping);
        if (closed) return;
        timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };
    connect();

    const wake = () => {
      if (document.visibilityState === "visible" && wsRef.current?.readyState !== 1) {
        clearTimeout(timer);
        wsRef.current?.close();
        connect();
      } else if (document.visibilityState === "visible") {
        wsRef.current?.send('{"type":"refresh"}');
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      wsRef.current?.close();
    };
  }, [table, player, name]);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }, []);
  const act = useCallback((action: unknown) => send({ type: "action", action }), [send]);
  const refresh = useCallback(() => send({ type: "refresh" }), [send]);

  return { room, connected, error, act, refresh };
}

// ---------- routing ----------
export function navigate(path: string) {
  if (window.location.pathname !== path) window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

// ---------- history ----------
export interface HistoryEntry {
  table: string;
  name: string;
  detail: string;
  net: number;
}
export function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(store.get("qb.history") ?? "[]");
  } catch {
    return [];
  }
}
export function addHistory(e: HistoryEntry) {
  const h = loadHistory().filter((x) => x.table !== e.table);
  store.set("qb.history", JSON.stringify([e, ...h].slice(0, 20)));
}

export const MODE_LABELS = ["Poker table", "Pick a side", "Score match"];

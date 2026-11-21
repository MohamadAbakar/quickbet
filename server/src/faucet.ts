import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { ata, toBase } from "../../sdk/src/index.ts";
import { config, mintAuthority, treasury } from "./config.ts";

const byKey = new Map<string, number>();
const byIp = new Map<string, number[]>();
const inFlight = new Set<string>();
const KEY_COOLDOWN_MS = 10_000;
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 40;

export class FaucetError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function fund(connection: Connection, pubkeyStr: string, ip: string) {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(pubkeyStr);
  } catch {
    throw new FaucetError("Invalid pubkey");
  }
  const key = pubkey.toBase58();
  const now = Date.now();
  if (inFlight.has(key)) throw new FaucetError("Already funding this wallet", 429);
  if (now - (byKey.get(key) ?? 0) < KEY_COOLDOWN_MS) throw new FaucetError("Slow down", 429);
  const hits = (byIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_MAX) throw new FaucetError("Too many requests from this network", 429);
  byIp.set(ip, [...hits, now]);
  byKey.set(key, now);
  inFlight.add(key);

  try {
    const t = treasury();
    const auth = mintAuthority();
    const mint = config.mint;
    const tokenAcct = ata(pubkey, mint);
    const [lamports, tokenInfo] = await Promise.all([
      connection.getBalance(pubkey, "confirmed"),
      connection.getAccountInfo(tokenAcct, "confirmed"),
    ]);

    const tx = new Transaction();
    let sentSol = 0;
    let mintedUsdc = 0;
    if (lamports < config.solThreshold * LAMPORTS_PER_SOL) {
      sentSol = config.solAmount;
      tx.add(
        SystemProgram.transfer({
          fromPubkey: t.publicKey,
          toPubkey: pubkey,
          lamports: Math.round(config.solAmount * LAMPORTS_PER_SOL),
        })
      );
    }
    if (!tokenInfo) {
      mintedUsdc = config.usdcAmount;
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(t.publicKey, tokenAcct, pubkey, mint),
        createMintToInstruction(mint, tokenAcct, auth.publicKey, toBase(config.usdcAmount))
      );
    }
    let signature: string | null = null;
    if (tx.instructions.length) {
      const signers = mintedUsdc ? [t, auth] : [t];
      signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    }
    return { pubkey: key, sentSol, mintedUsdc, signature };
  } finally {
    inFlight.delete(key);
  }
}

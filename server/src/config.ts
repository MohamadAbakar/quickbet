import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(SERVER_ROOT, ".env") });

/** Load a keypair from a JSON env value (for hosts) or from a file path. Never logged. */
export function loadKeypair(jsonEnv: string, pathEnv: string, fallback: string): Keypair {
  const inline = process.env[jsonEnv];
  if (inline) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inline)));
  const p = path.resolve(SERVER_ROOT, process.env[pathEnv] ?? fallback);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing keypair: set ${jsonEnv} or ${pathEnv} (looked at ${p}). Run npm run setup-devnet -w server.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k} in server/.env (see server/.env.example)`);
  return v;
};

export const config = {
  port: Number(process.env.PORT ?? 8787),
  rpcUrl: process.env.RPC_URL ?? "https://api.devnet.solana.com",
  get programId() {
    return new PublicKey(need("PROGRAM_ID"));
  },
  get mint() {
    return new PublicKey(need("DEMO_MINT"));
  },
  allowedOrigins: (process.env.ALLOWED_ORIGIN ?? "*").split(",").map((s) => s.trim()),
  solThreshold: Number(process.env.FAUCET_SOL_THRESHOLD ?? 0.03),
  solAmount: Number(process.env.FAUCET_SOL_AMOUNT ?? 0.05),
  usdcAmount: Number(process.env.FAUCET_USDC_AMOUNT ?? 250),
};

export const treasury = () => loadKeypair("TREASURY_SECRET", "TREASURY_KEYPAIR", "keys/treasury.json");
export const mintAuthority = () =>
  loadKeypair("MINT_AUTHORITY_SECRET", "MINT_AUTHORITY_KEYPAIR", "keys/mint-authority.json");

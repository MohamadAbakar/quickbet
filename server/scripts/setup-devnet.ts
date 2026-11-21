// One-time devnet setup: treasury + mint-authority keypairs, demo USDC mint,
// treasury funding, and server/.env. Safe to re-run (reuses what exists).
// Secrets stay in server/keys/ (gitignored) and are never printed.
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { SERVER_ROOT } from "../src/config.ts";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const keysDir = path.join(SERVER_ROOT, "keys");
const envPath = path.join(SERVER_ROOT, ".env");

function loadOrCreate(file: string): Keypair {
  const p = path.join(keysDir, file);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  fs.mkdirSync(keysDir, { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`created ${path.relative(SERVER_ROOT, p)} (${kp.publicKey.toBase58()})`);
  return kp;
}

function readEnv(): Record<string, string> {
  if (!fs.existsSync(envPath)) {
    const example = path.join(SERVER_ROOT, ".env.example");
    if (fs.existsSync(example)) fs.copyFileSync(example, envPath);
    else fs.writeFileSync(envPath, "");
  }
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(patch: Record<string, string>) {
  let text = fs.readFileSync(envPath, "utf8");
  for (const [k, v] of Object.entries(patch)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(envPath, text);
}

async function airdropTo(connection: Connection, pk: PublicKey, sol: number) {
  try {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    return true;
  } catch (e) {
    console.warn(`  airdrop of ${sol} SOL failed (devnet rate limit?): ${(e as Error).message}`);
    return false;
  }
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const treasury = loadOrCreate("treasury.json");
  const mintAuth = loadOrCreate("mint-authority.json");
  const env = readEnv();

  let bal = await connection.getBalance(treasury.publicKey);
  console.log(`treasury ${treasury.publicKey.toBase58()} has ${bal / LAMPORTS_PER_SOL} SOL`);
  if (bal < 1 * LAMPORTS_PER_SOL) {
    await airdropTo(connection, treasury.publicKey, 2);
    bal = await connection.getBalance(treasury.publicKey);
    console.log(`treasury now ${bal / LAMPORTS_PER_SOL} SOL`);
  }
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    console.log(
      `\nTreasury is empty and the devnet airdrop was refused.\n` +
        `Fund it manually at https://faucet.solana.com with address ${treasury.publicKey.toBase58()}, then re-run.`
    );
    process.exit(1);
  }

  let mint = env.DEMO_MINT;
  if (mint && (await connection.getAccountInfo(new PublicKey(mint)))) {
    console.log(`demo USDC mint already exists: ${mint}`);
  } else {
    const m = await createMint(connection, treasury, mintAuth.publicKey, null, 6);
    mint = m.toBase58();
    console.log(`created demo USDC mint (6 decimals): ${mint}`);
  }

  writeEnv({
    RPC_URL: env.RPC_URL || RPC,
    DEMO_MINT: mint,
    TREASURY_KEYPAIR: "keys/treasury.json",
    MINT_AUTHORITY_KEYPAIR: "keys/mint-authority.json",
  });
  console.log(`\nwrote server/.env. Set PROGRAM_ID there to your deployed program ID if it is not set yet.`);
  console.log(`App env (app/.env.local): VITE_DEMO_MINT=${mint}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

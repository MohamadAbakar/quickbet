// Check the treasury SOL balance and top it up from the devnet airdrop if low.
// Run this the day before and an hour before the demo.
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config, treasury } from "../src/config.ts";

const TARGET = Number(process.env.TOPUP_TARGET_SOL ?? 3);
const PER_WALLET = config.solAmount;

async function main() {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const t = treasury();
  let bal = (await connection.getBalance(t.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`treasury ${t.publicKey.toBase58()}: ${bal.toFixed(3)} SOL (~${Math.floor(bal / PER_WALLET)} new wallets)`);
  let tries = 0;
  while (bal < TARGET && tries < 4) {
    tries++;
    try {
      const sig = await connection.requestAirdrop(t.publicKey, 1 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    } catch (e) {
      console.warn(`airdrop refused: ${(e as Error).message}`);
      break;
    }
    bal = (await connection.getBalance(t.publicKey)) / LAMPORTS_PER_SOL;
    console.log(`  → ${bal.toFixed(3)} SOL`);
  }
  if (bal < TARGET) {
    console.log(`\nStill below ${TARGET} SOL. Top up by hand at https://faucet.solana.com → ${t.publicKey.toBase58()}`);
  } else {
    console.log("Treasury OK.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

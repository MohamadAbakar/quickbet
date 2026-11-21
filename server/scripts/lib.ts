import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { explorerTx } from "../../sdk/src/index.ts";
import { fund } from "../src/faucet.ts";

export async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, {
    commitment: "confirmed",
  });
  console.log(`  ${label.padEnd(26)} ${explorerTx(sig)}`);
  return sig;
}

/** Fund N fresh wallets through the same faucet code the server uses. */
export async function freshWallets(connection: Connection, n: number) {
  const out: Keypair[] = [];
  for (let i = 0; i < n; i++) {
    const kp = Keypair.generate();
    await fund(connection, kp.publicKey.toBase58(), `script-${i}`);
    out.push(kp);
  }
  return out;
}

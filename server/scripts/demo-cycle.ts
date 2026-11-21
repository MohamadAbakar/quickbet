// Phase 3 check: a full create → join → start → vote → payout cycle on devnet
// with four generated wallets. Prints explorer links for every transaction.
import { Connection } from "@solana/web3.js";
import {
  Mode,
  TableState,
  createTableIx,
  decodeTable,
  explorerAddr,
  fmtUsdc,
  joinTableIx,
  startTableIx,
  submitResultIx,
  tablePda,
  toBase,
  ata,
} from "../../sdk/src/index.ts";
import { config } from "../src/config.ts";
import { freshWallets, send } from "./lib.ts";

async function main() {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const programId = config.programId;
  const mint = config.mint;
  console.log(`program ${programId.toBase58()} · mint ${mint.toBase58()}\nfunding 4 wallets…`);
  const players = await freshWallets(connection, 4);
  const [host] = players;
  const tableId = BigInt(1000 + Math.floor(Math.random() * 9000));
  const table = tablePda(host.publicKey, tableId, programId);
  const buyIn = toBase(5);

  console.log(`\ntable ${explorerAddr(table.toBase58())}`);
  await send(
    connection,
    [createTableIx({ host: host.publicKey, mint, tableId, mode: Mode.Match, buyIn, maxPlayers: 4, target: 5, name: "Demo cycle", programId })],
    [host],
    "create_table (host)"
  );
  for (const [i, p] of players.slice(1).entries()) {
    await send(connection, [joinTableIx({ player: p.publicKey, table, mint, programId })], [p], `join_table (seat ${i + 1})`);
  }
  await send(connection, [startTableIx({ host: host.publicKey, table, programId })], [host], "start_table");

  const payouts = [0n, buyIn * 4n, 0n, 0n]; // seat 1 wins
  for (const i of [0, 1, 2]) {
    await send(
      connection,
      [submitResultIx({ signer: players[i].publicKey, table, mint, players: players.map((p) => p.publicKey), payouts, programId })],
      [players[i]],
      `submit_result (seat ${i})`
    );
  }
  const info = await connection.getAccountInfo(table, "confirmed");
  const t = decodeTable(table, info!.data);
  console.log(`\nstate: ${TableState[t.state]}`);
  for (const [i, p] of players.entries()) {
    const b = await connection.getTokenAccountBalance(ata(p.publicKey, mint));
    console.log(`  seat ${i}: ${fmtUsdc(BigInt(b.value.amount))} USDC (demo)`);
  }
  if (t.state !== TableState.Settled) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

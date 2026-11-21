// Phase 4 check: four simulated phones play a Score match through the relay,
// then sign the result the server computes. Needs the server running.
//   SERVER_URL=http://localhost:8787 npm run sim -w server
import { Connection, Keypair } from "@solana/web3.js";
import WebSocket from "ws";
import {
  Mode,
  createTableIx,
  explorerTx,
  joinTableIx,
  startTableIx,
  submitResultIx,
  tablePda,
  toBase,
} from "../../sdk/src/index.ts";
import { config } from "../src/config.ts";
import { freshWallets, send } from "./lib.ts";

const SERVER = process.env.SERVER_URL ?? `http://localhost:${config.port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const { programId, mint } = config;
  const names = ["Maya", "Dre", "Sam", "Ava"];
  const players = await freshWallets(connection, 4);
  const tableId = BigInt(1000 + Math.floor(Math.random() * 9000));
  const table = tablePda(players[0].publicKey, tableId, programId);
  await send(connection, [createTableIx({ host: players[0].publicKey, mint, tableId, mode: Mode.Match, buyIn: toBase(5), maxPlayers: 4, target: 3, name: "Sim darts", programId })], [players[0]], "create");
  for (const p of players.slice(1)) await send(connection, [joinTableIx({ player: p.publicKey, table, mint, programId })], [p], "join");
  await send(connection, [startTableIx({ host: players[0].publicKey, table, programId })], [players[0]], "start");

  const wsUrl = SERVER.replace(/^http/, "ws") + "/ws";
  const latest: any[] = [];
  const sockets = players.map((p: Keypair, i) => {
    const ws = new WebSocket(`${wsUrl}?table=${table.toBase58()}&player=${p.publicKey.toBase58()}&name=${names[i]}`);
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "state") latest[i] = m;
      if (m.type === "error") console.log(`  [${names[i]}] error: ${m.message}`);
    });
    return ws;
  });
  await Promise.all(sockets.map((ws) => new Promise((r) => ws.once("open", r))));
  for (let k = 0; k < 40 && !(latest.length === 4 && latest.every((s) => s?.game)); k++) await sleep(250);
  console.log(`all 4 clients in the room; game = ${latest[0]?.game?.kind}`);

  // Dre scores 3 points, tapped by different phones.
  for (const tapper of [0, 2, 3]) {
    sockets[tapper].send(JSON.stringify({ type: "action", action: { type: "score", seat: 1, delta: 1 } }));
    await sleep(300);
  }
  for (let k = 0; k < 20 && !latest[0]?.result; k++) await sleep(250);
  const result: string[] = latest[0].result;
  const agree = latest.every((s) => JSON.stringify(s.result) === JSON.stringify(result));
  console.log(`server result: [${result.join(", ")}] · all clients agree: ${agree}`);

  let settleSig = "";
  for (const i of [0, 1, 2]) {
    settleSig = await send(
      connection,
      [submitResultIx({ signer: players[i].publicKey, table, mint, players: players.map((p) => p.publicKey), payouts: result.map(BigInt), programId })],
      [players[i]],
      `${names[i]} confirms`
    );
  }
  sockets[0].send(JSON.stringify({ type: "refresh" }));
  for (let k = 0; k < 40 && !latest[0]?.settleSig; k++) await sleep(250);
  console.log(`relay saw settlement: ${latest[0]?.settleSig ? explorerTx(latest[0].settleSig) : "not yet"} (client sig ${settleSig.slice(0, 8)}…)`);
  sockets.forEach((s) => s.close());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

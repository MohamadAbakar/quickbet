// QuickBet program tests. Run by `anchor test` (Surfpool local validator).
// Uses node:test + the shared SDK so the same instruction builders the app uses are exercised.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  Mode,
  TableState,
  ata,
  cancelTableIx,
  createTableIx,
  decodeTable,
  joinTableIx,
  leaveTableIx,
  refundIx,
  startTableIx,
  submitResultIx,
  tablePda,
  vaultPda,
  toBase,
} from "../sdk/src/index.ts";

const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const walletPath =
  process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
const connection = new Connection(url, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/quickbet.json", "utf8"));
const programId = new PublicKey(idl.address);

let mint: PublicKey;
let nextId = BigInt(Date.now()) * 10n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(...ixs);
      return await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    } catch (e: any) {
      if (attempt < 4 && /Blockhash not found/i.test(String(e?.message))) {
        await sleep(400);
        continue;
      }
      throw e;
    }
  }
}

async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
    const text = String(e?.message ?? e) + "\n" + logs.join("\n");
    assert.ok(text.includes(code), `expected error ${code}, got:\n${text.slice(0, 1500)}`);
    return;
  }
  assert.fail(`expected error ${code}, but the transaction succeeded`);
}

async function airdrop(pk: PublicKey, sol = 2) {
  const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

async function newPlayer(): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey);
  const tokenAcct = ata(kp.publicKey, mint);
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, tokenAcct, kp.publicKey, mint),
      createMintToInstruction(mint, tokenAcct, payer.publicKey, toBase(250)),
    ],
    [payer]
  );
  return kp;
}

async function balance(kp: Keypair | PublicKey): Promise<bigint> {
  const pk = kp instanceof Keypair ? kp.publicKey : kp;
  return (await getAccount(connection, ata(pk, mint))).amount;
}

async function readTable(table: PublicKey) {
  const info = await connection.getAccountInfo(table, "confirmed");
  assert.ok(info, "table account missing");
  return decodeTable(table, info.data);
}

interface Setup {
  table: PublicKey;
  players: Keypair[];
  buyIn: bigint;
}

async function createTable(
  host: Keypair,
  opts: { buyIn?: number; maxPlayers?: number; window?: number; mode?: Mode } = {}
) {
  const tableId = nextId++;
  const buyIn = toBase(opts.buyIn ?? 10);
  await send(
    [
      createTableIx({
        host: host.publicKey,
        mint,
        tableId,
        mode: opts.mode ?? Mode.Match,
        buyIn,
        maxPlayers: opts.maxPlayers ?? 4,
        settleWindowSecs: opts.window ?? 3600,
        target: 5,
        name: "Test table",
        programId,
      }),
    ],
    [host]
  );
  return { table: tablePda(host.publicKey, tableId, programId), buyIn };
}

async function liveTable(n: number, opts: { buyIn?: number; window?: number } = {}): Promise<Setup> {
  const players = await Promise.all(Array.from({ length: n }, () => newPlayer()));
  const { table, buyIn } = await createTable(players[0], { ...opts, maxPlayers: Math.max(n, 2) });
  for (const p of players.slice(1)) {
    await send([joinTableIx({ player: p.publicKey, table, mint, programId })], [p]);
  }
  await send([startTableIx({ host: players[0].publicKey, table, programId })], [players[0]]);
  return { table, players, buyIn };
}

function vote(s: Setup, voter: Keypair, payouts: bigint[], seatTokens?: PublicKey[]) {
  return send(
    [
      submitResultIx({
        signer: voter.publicKey,
        table: s.table,
        mint,
        players: s.players.map((p) => p.publicKey),
        seatTokens,
        payouts,
        programId,
      }),
    ],
    [voter]
  );
}

async function assertPayout(s: Setup, payouts: bigint[], before: bigint[]) {
  const t = await readTable(s.table);
  assert.equal(t.state, TableState.Settled);
  for (let i = 0; i < s.players.length; i++) {
    assert.equal(await balance(s.players[i]), before[i] + payouts[i], `seat ${i} balance`);
  }
  assert.equal((await getAccount(connection, vaultPda(s.table, programId))).amount, 0n);
}

before(async () => {
  // A freshly started local validator expires early blockhashes; let it warm up first.
  for (let i = 0; i < 120 && (await connection.getBlockHeight("confirmed")) < 40; i++) await sleep(500);
  await airdrop(payer.publicKey, 10).catch(() => {});
  mint = await createMint(connection, payer, payer.publicKey, null, 6);
});

// ---------- happy paths ----------

for (const [label, shape] of [
  ["winner takes all", [40, 0, 0, 0]],
  ["even split between two", [20, 0, 20, 0]],
  ["uneven poker stacks", [3.5, 21, 0, 15.5]],
] as const) {
  test(`4 players: ${label}`, async () => {
    const s = await liveTable(4, { buyIn: 10 });
    const payouts = shape.map((x) => toBase(x));
    const before = await Promise.all(s.players.map((p) => balance(p)));
    assert.equal(
      (await getAccount(connection, vaultPda(s.table, programId))).amount,
      toBase(40)
    );
    await vote(s, s.players[0], payouts);
    await vote(s, s.players[1], payouts);
    assert.equal((await readTable(s.table)).state, TableState.Live, "2 of 4 must not settle");
    await vote(s, s.players[2], payouts);
    await assertPayout(s, payouts, before);
  });
}

test("2-player table needs both votes", async () => {
  const s = await liveTable(2, { buyIn: 5 });
  const payouts = [toBase(10), 0n];
  const before = await Promise.all(s.players.map((p) => balance(p)));
  await vote(s, s.players[1], payouts);
  assert.equal((await readTable(s.table)).state, TableState.Live);
  await vote(s, s.players[0], payouts);
  await assertPayout(s, payouts, before);
});

test("3 of 4 identical votes settles, 2 of 4 does not", async () => {
  const s = await liveTable(4);
  const a = [toBase(40), 0n, 0n, 0n];
  const b = [0n, toBase(40), 0n, 0n];
  await vote(s, s.players[0], a);
  await vote(s, s.players[1], a);
  await vote(s, s.players[2], b);
  await vote(s, s.players[3], b);
  const t = await readTable(s.table);
  assert.equal(t.state, TableState.Live);
  assert.deepEqual(t.voted, [true, true, true, true]);
  const before = await Promise.all(s.players.map((p) => balance(p)));
  await vote(s, s.players[2], a); // switch to a → 3 of 4
  await assertPayout(s, a, before);
});

test("a player changing their vote", async () => {
  const s = await liveTable(4);
  const x = [toBase(40), 0n, 0n, 0n];
  const y = [toBase(10), toBase(10), toBase(10), toBase(10)];
  await vote(s, s.players[0], x);
  await vote(s, s.players[1], y);
  await vote(s, s.players[0], y); // changed: now y has 2
  let t = await readTable(s.table);
  assert.equal(t.state, TableState.Live);
  assert.deepEqual(t.votes[0], y);
  const before = await Promise.all(s.players.map((p) => balance(p)));
  await vote(s, s.players[3], y);
  await assertPayout(s, y, before);
});

// ---------- rejections ----------

test("rejects wrong payout sum and wrong length", async () => {
  const s = await liveTable(3);
  await expectError(vote(s, s.players[0], [toBase(30), 0n, 1n]), "WrongPayoutSum");
  await expectError(vote(s, s.players[0], [toBase(30), 0n]), "WrongPayoutLength");
});

test("rejects a non-player voting", async () => {
  const s = await liveTable(2);
  const outsider = await newPlayer();
  await expectError(vote(s, outsider, [toBase(20), 0n]), "NotSeated");
});

test("rejects joining twice, joining a full table and joining a started table", async () => {
  const host = await newPlayer();
  const p1 = await newPlayer();
  const p2 = await newPlayer();
  const { table } = await createTable(host, { maxPlayers: 2 });
  await expectError(
    send([joinTableIx({ player: host.publicKey, table, mint, programId })], [host]),
    "AlreadySeated"
  );
  await send([joinTableIx({ player: p1.publicKey, table, mint, programId })], [p1]);
  await expectError(
    send([joinTableIx({ player: p2.publicKey, table, mint, programId })], [p2]),
    "TableFull"
  );

  const s = await liveTable(2);
  const late = await newPlayer();
  await expectError(
    send([joinTableIx({ player: late.publicKey, table: s.table, mint, programId })], [late]),
    "NotOpen"
  );
});

test("rejects start by non-host and start with one player", async () => {
  const host = await newPlayer();
  const p1 = await newPlayer();
  const { table } = await createTable(host);
  await expectError(
    send([startTableIx({ host: host.publicKey, table, programId })], [host]),
    "NotEnoughPlayers"
  );
  await send([joinTableIx({ player: p1.publicKey, table, mint, programId })], [p1]);
  await expectError(
    send([startTableIx({ host: p1.publicKey, table, programId })], [p1]),
    "NotHost"
  );
});

test("rejects refund before the deadline", async () => {
  const s = await liveTable(2, { window: 3600 });
  await expectError(
    send(
      [
        refundIx({
          signer: s.players[1].publicKey,
          table: s.table,
          mint,
          players: s.players.map((p) => p.publicKey),
          programId,
        }),
      ],
      [s.players[1]]
    ),
    "DeadlineNotReached"
  );
});

test("rejects any action after Settled", async () => {
  const s = await liveTable(2);
  const payouts = [toBase(20), 0n];
  await vote(s, s.players[0], payouts);
  await vote(s, s.players[1], payouts);
  await expectError(vote(s, s.players[0], payouts), "NotLive");
  const late = await newPlayer();
  await expectError(
    send([joinTableIx({ player: late.publicKey, table: s.table, mint, programId })], [late]),
    "NotOpen"
  );
  await expectError(
    send([startTableIx({ host: s.players[0].publicKey, table: s.table, programId })], [s.players[0]]),
    "NotOpen"
  );
});

test("refund after the deadline, then nothing else works", async () => {
  const s = await liveTable(3, { window: 2 });
  const before = await Promise.all(s.players.map((p) => balance(p)));
  await sleep(4000);
  const anyone = await newPlayer();
  await send(
    [
      refundIx({
        signer: anyone.publicKey,
        table: s.table,
        mint,
        players: s.players.map((p) => p.publicKey),
        programId,
      }),
    ],
    [anyone]
  );
  const t = await readTable(s.table);
  assert.equal(t.state, TableState.Refunded);
  for (let i = 0; i < 3; i++) {
    assert.equal(await balance(s.players[i]), before[i] + s.buyIn);
  }
  await expectError(vote(s, s.players[0], [toBase(30), 0n, 0n]), "NotLive");
});

test("rejects the wrong token account for a seat at payout", async () => {
  const s = await liveTable(2);
  const payouts = [toBase(20), 0n];
  await vote(s, s.players[0], payouts);
  // Seat 1's payout account swapped for seat 0's account.
  const wrong = [ata(s.players[0].publicKey, mint), ata(s.players[0].publicKey, mint)];
  await expectError(vote(s, s.players[1], payouts, wrong), "WrongSeatAccount");
  assert.equal((await readTable(s.table)).state, TableState.Live);
});

// ---------- leave / cancel ----------

test("leave returns the buy-in; host cannot leave; cancel refunds everyone", async () => {
  const host = await newPlayer();
  const p1 = await newPlayer();
  const p2 = await newPlayer();
  const { table, buyIn } = await createTable(host);
  await send([joinTableIx({ player: p1.publicKey, table, mint, programId })], [p1]);
  await send([joinTableIx({ player: p2.publicKey, table, mint, programId })], [p2]);

  const p1Before = await balance(p1);
  await send([leaveTableIx({ player: p1.publicKey, table, mint, programId })], [p1]);
  assert.equal(await balance(p1), p1Before + buyIn);
  await expectError(
    send([leaveTableIx({ player: host.publicKey, table, mint, programId })], [host]),
    "HostCannotLeave"
  );

  const t = await readTable(table);
  assert.deepEqual(
    t.players.map((p) => p.toBase58()),
    [host.publicKey.toBase58(), p2.publicKey.toBase58()]
  );

  const hb = await balance(host);
  const p2b = await balance(p2);
  await send(
    [cancelTableIx({ signer: host.publicKey, table, mint, players: t.players, programId })],
    [host]
  );
  assert.equal((await readTable(table)).state, TableState.Refunded);
  assert.equal(await balance(host), hb + buyIn);
  assert.equal(await balance(p2), p2b + buyIn);
});

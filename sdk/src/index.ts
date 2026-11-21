// QuickBet client SDK: PDAs, instruction builders and Table decoding.
// Shared by tests, server, scripts and the web app. Uses @solana/web3.js v1.
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  type AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";

export const DEFAULT_PROGRAM_ID = new PublicKey(
  "5PvfZ55DA7pK1zK1AAd1HLPXZmbdykFBFFuU4i6KepJ3"
);
export const USDC_DECIMALS = 6;
export const MAX_PLAYERS = 6;
export const DEFAULT_SETTLE_WINDOW_SECS = 24 * 60 * 60;

export enum Mode {
  Poker = 0,
  Side = 1,
  Match = 2,
}
export enum TableState {
  Open = 0,
  Live = 1,
  Settled = 2,
  Refunded = 3,
}
export const STATE_NAMES = ["Open", "Live", "Settled", "Refunded"] as const;

// sha256("global:<name>")[0..8], precomputed
const IX = {
  create_table: [214, 142, 131, 250, 242, 83, 135, 185],
  join_table: [14, 117, 84, 51, 95, 146, 171, 70],
  leave_table: [163, 153, 94, 194, 19, 106, 113, 32],
  start_table: [91, 116, 250, 224, 237, 255, 111, 201],
  submit_result: [240, 42, 89, 180, 10, 239, 9, 214],
  refund: [2, 96, 183, 251, 63, 208, 46, 46],
  cancel_table: [242, 161, 251, 74, 29, 143, 155, 203],
} as const;
export const IX_DISCRIMINATORS = IX;
// sha256("account:Table")[0..8]
export const TABLE_DISCRIMINATOR = [34, 100, 138, 97, 236, 129, 230, 112];

// ---------- encoding helpers ----------
const u8 = (n: number) => Buffer.from([n & 0xff]);
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const str = (s: string) => {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};
const vecU64 = (v: (bigint | number)[]) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(v.length);
  return Buffer.concat([len, ...v.map(u64)]);
};

// ---------- PDAs ----------
export function tablePda(
  host: PublicKey,
  tableId: bigint | number,
  programId = DEFAULT_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("table"), host.toBuffer(), u64(tableId)],
    programId
  )[0];
}

export function vaultPda(table: PublicKey, programId = DEFAULT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), table.toBuffer()],
    programId
  )[0];
}

export function ata(owner: PublicKey, mint: PublicKey) {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
}

// ---------- Table account ----------
export interface TableAccount {
  address: PublicKey;
  host: PublicKey;
  tableId: bigint;
  mint: PublicKey;
  buyIn: bigint;
  maxPlayers: number;
  mode: Mode;
  target: number;
  state: TableState;
  settleWindowSecs: bigint;
  deadlineTs: bigint;
  createdTs: bigint;
  bump: number;
  vaultBump: number;
  players: PublicKey[];
  voted: boolean[];
  votes: bigint[][];
  name: string;
}

export function decodeTable(address: PublicKey, raw: Uint8Array): TableAccount {
  const data = Buffer.from(raw);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== TABLE_DISCRIMINATOR[i]) throw new Error("Not a Table account");
  }
  let o = 8;
  const pk = () => {
    const p = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return p;
  };
  const rU64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const rI64 = () => {
    const v = data.readBigInt64LE(o);
    o += 8;
    return v;
  };
  const rU8 = () => data[o++];

  const host = pk();
  const tableId = rU64();
  const mint = pk();
  const buyIn = rU64();
  const maxPlayers = rU8();
  const mode = rU8() as Mode;
  const target = rU8();
  const state = rU8() as TableState;
  const settleWindowSecs = rI64();
  const deadlineTs = rI64();
  const createdTs = rI64();
  const bump = rU8();
  const vaultBump = rU8();
  const nPlayers = data.readUInt32LE(o);
  o += 4;
  const players: PublicKey[] = [];
  for (let i = 0; i < nPlayers; i++) players.push(pk());
  const voted: boolean[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) voted.push(rU8() === 1);
  const votes: bigint[][] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const row: bigint[] = [];
    for (let j = 0; j < MAX_PLAYERS; j++) row.push(rU64());
    votes.push(row);
  }
  const nameLen = data.readUInt32LE(o);
  o += 4;
  const name = data.subarray(o, o + nameLen).toString("utf8");

  return {
    address,
    host,
    tableId,
    mint,
    buyIn,
    maxPlayers,
    mode,
    target,
    state,
    settleWindowSecs,
    deadlineTs,
    createdTs,
    bump,
    vaultBump,
    players,
    voted: voted.slice(0, nPlayers),
    votes: votes.slice(0, nPlayers).map((r) => r.slice(0, nPlayers)),
    name,
  };
}

/** Offset of table_id inside the account data (for memcmp filters). */
export const TABLE_ID_OFFSET = 8 + 32;

// ---------- instruction builders ----------
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey, writable = false): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: writable,
});

export interface CreateTableArgs {
  host: PublicKey;
  mint: PublicKey;
  tableId: bigint | number;
  mode: Mode;
  buyIn: bigint | number;
  maxPlayers: number;
  settleWindowSecs?: bigint | number;
  target?: number;
  name: string;
  hostToken?: PublicKey;
  programId?: PublicKey;
}

export function createTableIx(a: CreateTableArgs): TransactionInstruction {
  const programId = a.programId ?? DEFAULT_PROGRAM_ID;
  const table = tablePda(a.host, a.tableId, programId);
  const data = Buffer.concat([
    Buffer.from(IX.create_table),
    u64(a.tableId),
    u8(a.mode),
    u64(a.buyIn),
    u8(a.maxPlayers),
    i64(a.settleWindowSecs ?? DEFAULT_SETTLE_WINDOW_SECS),
    u8(a.target ?? 0),
    str(a.name),
  ]);
  return new TransactionInstruction({
    programId,
    data,
    keys: [
      s(a.host, true),
      r(a.mint),
      w(a.hostToken ?? ata(a.host, a.mint)),
      w(table),
      w(vaultPda(table, programId)),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
  });
}

interface SeatArgs {
  player: PublicKey;
  table: PublicKey;
  mint: PublicKey;
  playerToken?: PublicKey;
  programId?: PublicKey;
}

function seatIx(name: "join_table" | "leave_table", a: SeatArgs) {
  const programId = a.programId ?? DEFAULT_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: Buffer.from(IX[name]),
    keys: [
      s(a.player),
      w(a.table),
      r(a.mint),
      w(a.playerToken ?? ata(a.player, a.mint)),
      w(vaultPda(a.table, programId)),
      r(TOKEN_PROGRAM_ID),
    ],
  });
}
export const joinTableIx = (a: SeatArgs) => seatIx("join_table", a);
export const leaveTableIx = (a: SeatArgs) => seatIx("leave_table", a);

export function startTableIx(a: { host: PublicKey; table: PublicKey; programId?: PublicKey }) {
  return new TransactionInstruction({
    programId: a.programId ?? DEFAULT_PROGRAM_ID,
    data: Buffer.from(IX.start_table),
    keys: [s(a.host), w(a.table)],
  });
}

interface PayoutArgs {
  signer: PublicKey;
  table: PublicKey;
  mint: PublicKey;
  /** Seat order. Defaults to each player's associated token account. */
  players: PublicKey[];
  seatTokens?: PublicKey[];
  programId?: PublicKey;
}

function payoutKeys(a: PayoutArgs): AccountMeta[] {
  const programId = a.programId ?? DEFAULT_PROGRAM_ID;
  const seats = a.seatTokens ?? a.players.map((p) => ata(p, a.mint));
  return [
    s(a.signer),
    w(a.table),
    r(a.mint),
    w(vaultPda(a.table, programId)),
    r(TOKEN_PROGRAM_ID),
    ...seats.map(w),
  ];
}

export function submitResultIx(a: PayoutArgs & { payouts: (bigint | number)[] }) {
  return new TransactionInstruction({
    programId: a.programId ?? DEFAULT_PROGRAM_ID,
    data: Buffer.concat([Buffer.from(IX.submit_result), vecU64(a.payouts)]),
    keys: payoutKeys(a),
  });
}

export function refundIx(a: PayoutArgs) {
  return new TransactionInstruction({
    programId: a.programId ?? DEFAULT_PROGRAM_ID,
    data: Buffer.from(IX.refund),
    keys: payoutKeys(a),
  });
}

export function cancelTableIx(a: PayoutArgs) {
  return new TransactionInstruction({
    programId: a.programId ?? DEFAULT_PROGRAM_ID,
    data: Buffer.from(IX.cancel_table),
    keys: payoutKeys(a),
  });
}

// ---------- formatting ----------
export const toBase = (usdc: number) => BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
export const fromBase = (base: bigint | number) => Number(base) / 10 ** USDC_DECIMALS;
export const fmtUsdc = (base: bigint | number) => fromBase(base).toFixed(2);
export const short = (pk: PublicKey | string) => {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return s.slice(0, 4) + "…" + s.slice(-4);
};
export const tableCode = (tableId: bigint | number) => "TABLE-" + String(tableId);
export const explorerTx = (sig: string, cluster = "devnet") =>
  `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
export const explorerAddr = (addr: string, cluster = "devnet") =>
  `https://explorer.solana.com/address/${addr}?cluster=${cluster}`;

/** Pull the Anchor error message out of a failed transaction's logs/message. */
export function readableError(e: unknown): string {
  const anyE = e as { logs?: string[]; message?: string; transactionLogs?: string[] };
  const logs = anyE?.logs ?? anyE?.transactionLogs ?? [];
  for (const l of logs) {
    const m = l.match(/Error Message: (.*)$/);
    if (m) return m[1].replace(/\.$/, "");
  }
  return anyE?.message ?? String(e);
}

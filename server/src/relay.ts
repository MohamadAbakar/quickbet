// WebSocket rooms: one per table. The server is authoritative for game state.
// It polls the Table account so lobby seats, lock status, votes and settlement
// appear on every phone without clients needing their own subscriptions.
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TableState,
  decodeTable,
  vaultPda,
  type TableAccount,
} from "../../sdk/src/index.ts";
import { config } from "./config.ts";
import { applyAction, gameResult, initGame, RuleError, type GameCtx, type GameState } from "./games.ts";

interface Client {
  ws: WebSocket;
  player: string;
}

interface Room {
  key: string;
  table: TableAccount | null;
  vault: string;
  game: GameState | null;
  names: Record<string, string>;
  clients: Set<Client>;
  settleSig: string | null;
  lastSnapshot: string;
  error: string | null;
}

const rooms = new Map<string, Room>();

export function tableJson(t: TableAccount) {
  return {
    address: t.address.toBase58(),
    host: t.host.toBase58(),
    tableId: t.tableId.toString(),
    mint: t.mint.toBase58(),
    buyIn: t.buyIn.toString(),
    maxPlayers: t.maxPlayers,
    mode: t.mode,
    target: t.target,
    state: t.state,
    deadlineTs: t.deadlineTs.toString(),
    createdTs: t.createdTs.toString(),
    players: t.players.map((p) => p.toBase58()),
    voted: t.voted,
    votes: t.votes.map((v) => v.map(String)),
    name: t.name,
  };
}

const ctxOf = (t: TableAccount): GameCtx => ({
  n: t.players.length,
  buyIn: Number(t.buyIn),
  host: 0,
  target: t.target,
});

async function fetchRoom(connection: Connection, room: Room) {
  const pk = new PublicKey(room.key);
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info) {
    room.table = null;
    return;
  }
  if (!info.owner.equals(config.programId)) throw new Error("Not a QuickBet table");
  room.table = decodeTable(pk, info.data);
  const vault = await connection
    .getTokenAccountBalance(vaultPda(pk, config.programId), "confirmed")
    .catch(() => null);
  room.vault = vault?.value.amount ?? "0";

  if (room.table.state === TableState.Live && !room.game) {
    room.game = initGame(room.table.mode, ctxOf(room.table));
  }
  if (room.table.state === TableState.Settled && !room.settleSig) {
    const sigs = await connection.getSignaturesForAddress(pk, { limit: 5 }, "confirmed");
    room.settleSig = sigs.find((s) => !s.err)?.signature ?? null;
  }
}

function snapshotFor(room: Room, c: Client) {
  const t = room.table;
  const seat = t ? t.players.findIndex((p) => p.toBase58() === c.player) : -1;
  let result: string[] | null = null;
  if (t && room.game && seat >= 0) {
    try {
      result = gameResult(room.game, ctxOf(t))?.map(String) ?? null;
    } catch (e) {
      room.error = String(e);
    }
  }
  return {
    type: "state",
    table: t ? tableJson(t) : null,
    vault: room.vault,
    seat,
    names: room.names,
    // Only seated players see the live game (spec 5: room membership is on-chain).
    game: seat >= 0 ? room.game : null,
    result,
    settleSig: room.settleSig,
    online: [...new Set([...room.clients].map((x) => x.player))],
    serverTime: Date.now(),
  };
}

function broadcast(room: Room, force = false) {
  const base = JSON.stringify([room.table && tableJson(room.table), room.vault, room.game, room.names, room.settleSig, room.clients.size]);
  if (!force && base === room.lastSnapshot) return;
  room.lastSnapshot = base;
  for (const c of room.clients) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(snapshotFor(room, c)));
  }
}

export function attachRelay(server: import("node:http").Server, connection: Connection) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://x");
    const tableKey = url.searchParams.get("table") ?? "";
    const player = url.searchParams.get("player") ?? "";
    const name = (url.searchParams.get("name") ?? "").slice(0, 24);
    try {
      new PublicKey(tableKey);
      new PublicKey(player);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Bad table or player" }));
      return ws.close();
    }

    let room = rooms.get(tableKey);
    if (!room) {
      room = {
        key: tableKey,
        table: null,
        vault: "0",
        game: null,
        names: {},
        clients: new Set(),
        settleSig: null,
        lastSnapshot: "",
        error: null,
      };
      rooms.set(tableKey, room);
    }
    const r = room;
    const client: Client = { ws, player };
    r.clients.add(client);
    if (name) r.names[player] = name;

    try {
      await fetchRoom(connection, r);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) }));
    }
    ws.send(JSON.stringify(snapshotFor(r, client)));
    broadcast(r, true);

    ws.on("message", async (buf) => {
      let msg: any;
      try {
        msg = JSON.parse(String(buf));
      } catch {
        return;
      }
      if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "name") {
        r.names[player] = String(msg.name ?? "").slice(0, 24);
        return broadcast(r, true);
      }
      if (msg.type === "refresh") {
        try {
          await fetchRoom(connection, r);
        } catch {}
        return broadcast(r, true);
      }
      if (msg.type === "action") {
        const t = r.table;
        const seat = t ? t.players.findIndex((p) => p.toBase58() === player) : -1;
        if (!t || seat < 0) {
          return ws.send(JSON.stringify({ type: "error", message: "You are not seated at this table" }));
        }
        if (t.state !== TableState.Live || !r.game) {
          return ws.send(JSON.stringify({ type: "error", message: "The game has not started" }));
        }
        try {
          r.game = applyAction(r.game, seat, msg.action ?? {}, ctxOf(t));
          broadcast(r, true);
        } catch (e) {
          const message = e instanceof RuleError ? e.message : "Invalid action";
          ws.send(JSON.stringify({ type: "error", message }));
        }
      }
    });

    ws.on("close", () => {
      r.clients.delete(client);
      broadcast(r, true);
    });
  });

  // Poll chain state for rooms with listeners.
  setInterval(async () => {
    for (const room of rooms.values()) {
      if (room.clients.size === 0) continue;
      try {
        await fetchRoom(connection, room);
        broadcast(room);
      } catch {}
    }
  }, 2500);

  // Keepalive: phones drop idle sockets.
  setInterval(() => {
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20_000);
}

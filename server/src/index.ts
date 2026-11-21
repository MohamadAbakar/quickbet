import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { TABLE_ID_OFFSET, TableState, decodeTable } from "../../sdk/src/index.ts";
import { config, SERVER_ROOT } from "./config.ts";
import { fund, FaucetError } from "./faucet.ts";
import { attachRelay } from "./relay.ts";

const connection = new Connection(config.rpcUrl, "confirmed");
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10kb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  const ok = config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
  if (ok && origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    cluster: "devnet",
    programId: config.programId.toBase58(),
    mint: config.mint.toBase58(),
  });
});

/** Public, non-secret config so the app can be pointed at a server only. */
app.get("/config", (_req, res) => {
  res.json({ programId: config.programId.toBase58(), mint: config.mint.toBase58(), rpcUrl: config.rpcUrl });
});

app.post("/faucet", async (req, res) => {
  try {
    const out = await fund(connection, String(req.body?.pubkey ?? ""), req.ip ?? "unknown");
    res.json(out);
  } catch (e) {
    const status = e instanceof FaucetError ? e.status : 500;
    res.status(status).json({ error: (e as Error).message });
  }
});

/** Resolve a short table code (TABLE-1234) to the table address. */
app.get("/tables/code/:code", async (req, res) => {
  const digits = String(req.params.code).replace(/\D/g, "");
  if (!digits) return res.status(400).json({ error: "Type the digits from the table code" });
  try {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(digits));
    const accounts = await connection.getProgramAccounts(config.programId, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: TABLE_ID_OFFSET, bytes: bs58.encode(idBytes) } }],
    });
    const tables = accounts
      .map((a) => {
        try {
          return decodeTable(a.pubkey, a.account.data);
        } catch {
          return null;
        }
      })
      .filter((t): t is NonNullable<typeof t> => !!t)
      .sort((a, b) => {
        const openA = a.state === TableState.Open ? 1 : 0;
        const openB = b.state === TableState.Open ? 1 : 0;
        return openB - openA || Number(b.createdTs - a.createdTs);
      });
    if (!tables.length) return res.status(404).json({ error: "No table with that code" });
    res.json({ table: tables[0].address.toBase58() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Local-network fallback: serve the built web app from the same origin when present.
const webDist = path.resolve(SERVER_ROOT, "../app/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!ws|faucet|health|config|tables).*/, (_req, res) =>
    res.sendFile(path.join(webDist, "index.html"))
  );
}

const server = http.createServer(app);
attachRelay(server, connection);
server.listen(config.port, "0.0.0.0", () => {
  // Validate config early (throws with a readable message if .env is incomplete).
  new PublicKey(config.programId);
  console.log(`QuickBet server on :${config.port} · rpc ${config.rpcUrl} · program ${config.programId.toBase58()}`);
});

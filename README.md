# QuickBet: devnet demo

> **Demo · devnet · no real funds.** Test tokens only. No house fee, no rake.

Friends at a table scan a QR code with their phones. Each one locks a demo-USDC buy-in into an on-chain escrow on **Solana devnet**. They play a game in the app, and the escrow pays out when more than half the table signs the same result.

```
programs/quickbet/   Anchor program: escrow, voting, payout, refund
tests/               Program tests (node:test against a local validator)
sdk/                 Shared TypeScript client: PDAs, instruction builders, Table decoder
server/              Node + TypeScript: faucet, WebSocket game relay, devnet scripts
app/                 Vite + React + TypeScript mobile web app (PWA)
mockup/              Clickable design demo (standalone HTML, no chain), also served by the app at /mockup.html
```

## Status

| Phase | State |
|---|---|
| 1. Toolchain + scaffold, `anchor build` | Done. Builds in CI (`.github/workflows/program.yml`). |
| 2. Program + tests | Written. All tests run in CI on every push. |
| 3. Devnet deploy + setup script | Scripts ready (`setup-devnet`, `topup`, `demo-cycle`). **You run the deploy** (needs your deployer wallet). |
| 4. Server | Done. Faucet, relay, all three games. Rules unit-tested (`npm test -w server`). Four-client sim: `npm run sim -w server`. |
| 5–7. App | Home, set up, QR lobby, join by link or code, lock, start, Score match, Pick a side, Poker table, confirm and sign, payout, refund. |
| 8. Polish | In-app QR scanner, auto-reconnect, tx pending/success/failure with retry, explorer links. Rehearse on real phones. |

## Pinned versions

| Tool | Version | Why |
|---|---|---|
| Anchor CLI / `anchor-lang` / `anchor-spl` | **1.1.2** | Version the official Solana installer installs |
| Solana CLI (Agave) | **3.1.10** | CI-tested pairing for Anchor 1.1.x |
| Rust | stable (MSRV 1.89) | |
| Node | 24 (≥ 20.18) | |
| `@solana/web3.js` | 1.99.x | Stable v1 API (the spec allows web3.js or Kit) |
| `@solana/spl-token` | 0.4.x | |
| React / Vite | 19 / 8 | |

The Solana MCP server was not connected in the build session. Versions and Anchor 1.x API changes (CPI contexts take the program ID, `Context<'info, T>`) were checked against the Solana Foundation `solana-dev` skill references, the official installer script, and the npm and crates.io registries.

## Design decisions and deviations from the spec

- **Votes are stored in full, not hashed.** `Table.votes` holds each seat's payout vector (at most 6 × 6 `u64`). This is the same majority rule as comparing hashes, with no hashing dependency, and anyone can read the votes on the explorer.
- **`Table` also stores `name` (40 bytes) and `target`.** Joiners see the bet name and the Score match target straight from the chain, so the lobby works even if the server restarts.
- **Table code = `TABLE-<table_id>`.** The host's app picks a random 4-digit `table_id`. The server resolves a code by filtering program accounts on `table_id`, so codes survive server restarts.
- **Only seated players get game state** from the relay. Anyone with the link sees the lobby, which they need in order to join. The relay trusts the `player` query parameter without a signature. That's fine for a devnet demo; add a signed challenge before anything real.
- **Tests run on `solana-test-validator`.** Anchor 1.x defaults to Surfpool, which returned "Blockhash not found" during parallel test setup in CI.

## Setup (once)

Install the toolchain (Rust, Solana CLI, Anchor, Surfpool):

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

Then:

```bash
git clone https://github.com/MohamadAbakar/quickbet && cd quickbet
npm install

# 1. Deployer wallet on devnet (yours; never commit it)
solana config set --url devnet
solana-keygen new                       # skip if ~/.config/solana/id.json exists
solana airdrop 2                        # or https://faucet.solana.com (deploy needs ~3 SOL)

# 2. Program
anchor keys sync                        # writes your program ID into lib.rs + Anchor.toml
NO_DNA=1 anchor build
NO_DNA=1 anchor test                    # local validator
anchor deploy --provider.cluster devnet
anchor keys list                        # → your PROGRAM_ID

# 3. Demo mint + treasury + server/.env
cp server/.env.example server/.env      # then set PROGRAM_ID=<your program id>
npm run setup-devnet -w server          # creates keys/, demo USDC mint, funds treasury
npm run topup -w server                 # check/top up treasury SOL

# 4. Prove the escrow on devnet (prints explorer links)
npm run demo-cycle -w server
```

Record the deployed program ID here and in `server/.env.example` once deployed:

> **Program ID (devnet):** _set after deploy_

## Run

```bash
npm run start -w server                 # API + relay on :8787
echo "VITE_SERVER_URL=http://localhost:8787" > app/.env.local
npm run dev -w app                      # app on :5173 (and your LAN IP)
npm run sim -w server                   # 4 simulated phones play Score match through the relay
```

### Local fallback (venue Wi-Fi blocks something)

One command builds the app and serves app, API and WebSocket from your Mac on the local network:

```bash
npm run dev
```

It prints `http://<your-LAN-IP>:8787`. Phones on the same Wi-Fi (or your hotspot) scan the lobby QR with the **built-in camera app**. The in-app scanner needs HTTPS, so on plain HTTP use the camera app or type the table code.

## Deploying for the presentation (HTTPS required for camera + WebSockets on phones)

**Server → Render** (free web service, supports WebSockets):
1. New → Web Service → connect this repo. Root directory: repo root.
2. Build: `npm install`. Start: `npm run start -w server`.
3. Env vars: `RPC_URL`, `PROGRAM_ID`, `DEMO_MINT`, `ALLOWED_ORIGIN=https://<your-app>.vercel.app`, and the keypairs as JSON arrays: `TREASURY_SECRET` and `MINT_AUTHORITY_SECRET` (the contents of `server/keys/*.json`; paste them only into the host's secret settings).
4. The free plan sleeps after 15 minutes idle. Open `https://<server>/health` five minutes before you go on stage.

**App → Vercel** (or Netlify / Cloudflare Pages):
1. New project → this repo → Root directory `app`, framework Vite.
2. Env var `VITE_SERVER_URL=https://<your-server>.onrender.com`.
3. Add a rewrite so `/t/<table>` deep links load the app: `app/vercel.json` is included.

## Demo script (two minutes)

1. Open the app on your phone. Tap **New bet** → **Score match** → 5 USDC → **Create table and show QR**.
2. Two or three volunteers scan the QR with their own phone cameras and tap **Lock 5 USDC in escrow**. Point at **In escrow** rising.
3. Tap **Everyone's in. Start game**. Tap + a few times until someone reaches the target.
4. Everyone taps **Confirm … as winner** → **Confirm and sign**. Show the payout screen, then tap **View the settlement on Solana Explorer**. That's the proof the escrow is real.
5. Mention the 24-hour refund rule (no agreed result → anyone can return every buy-in) and that there is **no house fee**.
6. If there is time, show the poker table.

### Pre-demo checklist

- [ ] `npm run topup -w server`. The treasury has at least 3 SOL (about 60 new wallets).
- [ ] Server awake: `https://<server>/health` returns `ok`.
- [ ] Phones charged; your phone has opened the app once (funded wallet).
- [ ] A backup table already created and waiting in its lobby.
- [ ] The clickable mockup open in a browser tab as a fallback: `https://<your-app>/mockup.html` (or open `mockup/quickbet-demo.html` locally).
- [ ] Hotspot ready plus `npm run dev` on the Mac in case venue Wi-Fi blocks things.

## Out of scope

Mainnet, real USDC, KYC, geo-restriction, production key management, side pots, more than 6 players, native mobile apps, accounts or logins.

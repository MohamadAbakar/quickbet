# QuickBet — devnet demo

> **Demo · devnet · no real funds.** Test tokens only. No house fee.

Friends at a table scan a QR code, lock a demo-USDC buy-in into an on-chain escrow on Solana devnet, play a game in the app, and the escrow pays out when a majority of the table agrees on the result.

Work in progress. Status by phase:

- [x] Monorepo scaffold, Anchor program (`programs/quickbet`)
- [ ] Program tests
- [ ] Devnet deploy + setup scripts
- [ ] Server (faucet + WebSocket relay)
- [ ] Mobile web app

## Pinned versions

| Tool | Version |
|---|---|
| Anchor CLI / `anchor-lang` / `anchor-spl` | 1.1.2 |
| Solana CLI (Agave) | 3.1.10 |
| Surfpool | 1.4.0 |
| Node | 24 |
| `@solana/web3.js` | 1.99.x |
| `@solana/spl-token` | 0.4.x |

## Build

```bash
anchor keys sync      # first time: point declare_id! at your program keypair
NO_DNA=1 anchor build
```

CI (`.github/workflows/program.yml`) builds and tests the program on every push.

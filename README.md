# HyperScope

Read-only Hyperliquid perception tools for trading agents. Give it a wallet and it tells you the open perp positions. Give it a vault address and it tells you everything about that vault. Ask it for vaults and it hands back a sorted shortlist out of the ~9,400 live ones. Then it puts an AI read on top: a grounded risk assessment of a wallet's positions, and a follow / watch / avoid verdict on a vault.

Built for the Bitget AI Base Camp Hackathon S1, Trading Infra track. The idea is simple: an autonomous trading agent needs to perceive the market before it acts, and a lot of that perception is just "what is this wallet holding" and "is this vault worth following". The raw data is the easy half. The harder half is judgment, so HyperScope also asks a model to turn the numbers into something an agent can act on. The data tools need no keys at all; the AI layer uses NVIDIA's free NIM API.

There's also a browser UI at the root path (`/`) that drives all of this, so you can see it working without writing any client code.

## Why this exists

Every agent that touches Hyperliquid ends up writing the same boilerplate: POST to the info endpoint, dig through `assetPositions`, work out long vs short from the sign of `szi`, coerce all the stringified numbers, hunt down a vault listing that isn't even in the documented API. HyperScope does that once so your agent doesn't have to. Same response shape on every call, so you parse it the same way every time.

## The three tools

Every response comes back in the same envelope: `version`, the `service` that answered, the `request` it received, and the `data`.

### 1. Open positions

```
POST /positions
{ "wallet": "0x..." }
```

Returns the wallet's current open perpetual positions. For each one: coin, side (long or short, derived from the sign of the size), size, entry price, position value, unrealized PnL, liquidation price, return on equity, and leverage (type and value). Missing the wallet field returns `error: missing_wallet_field`.

### 2. Vault review

```
POST /vault
{ "vault": "0x..." }
```

Reviews a single vault: leader, strategy description, APR, follower count, leader fraction and commission, how much is distributable and withdrawable, whether it's closed, and whether it's taking deposits.

### 3. Vault discovery

```
GET /vaults?sort=tvl&order=desc&limit=50
```

A sortable shortlist of vaults: address, name, leader, TVL, APR, status, relationship type, and creation time. Sort by `tvl`, `apr`, or `createTimeMillis`, order `asc` or `desc`, limit 1 to 500. `data.total` tells you how many vaults exist in total.

### 4. AI risk read (positions)

```
POST /analyze/positions
{ "wallet": "0x..." }
```

Fetches the wallet's positions, computes grounded facts (net long vs short notional, total unrealized PnL, max leverage, nearest liquidation distance), hands them to the model, and returns a structured read: `riskLevel`, `netBias`, a short `summary`, and a list of `signals`.

### 5. AI vault verdict

```
POST /analyze/vault
{ "vault": "0x..." }
```

Reviews the vault and returns a `verdict` (follow / watch / avoid), a `score` out of 100, a `summary`, and `pros` / `cons`. The model is told to be skeptical of unsustainable APRs.

Both AI endpoints need `NVIDIA_API_KEY` set (see below). Without it they return `error: ai_not_configured` and `GET /ai/status` reports `{ enabled: false }`, so the UI degrades gracefully.

## Run it

Needs Node 18 or newer.

```bash
npm install
npm run build
npm start          # serves on :3000, or set PORT
```

Or in watch mode while developing:

```bash
npm run dev
```

Then open `http://localhost:3000` for the landing page, `http://localhost:3000/app` for the workspace where you run each service (deep-linkable per tool, e.g. `/app?s=vault`), or hit the endpoints directly.

### Turning on the AI layer

The two `/analyze/*` endpoints need an NVIDIA NIM key. Get one free at [build.nvidia.com](https://build.nvidia.com), then:

```bash
export NVIDIA_API_KEY="nvapi-..."
# optional, defaults to meta/llama-3.3-70b-instruct
export NVIDIA_MODEL="meta/llama-3.3-70b-instruct"
```

The data tools (positions, vault, vaults) work with or without it.

Quick check once it's up:

```bash
curl localhost:3000/health

curl -X POST localhost:3000/positions \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xd6e56265890b76413d1d527eb9b75e334c0c5b42"}'

curl -X POST localhost:3000/vault \
  -H "Content-Type: application/json" \
  -d '{"vault":"0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"}'

curl "localhost:3000/vaults?sort=apr&order=desc&limit=10"
```

## Sample output

The `samples/` folder holds real captured responses from a live run, so you can see the exact shapes without starting anything: `positions.json` (a vault holding 34 open positions), `vault.json` (the HLP vault), and `vaults.json` (top 3 by TVL).

## How it's wired

Three layers, kept apart on purpose. `src/hyperliquid.ts` is the data layer: pure functions that hit Hyperliquid and normalize the result, no web framework in sight, so the same logic can back an MCP server or a CLI later without a rewrite. `src/envelope.ts` is the shared response shape. `src/server.ts` is the thin Express layer that validates input and wraps each call in the envelope.

Data sources, both public and unauthenticated:
- Positions and vault review: `https://api.hyperliquid.xyz/info`
- Vault discovery: `https://stats-data.hyperliquid.xyz/Mainnet/vaults`

## Deploy

There's a `render.yaml` for one-click deploy on Render. Build with `npm install && npm run build`, start with `npm start`. It reads `PORT` from the environment.

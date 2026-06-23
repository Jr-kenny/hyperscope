# HyperScope

Read-only Hyperliquid perception, monitoring and evaluation tools for trading agents. Give it a wallet and it tells you the open perp positions, the live exposure, the funding it's paying, and the full track record: Sharpe, drawdown, win rate, an equity curve. Give it a vault address and it tells you everything about that vault. Ask it for vaults and it hands back a sorted shortlist out of the ~9,400 live ones. Then it puts an AI read on top: a grounded risk assessment of a wallet's positions, a follow / watch / avoid verdict on a vault, and an edge assessment of a trader's track record.

Built for the Bitget AI Base Camp Hackathon S1, Trading Infra track. The idea is simple: an autonomous trading agent needs to perceive the market before it acts, and a lot of that perception is just "what is this wallet holding" and "is this vault worth following". The raw data is the easy half. The harder half is judgment, so HyperScope also asks a model to turn the numbers into something an agent can act on. The data tools need no keys at all; the AI layer uses NVIDIA's free NIM API.

There's also a browser UI at the root path (`/`) that drives all of this, so you can see it working without writing any client code.

## Why this exists

Every agent that touches Hyperliquid ends up writing the same boilerplate: POST to the info endpoint, dig through `assetPositions`, work out long vs short from the sign of `szi`, coerce all the stringified numbers, hunt down a vault listing that isn't even in the documented API. HyperScope does that once so your agent doesn't have to. Same response shape on every call, so you parse it the same way every time.

## The tools

Sixteen services, and every response comes back in the same envelope: `version`, the `service` that answered, the `request` it received, and the `data`. They fall into three jobs an agent does in order: perceive the live state, monitor and evaluate a track record, then ask the AI layer for a call, all parsed the same way every time.

### Perceive

**Open positions** — `POST /positions { wallet }`. The wallet's open perpetual positions, each with coin, side (long or short, derived from the sign of the size), size, entry, value, unrealized PnL, liquidation price, ROE, and leverage.

**Wallet trade history** — `POST /fills { wallet, limit? }`. Recent fills with coin, side, price, size, notional, closed PnL, fee and direction, plus aggregates: realized PnL, fees, volume, and win rate over the fills that closed for a gain or loss. `limit` 1–200, default 50.

**Coin market and funding** — `POST /coin { coin }`. Live context before sizing a perp: mark, oracle and mid price, funding hourly and annualized, open interest (coin units and USD), 24h volume and price change, premium, max leverage. Unknown symbol returns `error: unknown_coin`.

**Order book depth** — `POST /book { coin, depth? }`. Best bid and ask, mid, spread in absolute terms and basis points, notional resting on each side, and the top `depth` levels per side. `depth` 1–50, default 10.

**Vault review** — `POST /vault { vault }`. A single vault: leader, description, APR, followers, leader fraction and commission, distributable and withdrawable capacity, closed/open, deposits.

**Vault discovery** — `GET /vaults?sort=tvl&order=desc&limit=50`. A sortable shortlist across every live vault. Sort by `tvl`, `apr`, or `createTimeMillis`, order `asc`/`desc`, limit 1–500. `data.total` is the full count.

**Vault compare** — `POST /compare { vaults: [..] }`. Two or more vaults side by side, ranked by APR, with followers, leader commission, size and status. Needs at least two valid addresses.

### Monitor and evaluate

**Position exposure** — `POST /exposure { wallet }`. Live exposure from open positions: long/short notional, net bias, gross/net exposure, per-coin concentration, leverage distribution, and nearest-liquidation distance per position. The monitoring view.

**Strategy metrics** — `POST /metrics { wallet, limit? }`. Performance ratios over the wallet's trade history: Sharpe, Sortino, Calmar, profit factor, expectancy, win/loss, max drawdown, PnL concentration by coin, and monthly buckets. The QuantStats-style evaluation layer.

**Equity curve** — `POST /equity_curve { wallet, since?, includeFunding? }`. A realized equity curve reconstructed by replaying fills (closed PnL − fees), funding, and deposits/withdrawals into a dated point series. Honest about what it is: realized, not continuous mark-to-market.

**Mark-to-market equity** — `POST /equity_mtm { wallet, period? }`. The continuous account-value curve (margin balance + unrealized PnL) straight from Hyperliquid's native portfolio history, with drawdown. This is the real equity the reconstruction can only approximate, and it needs no persistence, the exchange already keeps it. `period` is `day|week|month|allTime` (and `perp*` variants).

**Drawdown** — `POST /drawdown { wallet, since?, includeFunding? }`. Underwater curve and stats (max DD, average DD, max duration, current DD) from the reconstructed curve.

**Tearsheet** — `POST /tearsheet { wallet, limit? }`. One call that bundles metrics, exposure, an equity curve and drawdown. It prefers the mark-to-market curve when Hyperliquid has account-value history and falls back to the reconstruction otherwise, telling you which it used via `equityCurve.source`.

### Analyze (AI)

**AI risk read** — `POST /analyze/positions { wallet }`. Grounded facts from the positions handed to a model: `riskLevel`, `netBias`, a `summary`, and `signals`.

**AI vault verdict** — `POST /analyze/vault { vault }`. A `verdict` (follow / watch / avoid), a `score` out of 100, `summary`, `pros` and `cons`. The model is told to be skeptical of unsustainable APRs.

**AI performance read** — `POST /analyze/performance { wallet }`. Feeds the full track record (metrics + exposure + equity curve) to a model for an edge assessment: `edgeStatus` (real / fading / absent), `primaryDriver`, `riskFlag`, `summary`, `signals`.

The three AI endpoints need `NVIDIA_API_KEY` set (see below). Without it they return `error: ai_not_configured` and `GET /ai/status` reports `{ enabled: false }`, so the UI degrades gracefully. Everything else is keyless.

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

The three `/analyze/*` endpoints need an NVIDIA NIM key. Get one free at [build.nvidia.com](https://build.nvidia.com), then:

```bash
export NVIDIA_API_KEY="nvapi-..."
# optional, defaults to meta/llama-3.3-70b-instruct
export NVIDIA_MODEL="meta/llama-3.3-70b-instruct"
```

All the data tools work with or without it; only the three `/analyze/*` endpoints need a key.

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

## Plug it into an agent (MCP)

The HTTP API is great if you're writing your own client, but a lot of agents speak [Model Context Protocol](https://modelcontextprotocol.io) now, so HyperScope ships an MCP server too. It exposes all sixteen tools (under `hyperliquid_*` names) over stdio, reusing the exact same data and AI functions, so any MCP-aware agent (Claude Desktop, Cursor, your own runtime) can plug it in and reason with Hyperliquid directly, no glue code.

Build once, then point your agent at it:

```bash
npm install && npm run build
```

```json
{
  "mcpServers": {
    "hyperscope": {
      "command": "node",
      "args": ["/absolute/path/to/hyperscope/dist/mcp.js"],
      "env": { "NVIDIA_API_KEY": "nvapi-..." }
    }
  }
}
```

The `NVIDIA_API_KEY` line is optional and only powers the three AI tools; everything else works without it. The tools an agent will see: `hyperliquid_positions`, `hyperliquid_wallet_fills`, `hyperliquid_coin_market`, `hyperliquid_order_book`, `hyperliquid_vault`, `hyperliquid_list_vaults`, `hyperliquid_compare_vaults`, `hyperliquid_exposure`, `hyperliquid_metrics`, `hyperliquid_equity_curve`, `hyperliquid_equity_mtm`, `hyperliquid_drawdown`, `hyperliquid_tearsheet`, `hyperliquid_analyze_positions`, `hyperliquid_analyze_vault`, `hyperliquid_analyze_performance`. Inputs are validated (addresses, coin symbols), and any upstream error comes back as a normal tool error rather than crashing the call.

## Sample output

The `samples/` folder holds real captured responses from a live run, one JSON per agent tool plus `stats.json` for the dashboard summary, so you can see the exact shapes without starting anything. Regenerate them any time with `npm run samples` (it captures the AI ones too when `NVIDIA_API_KEY` is set).

## How it's wired

Layers kept apart on purpose. `src/hyperliquid.ts` is the data layer: pure functions that hit Hyperliquid and normalize the result, no web framework in sight. `src/metrics.ts` and `src/equity.ts` are the evaluation layer on top of it, also framework-free: ratios, exposure, the realized reconstruction and the mark-to-market curve. `src/analyze.ts` is the AI layer. `src/envelope.ts` is the shared response shape. Because none of those carry a framework, two thin frontends sit on the same logic without a rewrite: `src/server.ts` is the Express HTTP API, and `src/mcp.ts` is the MCP server. Same functions, two ways in.

A note on the equity work: Hyperliquid actually exposes a continuous mark-to-market account-value history through its `portfolio` endpoint, so `/equity_mtm` reads that straight from source, keyless and stateless, rather than running a snapshot poller or a database. The realized reconstruction (`/equity_curve`) is kept alongside it because it answers a different question (what trading earned, vs what the account is worth).

Data sources, all public and unauthenticated, on `https://api.hyperliquid.xyz/info`:
- Positions and exposure: `clearinghouseState`
- Trade history and metrics: `userFills`
- Coin market and funding: `metaAndAssetCtxs`; order book: `l2Book`
- Equity reconstruction: `userNonFundingLedgerUpdates` and `userFunding`; mark-to-market: `portfolio`
- Vault review: `vaultDetails`; vault discovery: `https://stats-data.hyperliquid.xyz/Mainnet/vaults`

## Deploy

There's a `render.yaml` for one-click deploy on Render. Build with `npm install && npm run build`, start with `npm start`. It reads `PORT` from the environment.

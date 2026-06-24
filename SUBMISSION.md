# HyperScope — Bitget AI Hackathon S1 submission

**Track:** Trading Infra
**Repo:** https://github.com/Jr-kenny/hyperscope

---

## What problem this solves

Every agent that wants to trade or watch Hyperliquid starts in the same place: it has to perceive the market before it can act. And a big chunk of that perception is boring, repetitive plumbing. What is this wallet actually holding right now, long or short, at what entry, how close to liquidation. Is this vault worth following, what's its real APR and who runs it. Which vaults even exist worth looking at out of the thousands that are live.

Right now every builder writes that plumbing themselves. You POST to Hyperliquid's info endpoint, dig through `assetPositions`, work out direction from the sign of `szi`, coerce a pile of stringified numbers into real ones, and then go hunting for a vault listing that isn't even in the documented API. It's the same fifty lines in every project, and it's the kind of thing that quietly breaks an agent when one field comes back null.

## What it is

HyperScope is a service that turns those questions into clean JSON an agent can consume directly, with minimal setup. Sixteen endpoints across five groups:

- `POST /perceive/*` to get normalized open perp positions, wallet fills, coin markets, order books, and vault status.
- `POST /monitor/*` and `POST /evaluate/*` to track real-time exposure, calculate performance metrics, generate equity curves, and perform drawdown analysis.
- `POST /analyze/*` to run AI-driven evaluations on a wallet's positions, a vault's prospects, or a trader's overall performance.
- `GET /vaults` (in `/perceive`), get a sortable shortlist out of the ~9,400 live vaults, ranked by TVL, APR, or age.

Every call comes back in the same envelope, version, the service that answered, the request it got, and the data, so an agent parses the response the same way every single time. That consistency is the actual product. An agent doesn't want sixteen different shapes to handle, it wants one.

## How it works and how you can check it

Underneath it's all Hyperliquid's own public data, nothing private. Positions and vault review come from `api.hyperliquid.xyz/info`, and the vault discovery list comes from `stats-data.hyperliquid.xyz/Mainnet/vaults`, which is the listing that isn't in the docs but is exactly what you need.

The code is in three layers on purpose. The data layer is pure functions with no web framework anywhere near them, so the same logic can back an MCP server or a CLI later without a rewrite. On top of that sits a shared response envelope, and then a thin Express layer that validates input and wraps each call.

You don't have to take my word that it runs. The repo has a `samples/` folder with real captured responses from a live run: a vault holding 34 open positions with every field populated, the HLP vault review, and the top vaults by TVL. The README walks another developer from install to all sixteen endpoints in a few curl commands. It's deployable as-is, there's a `render.yaml` in the repo.

## Why it matters and where it goes

This is the unglamorous layer the agentic trading era actually runs on. An agent is only as good as what it can perceive, and perception starts with reliable, normalized market state. HyperScope makes that a one-line call instead of fifty lines of boilerplate that each builder reinvents and each one gets subtly wrong.

Because the core logic is already framework-free, HyperScope includes an MCP server exposing these exact same sixteen tools, so any agent in Claude, Cursor, or Codex can call them directly. The shape stays the same, the agent's parsing never changes, the toolbox just grows.

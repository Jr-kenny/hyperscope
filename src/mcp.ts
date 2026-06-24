#!/usr/bin/env node
// MCP server for HyperScope. Exposes the same read-only Hyperliquid perception
// tools (and the AI layer) over the Model Context Protocol, so any MCP-aware
// agent (Claude, Cursor, and friends) can plug HyperScope in and reason with it
// directly, no HTTP glue. Reuses the framework-free functions from hyperliquid.ts
// and analyze.ts unchanged.
//
// Run over stdio:  npm run mcp   (after npm run build), or:  tsx src/mcp.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

try {
  process.loadEnvFile();
} catch {
  /* no .env file, fine */
}

import {
  getPositions,
  getVault,
  listVaults,
  getCoinContext,
  getOrderBook,
  getWalletFills,
  getNonFundingLedgerUpdates,
  getFundingHistory,
  getAccountValueHistory,
  compareVaults,
  warmVaultCache,
  type VaultSortKey,
  type PortfolioPeriod,
} from "./hyperliquid.js";
import {
  analyzePositions,
  analyzeVault,
  analyzePerformance,
  aiEnabled,
  AINotConfigured,
} from "./analyze.js";
import { fillsMetrics, exposureMetrics } from "./metrics.js";
import { buildEquityCurve, buildMtmCurve, drawdownReport } from "./equity.js";

const server = new McpServer({ name: "hyperscope", version: "0.1.0" });

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 40-hex-char address");

// Wrap a tool body so any thrown error comes back as a clean MCP error result
// instead of crashing the call, and every success is JSON text an agent can parse.
function tool(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
  },
  run: (args: any) => Promise<unknown>
) {
  server.registerTool(name, config as any, async (args: any) => {
    try {
      const data = await run(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg =
        err instanceof AINotConfigured
          ? "AI is not configured on this server (set NVIDIA_API_KEY)."
          : String(err);
      return { isError: true, content: [{ type: "text", text: msg }] };
    }
  });
}

tool(
  "hyperliquid_positions",
  {
    title: "Wallet positions",
    description:
      "Open perpetual positions for a Hyperliquid wallet, normalized: side, size, entry, value, uPnL, ROE, liquidation price, leverage.",
    inputSchema: { wallet: addressSchema },
  },
  ({ wallet }) => getPositions(wallet.toLowerCase())
);

tool(
  "hyperliquid_coin_market",
  {
    title: "Coin market & funding",
    description:
      "Live market context for a perp: mark/oracle/mid price, funding (hourly and annualized), open interest, 24h volume and price change, max leverage. Use before sizing a position.",
    inputSchema: { coin: z.string().min(1).describe("Coin symbol, e.g. BTC, ETH, SOL") },
  },
  ({ coin }) => getCoinContext(coin)
);

tool(
  "hyperliquid_order_book",
  {
    title: "Order book depth",
    description:
      "Top-of-book and resting depth for a perp: best bid/ask, mid, spread in bps, and notional resting on each side. Use to check liquidity before sizing.",
    inputSchema: {
      coin: z.string().min(1).describe("Coin symbol, e.g. BTC"),
      depth: z.number().int().min(1).max(50).optional().describe("Levels per side, default 10"),
    },
  },
  ({ coin, depth }) => getOrderBook(coin, depth ?? 10)
);

tool(
  "hyperliquid_wallet_fills",
  {
    title: "Wallet trade history",
    description:
      "A wallet's recent fills with realized PnL, win rate, fees and volume. The track record behind a wallet, not just its current snapshot.",
    inputSchema: {
      wallet: addressSchema,
      limit: z.number().int().min(1).max(200).optional().describe("How many recent fills, default 50"),
    },
  },
  ({ wallet, limit }) => getWalletFills(wallet.toLowerCase(), limit ?? 50)
);

tool(
  "hyperliquid_vault",
  {
    title: "Vault review",
    description:
      "Full breakdown of a single Hyperliquid vault: leader, description, APR, followers, leader commission, deposit and withdraw capacity, open/closed.",
    inputSchema: { vault: addressSchema },
  },
  ({ vault }) => getVault(vault.toLowerCase())
);

tool(
  "hyperliquid_list_vaults",
  {
    title: "Discover vaults",
    description:
      "A sortable shortlist across every live vault, ranked by TVL, APR or age.",
    inputSchema: {
      sort: z.enum(["tvl", "apr", "createTimeMillis"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  ({ sort, order, limit }) =>
    listVaults({ sort: sort as VaultSortKey, order, limit: limit ?? 50 })
);

tool(
  "hyperliquid_compare_vaults",
  {
    title: "Compare vaults",
    description:
      "Put two or more vaults side by side, ranked by APR, with followers, leader fee and size. A quick strategy shortlist.",
    inputSchema: {
      vaults: z.array(addressSchema).min(2).describe("Two or more vault addresses"),
    },
  },
  ({ vaults }) => compareVaults(vaults.map((v: string) => v.toLowerCase()))
);

tool(
  "hyperliquid_analyze_positions",
  {
    title: "AI risk read",
    description:
      "Feed a wallet's open positions to a model and get a grounded risk read: risk level, net directional bias, summary and the signals behind it. Requires AI to be configured.",
    inputSchema: { wallet: addressSchema },
  },
  ({ wallet }) => analyzePositions(wallet.toLowerCase())
);

tool(
  "hyperliquid_analyze_vault",
  {
    title: "AI vault verdict",
    description:
      "Due diligence on a vault, then a follow / watch / avoid verdict with a score and the case for and against. Requires AI to be configured.",
    inputSchema: { vault: addressSchema },
  },
  ({ vault }) => analyzeVault(vault.toLowerCase())
);

// ---- monitoring + evaluation tools (Phase A/B/C) -------------------------

tool(
  "hyperliquid_metrics",
  {
    title: "Strategy metrics",
    description:
      "Performance ratios from a wallet's trade history: Sharpe, Sortino, Calmar, profit factor, expectancy, win/loss stats, max drawdown, PnL concentration by coin, monthly heatmap data, and a cumulative realized-PnL curve. The strategy evaluation layer.",
    inputSchema: {
      wallet: addressSchema,
      limit: z.number().int().min(1).max(200).optional().describe("How many recent fills to evaluate, default 200"),
    },
  },
  async ({ wallet, limit }) => {
    const { fills } = await getWalletFills(wallet.toLowerCase(), limit ?? 200);
    return fillsMetrics(fills);
  }
);

tool(
  "hyperliquid_exposure",
  {
    title: "Position exposure",
    description:
      "Live exposure breakdown from open positions: long/short notional, net bias, gross/net exposure, per-coin concentration with notional and uPnL, leverage distribution, nearest liquidation distance per position. The monitoring layer.",
    inputSchema: { wallet: addressSchema },
  },
  async ({ wallet }) => {
    const { positions } = await getPositions(wallet.toLowerCase());
    return exposureMetrics(positions);
  }
);

tool(
  "hyperliquid_equity_curve",
  {
    title: "Realized equity curve",
    description:
      "Reconstructed realized equity curve from fills (closed PnL minus fees), funding payments, and non-funding ledger updates (deposits/withdrawals). Not continuous mark-to-market — intra-event uPnL is not captured. Returns sampled points for plotting.",
    inputSchema: {
      wallet: addressSchema,
      since: z.number().int().positive().optional().describe("Start time ms epoch; events before this are dropped"),
      includeFunding: z.boolean().optional().describe("Include funding payments in curve, default true"),
    },
  },
  async ({ wallet, since, includeFunding }) => {
    const w = wallet.toLowerCase();
    const [{ fills }, ledger, funding] = await Promise.all([
      getWalletFills(w, 200),
      getNonFundingLedgerUpdates(w, since).catch(() => []),
      includeFunding !== false ? getFundingHistory(w, since).catch(() => []) : Promise.resolve([]),
    ]);
    return buildEquityCurve(fills, ledger, funding, { since, includeFunding });
  }
);

tool(
  "hyperliquid_drawdown",
  {
    title: "Drawdown analysis",
    description:
      "Underwater curve and drawdown stats (max DD, avg DD, max duration, current DD) derived from the reconstructed realized equity curve.",
    inputSchema: {
      wallet: addressSchema,
      since: z.number().int().positive().optional().describe("Start time ms epoch"),
      includeFunding: z.boolean().optional().describe("Include funding, default true"),
    },
  },
  async ({ wallet, since, includeFunding }) => {
    const w = wallet.toLowerCase();
    const [{ fills }, ledger, funding] = await Promise.all([
      getWalletFills(w, 200),
      getNonFundingLedgerUpdates(w, since).catch(() => []),
      includeFunding !== false ? getFundingHistory(w, since).catch(() => []) : Promise.resolve([]),
    ]);
    const curve = buildEquityCurve(fills, ledger, funding, { since, includeFunding });
    return drawdownReport(curve);
  }
);

tool(
  "hyperliquid_equity_mtm",
  {
    title: "Mark-to-market equity curve",
    description:
      "Continuous mark-to-market account value (margin balance + unrealized PnL) over time, from Hyperliquid's native portfolio history. Unlike the reconstructed realized curve, this captures intra-event moves. Includes drawdown stats. period: day|week|month|allTime (and perp* variants).",
    inputSchema: {
      wallet: addressSchema,
      period: z
        .enum(["day", "week", "month", "allTime", "perpDay", "perpWeek", "perpMonth", "perpAllTime"])
        .optional()
        .describe("Time window, default allTime"),
    },
  },
  async ({ wallet, period }) => {
    const history = await getAccountValueHistory(
      wallet.toLowerCase(),
      (period ?? "allTime") as PortfolioPeriod
    );
    return buildMtmCurve(history);
  }
);

tool(
  "hyperliquid_tearsheet",
  {
    title: "Full tearsheet",
    description:
      "One-call strategy evaluation rollup: fills metrics, live exposure, sampled equity curve, and drawdown report. The QuantStats equivalent — everything an agent needs to evaluate a wallet's track record in a single call.",
    inputSchema: {
      wallet: addressSchema,
      limit: z.number().int().min(1).max(200).optional().describe("Fills to evaluate, default 200"),
      includeFunding: z.boolean().optional().describe("Include funding in equity curve, default true"),
    },
  },
  async ({ wallet, limit, includeFunding }) => {
    const w = wallet.toLowerCase();
    const [{ positions }, fillsResult, ledger, funding, mtmHistory] = await Promise.all([
      getPositions(w),
      getWalletFills(w, limit ?? 200),
      getNonFundingLedgerUpdates(w).catch(() => []),
      includeFunding !== false ? getFundingHistory(w).catch(() => []) : Promise.resolve([]),
      getAccountValueHistory(w).catch(() => null),
    ]);
    const reconstructed = buildEquityCurve(fillsResult.fills, ledger, funding, { includeFunding });
    const mtm = mtmHistory && mtmHistory.points.length > 1 ? buildMtmCurve(mtmHistory) : null;
    const equityCurve = mtm
      ? {
          source: "mark-to-market",
          method: mtm.method,
          spanDays: mtm.spanDays,
          finalEquity: mtm.finalEquity,
          peak: mtm.peak,
          trough: mtm.trough,
          points: mtm.points,
        }
      : {
          source: "realized-reconstruction",
          method: reconstructed.method,
          spanDays: reconstructed.spanDays,
          finalEquity: reconstructed.finalEquity,
          peak: reconstructed.peak,
          trough: reconstructed.trough,
          points: reconstructed.points,
        };
    return {
      wallet: w,
      metrics: fillsMetrics(fillsResult.fills),
      exposure: exposureMetrics(positions),
      equityCurve,
      drawdown: mtm
        ? { ...mtm.drawdown, method: mtm.method, spanDays: mtm.spanDays }
        : drawdownReport(reconstructed),
    };
  }
);

tool(
  "hyperliquid_analyze_performance",
  {
    title: "AI performance read",
    description:
      "Feed a wallet's full track record (fills metrics + exposure + equity curve) to a model and get a grounded edge assessment: whether the strategy's edge is real, fading, or absent, what's driving the PnL, and the main risk flag. Requires AI to be configured.",
    inputSchema: { wallet: addressSchema },
  },
  ({ wallet }) => analyzePerformance(wallet.toLowerCase())
);

async function main() {
  warmVaultCache(); // prime the vault list so discover/compare are fast
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; log to stderr so we don't corrupt the protocol.
  console.error(
    `hyperscope MCP server ready (AI ${aiEnabled() ? "enabled" : "disabled"})`
  );
}

main().catch((err) => {
  console.error("hyperscope MCP failed to start:", err);
  process.exit(1);
});

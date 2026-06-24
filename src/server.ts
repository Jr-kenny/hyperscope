import express from "express";
import path from "node:path";
import { ok, fail } from "./envelope.js";

// load .env if present (Node 20.6+). Render injects real env vars, so this is a no-op there.
try {
  process.loadEnvFile();
} catch {
  /* no .env file, fine */
}

import {
  getPositions,
  getVault,
  listVaults,
  vaultStats,
  warmVaultCache,
  getCoinContext,
  getOrderBook,
  getWalletFills,
  getNonFundingLedgerUpdates,
  getFundingHistory,
  getAccountValueHistory,
  compareVaults,
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

const PORTFOLIO_PERIODS: PortfolioPeriod[] = [
  "day", "week", "month", "allTime",
  "perpDay", "perpWeek", "perpMonth", "perpAllTime",
];
function readPeriod(req: { body?: any }): PortfolioPeriod {
  const p = req.body?.period;
  return PORTFOLIO_PERIODS.includes(p) ? p : "allTime";
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT ?? 3000);

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

// Shared wallet-field validation for every wallet-based endpoint. Returns the
// normalized address or a fail() payload that the caller can send and stop.
function readWallet(
  service: string,
  req: { body?: any }
): { ok: true; wallet: string } | { ok: false; status: number; payload: unknown } {
  const raw = req.body?.wallet;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, status: 400, payload: fail(service, "missing_wallet_field") };
  }
  const wallet = raw.trim().toLowerCase();
  if (!isAddress(wallet)) {
    return { ok: false, status: 400, payload: fail(service, "invalid_wallet_address", { wallet }) };
  }
  return { ok: true, wallet };
}

// Downsample an equity curve to at most `max` evenly-spaced points so the
// tearsheet payload stays small even when a wallet has thousands of fills.
// Always keeps the first and last point.
function sampleCurve<T extends { time: number }>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

// clean URL for the app workspace page
app.get("/app", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "app.html"));
});

app.get("/api", (_req, res) => {
  res.json(
    ok("hyperscope", null, {
      message: "Hyperliquid perception + monitoring + evaluation tools for agents",
      groups: {
        perceive: [
          "POST /positions      { wallet }",
          "POST /fills          { wallet, limit? }",
          "POST /coin           { coin }",
          "POST /book           { coin, depth? }",
          "POST /vault          { vault }",
          "GET  /vaults         ?sort=tvl|apr|createTimeMillis&order=desc|asc&limit=50",
          "GET  /stats",
          "POST /compare        { vaults: [..] }",
        ],
        monitor: [
          "POST /exposure       { wallet }",
          "POST /equity_curve   { wallet, since?, includeFunding? }",
          "POST /drawdown       { wallet, since?, includeFunding? }",
          "POST /equity_mtm     { wallet, period? }   (native mark-to-market account value)",
        ],
        evaluate: [
          "POST /metrics        { wallet, limit? }",
          "POST /tearsheet      { wallet, limit? }",
        ],
        analyze: [
          "GET  /ai/status",
          "POST /analyze/positions    { wallet }",
          "POST /analyze/vault        { vault }",
          "POST /analyze/performance  { wallet }",
        ],
        ops: ["GET /health"],
      },
    })
  );
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// 1. open perpetual positions for a wallet
app.post("/positions", async (req, res) => {
  const service = "positions";
  const raw = req.body?.wallet;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_wallet_field"));
  }
  const wallet = raw.trim().toLowerCase();
  if (!isAddress(wallet)) {
    return res
      .status(400)
      .json(fail(service, "invalid_wallet_address", { wallet }));
  }
  try {
    const data = await getPositions(wallet);
    return res.json(ok(service, { wallet }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet, detail: String(err) }));
  }
});

// 2. review a single vault by address
app.post("/vault", async (req, res) => {
  const service = "vault";
  const raw = req.body?.vault;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_vault_field"));
  }
  const vault = raw.trim().toLowerCase();
  if (!isAddress(vault)) {
    return res
      .status(400)
      .json(fail(service, "invalid_vault_address", { vault }));
  }
  try {
    const data = await getVault(vault);
    return res.json(ok(service, { vault }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { vault, detail: String(err) }));
  }
});

// 3. discover vaults (sortable shortlist)
app.get("/vaults", async (req, res) => {
  const service = "vaults";
  const allowedSort: VaultSortKey[] = ["tvl", "apr", "createTimeMillis"];
  const sortParam = String(req.query.sort ?? "tvl") as VaultSortKey;
  const sort = allowedSort.includes(sortParam) ? sortParam : "tvl";
  const order = req.query.order === "asc" ? "asc" : "desc";
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
  try {
    const data = await listVaults({ sort, order, limit });
    return res.json(ok(service, { sort, order, limit }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { detail: String(err) }));
  }
});

// aggregate vault stats for dashboard tiles
app.get("/stats", async (_req, res) => {
  const service = "stats";
  try {
    const data = await vaultStats();
    return res.json(ok(service, null, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { detail: String(err) }));
  }
});

// 4. coin market context + funding
app.post("/coin", async (req, res) => {
  const service = "coin";
  const raw = req.body?.coin;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_coin_field"));
  }
  const coin = raw.trim();
  try {
    const data = await getCoinContext(coin);
    return res.json(ok(service, { coin }, data));
  } catch (err) {
    if (String(err).includes("unknown_coin")) {
      return res.status(404).json(fail(service, "unknown_coin", { coin }));
    }
    return res
      .status(502)
      .json(fail(service, "upstream_error", { coin, detail: String(err) }));
  }
});

// 5. order book depth + spread
app.post("/book", async (req, res) => {
  const service = "book";
  const raw = req.body?.coin;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_coin_field"));
  }
  const coin = raw.trim();
  const depth = Math.min(Math.max(Number(req.body?.depth ?? 10) || 10, 1), 50);
  try {
    const data = await getOrderBook(coin, depth);
    return res.json(ok(service, { coin, depth }, data));
  } catch (err) {
    if (String(err).includes("unknown_coin")) {
      return res.status(404).json(fail(service, "unknown_coin", { coin }));
    }
    return res
      .status(502)
      .json(fail(service, "upstream_error", { coin, detail: String(err) }));
  }
});

// 6. wallet trade history (realized track record)
app.post("/fills", async (req, res) => {
  const service = "fills";
  const raw = req.body?.wallet;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_wallet_field"));
  }
  const wallet = raw.trim().toLowerCase();
  if (!isAddress(wallet)) {
    return res
      .status(400)
      .json(fail(service, "invalid_wallet_address", { wallet }));
  }
  const limit = Math.min(Math.max(Number(req.body?.limit ?? 50) || 50, 1), 200);
  try {
    const data = await getWalletFills(wallet, limit);
    return res.json(ok(service, { wallet, limit }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet, detail: String(err) }));
  }
});

// 7. compare vaults side by side (strategy evaluation)
app.post("/compare", async (req, res) => {
  const service = "compare";
  const raw = req.body?.vaults;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json(fail(service, "missing_vaults_field"));
  }
  const vaults = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase());
  const bad = vaults.filter((v) => !isAddress(v));
  if (bad.length) {
    return res
      .status(400)
      .json(fail(service, "invalid_vault_address", { invalid: bad }));
  }
  if (vaults.length < 2) {
    return res.status(400).json(fail(service, "need_two_or_more_vaults"));
  }
  try {
    const data = await compareVaults(vaults);
    return res.json(ok(service, { vaults }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { detail: String(err) }));
  }
});

// 8. performance metrics from a wallet's trade history (strategy evaluation)
app.post("/metrics", async (req, res) => {
  const service = "metrics";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  const limit = Math.min(Math.max(Number(req.body?.limit ?? 200) || 200, 1), 200);
  try {
    const { fills } = await getWalletFills(v.wallet, limit);
    const data = fillsMetrics(fills);
    return res.json(ok(service, { wallet: v.wallet, limit }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet: v.wallet, detail: String(err) }));
  }
});

// 9. live exposure breakdown from a wallet's open positions (monitoring)
app.post("/exposure", async (req, res) => {
  const service = "exposure";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  try {
    const { positions } = await getPositions(v.wallet);
    const data = exposureMetrics(positions);
    return res.json(ok(service, { wallet: v.wallet }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet: v.wallet, detail: String(err) }));
  }
});

// 10. reconstructed realized equity curve from fills + ledger + funding
app.post("/equity_curve", async (req, res) => {
  const service = "equity_curve";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  const since = Number(req.body?.since) > 0 ? Number(req.body.since) : undefined;
  const includeFunding = req.body?.includeFunding !== false; // default true
  try {
    const [{ fills }, ledger, funding] = await Promise.all([
      getWalletFills(v.wallet, 200),
      getNonFundingLedgerUpdates(v.wallet, since).catch(() => []),
      includeFunding ? getFundingHistory(v.wallet, since).catch(() => []) : Promise.resolve([]),
    ]);
    const data = buildEquityCurve(fills, ledger, funding, { since, includeFunding });
    return res.json(ok(service, { wallet: v.wallet, since: since ?? null, includeFunding }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet: v.wallet, detail: String(err) }));
  }
});

// 11. drawdown series + stats derived from the reconstructed equity curve
app.post("/drawdown", async (req, res) => {
  const service = "drawdown";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  const since = Number(req.body?.since) > 0 ? Number(req.body.since) : undefined;
  const includeFunding = req.body?.includeFunding !== false;
  try {
    const [{ fills }, ledger, funding] = await Promise.all([
      getWalletFills(v.wallet, 200),
      getNonFundingLedgerUpdates(v.wallet, since).catch(() => []),
      includeFunding ? getFundingHistory(v.wallet, since).catch(() => []) : Promise.resolve([]),
    ]);
    const curve = buildEquityCurve(fills, ledger, funding, { since, includeFunding });
    const data = drawdownReport(curve);
    return res.json(ok(service, { wallet: v.wallet, since: since ?? null }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet: v.wallet, detail: String(err) }));
  }
});

// 12. continuous mark-to-market equity from Hyperliquid's native account-value
// history. Keyless and read-only, no snapshot store needed.
app.post("/equity_mtm", async (req, res) => {
  const service = "equity_mtm";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  const period = readPeriod(req);
  try {
    const history = await getAccountValueHistory(v.wallet, period);
    const data = buildMtmCurve(history);
    return res.json(
      ok(service, { wallet: v.wallet, period, availablePeriods: history.availablePeriods }, data)
    );
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet: v.wallet, detail: String(err) }));
  }
});

// 13. one-call strategy evaluation rollup: metrics + exposure + drawdown + curve.
// Prefers the mark-to-market curve when Hyperliquid has account-value history,
// and falls back to the realized reconstruction otherwise.
app.post("/tearsheet", async (req, res) => {
  const service = "tearsheet";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  const limit = Math.min(Math.max(Number(req.body?.limit ?? 200) || 200, 1), 200);
  const includeFunding = req.body?.includeFunding !== false;
  try {
    const [{ positions }, fillsResult, ledger, funding, mtmHistory] = await Promise.all([
      getPositions(v.wallet),
      getWalletFills(v.wallet, limit),
      getNonFundingLedgerUpdates(v.wallet).catch(() => []),
      includeFunding ? getFundingHistory(v.wallet).catch(() => []) : Promise.resolve([]),
      getAccountValueHistory(v.wallet).catch(() => null),
    ]);
    const reconstructed = buildEquityCurve(fillsResult.fills, ledger, funding, { includeFunding });
    const mtm =
      mtmHistory && mtmHistory.points.length > 1 ? buildMtmCurve(mtmHistory) : null;

    // Prefer the continuous mark-to-market curve; fall back to reconstruction.
    const equityCurve = mtm
      ? {
          source: "mark-to-market" as const,
          method: mtm.method,
          spanDays: mtm.spanDays,
          finalEquity: mtm.finalEquity,
          peak: mtm.peak,
          trough: mtm.trough,
          points: sampleCurve(mtm.points, 120),
        }
      : {
          source: "realized-reconstruction" as const,
          method: reconstructed.method,
          spanDays: reconstructed.spanDays,
          finalEquity: reconstructed.finalEquity,
          peak: reconstructed.peak,
          trough: reconstructed.trough,
          points: sampleCurve(reconstructed.points, 120),
        };
    const drawdownData = mtm
      ? { ...mtm.drawdown, method: mtm.method, spanDays: mtm.spanDays }
      : drawdownReport(reconstructed);

    const data = {
      wallet: v.wallet,
      metrics: fillsMetrics(fillsResult.fills),
      exposure: exposureMetrics(positions),
      equityCurve,
      drawdown: drawdownData,
    };
    return res.json(ok(service, { wallet: v.wallet, limit }, data));
  } catch (err) {
    return res
      .status(502)
      .json(fail(service, "upstream_error", { wallet: v.wallet, detail: String(err) }));
  }
});

// AI performance read: edge status, primary driver, risk flag (strategy eval)
app.post("/analyze/performance", async (req, res) => {
  const service = "analyze-performance";
  const v = readWallet(service, req);
  if (!v.ok) return res.status(v.status).json(v.payload);
  try {
    const data = await analyzePerformance(v.wallet);
    return res.json(ok(service, { wallet: v.wallet }, data));
  } catch (err) {
    if (err instanceof AINotConfigured) {
      return res.status(503).json(fail(service, "ai_not_configured", { wallet: v.wallet }));
    }
    return res
      .status(502)
      .json(fail(service, "analysis_failed", { wallet: v.wallet, detail: String(err) }));
  }
});

// tells the UI whether the AI endpoints are usable on this deployment
app.get("/ai/status", (_req, res) => {
  res.json(ok("ai-status", null, { enabled: aiEnabled() }));
});

// AI risk read on a wallet's open positions
app.post("/analyze/positions", async (req, res) => {
  const service = "analyze-positions";
  const raw = req.body?.wallet;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_wallet_field"));
  }
  const wallet = raw.trim().toLowerCase();
  if (!isAddress(wallet)) {
    return res
      .status(400)
      .json(fail(service, "invalid_wallet_address", { wallet }));
  }
  try {
    const data = await analyzePositions(wallet);
    return res.json(ok(service, { wallet }, data));
  } catch (err) {
    if (err instanceof AINotConfigured) {
      return res.status(503).json(fail(service, "ai_not_configured", { wallet }));
    }
    return res
      .status(502)
      .json(fail(service, "analysis_failed", { wallet, detail: String(err) }));
  }
});

// AI follow/watch/avoid verdict on a vault
app.post("/analyze/vault", async (req, res) => {
  const service = "analyze-vault";
  const raw = req.body?.vault;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json(fail(service, "missing_vault_field"));
  }
  const vault = raw.trim().toLowerCase();
  if (!isAddress(vault)) {
    return res
      .status(400)
      .json(fail(service, "invalid_vault_address", { vault }));
  }
  try {
    const data = await analyzeVault(vault);
    return res.json(ok(service, { vault }, data));
  } catch (err) {
    if (err instanceof AINotConfigured) {
      return res.status(503).json(fail(service, "ai_not_configured", { vault }));
    }
    return res
      .status(502)
      .json(fail(service, "analysis_failed", { vault, detail: String(err) }));
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`hyperscope listening on :${PORT}`);
    warmVaultCache();
  });
} else {
  warmVaultCache();
}

export default app;

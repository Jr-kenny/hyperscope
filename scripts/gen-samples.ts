// Capture real responses from every HyperScope service into samples/, so the
// exact shapes are visible without starting the server. Calls the data layer
// directly (no HTTP) and wraps each result in the same envelope the API returns.
//
// Run with:  npm run samples
// AI samples are only captured when NVIDIA_API_KEY is set; otherwise skipped.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* no .env file, fine */
}

import { ok } from "../src/envelope.js";
import {
  getPositions,
  getWalletFills,
  getCoinContext,
  getOrderBook,
  getVault,
  listVaults,
  vaultStats,
  compareVaults,
  getNonFundingLedgerUpdates,
  getFundingHistory,
  getAccountValueHistory,
} from "../src/hyperliquid.js";
import { fillsMetrics, exposureMetrics } from "../src/metrics.js";
import { buildEquityCurve, buildMtmCurve, drawdownReport } from "../src/equity.js";
import {
  analyzePositions,
  analyzeVault,
  analyzePerformance,
  aiEnabled,
} from "../src/analyze.js";

// Representative live inputs.
const WALLET = "0xd6e56265890b76413d1d527eb9b75e334c0c5b42"; // an active trader
const VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"; // HLP
const VAULT2 = "0xb0a55f13d22f66e6d495ac98113841b2326e9540"; // HLP Liquidator
const COIN = "BTC";

const OUT = join(process.cwd(), "samples");
mkdirSync(OUT, { recursive: true });

function save(name: string, service: string, request: unknown, data: unknown) {
  writeFileSync(
    join(OUT, `${name}.json`),
    JSON.stringify(ok(service, request, data), null, 2) + "\n"
  );
  console.log(`  wrote samples/${name}.json`);
}

async function main() {
  console.log("Generating samples (live Hyperliquid data)…");

  // --- perceive -----------------------------------------------------------
  save("positions", "positions", { wallet: WALLET }, await getPositions(WALLET));

  const fills = await getWalletFills(WALLET, 50);
  save("fills", "fills", { wallet: WALLET, limit: 50 }, fills);

  save("coin", "coin", { coin: COIN }, await getCoinContext(COIN));
  save("book", "book", { coin: COIN, depth: 10 }, await getOrderBook(COIN, 10));
  save("vault", "vault", { vault: VAULT }, await getVault(VAULT));
  save("vaults", "vaults", { sort: "tvl", order: "desc", limit: 25 }, await listVaults({ sort: "tvl", order: "desc", limit: 25 }));
  save("stats", "stats", null, await vaultStats());
  save("compare", "compare", { vaults: [VAULT, VAULT2] }, await compareVaults([VAULT, VAULT2]));

  // --- monitor + evaluate -------------------------------------------------
  const full = await getWalletFills(WALLET, 200);
  const { positions } = await getPositions(WALLET);
  const ledger = await getNonFundingLedgerUpdates(WALLET).catch(() => []);
  const funding = await getFundingHistory(WALLET).catch(() => []);
  const reconstructed = buildEquityCurve(full.fills, ledger, funding);
  const history = await getAccountValueHistory(WALLET).catch(() => null);
  const mtm = history && history.points.length > 1 ? buildMtmCurve(history) : null;

  save("metrics", "metrics", { wallet: WALLET, limit: 200 }, fillsMetrics(full.fills));
  save("exposure", "exposure", { wallet: WALLET }, exposureMetrics(positions));
  save("equity_curve", "equity_curve", { wallet: WALLET }, reconstructed);
  save("drawdown", "drawdown", { wallet: WALLET }, drawdownReport(reconstructed));
  if (mtm) save("equity_mtm", "equity_mtm", { wallet: WALLET, period: "allTime" }, mtm);
  save("tearsheet", "tearsheet", { wallet: WALLET }, {
    wallet: WALLET,
    metrics: fillsMetrics(full.fills),
    exposure: exposureMetrics(positions),
    equityCurve: mtm
      ? { source: "mark-to-market", method: mtm.method, spanDays: mtm.spanDays, finalEquity: mtm.finalEquity, peak: mtm.peak, trough: mtm.trough, points: mtm.points }
      : { source: "realized-reconstruction", method: reconstructed.method, spanDays: reconstructed.spanDays, finalEquity: reconstructed.finalEquity, peak: reconstructed.peak, trough: reconstructed.trough, points: reconstructed.points },
    drawdown: mtm ? { ...mtm.drawdown, method: mtm.method, spanDays: mtm.spanDays } : drawdownReport(reconstructed),
  });

  // --- analyze (only when AI is configured) -------------------------------
  if (aiEnabled()) {
    console.log("AI configured — capturing analysis samples…");
    save("analyze-positions", "analyze-positions", { wallet: WALLET }, await analyzePositions(WALLET));
    save("analyze-vault", "analyze-vault", { vault: VAULT }, await analyzeVault(VAULT));
    save("analyze-performance", "analyze-performance", { wallet: WALLET }, await analyzePerformance(WALLET));
  } else {
    console.log("NVIDIA_API_KEY not set — skipping AI samples.");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("sample generation failed:", err);
  process.exit(1);
});

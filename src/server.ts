import express from "express";
import { ok, fail } from "./envelope.js";
import {
  getPositions,
  getVault,
  listVaults,
  vaultStats,
  warmVaultCache,
  type VaultSortKey,
} from "./hyperliquid.js";
import {
  analyzePositions,
  analyzeVault,
  aiEnabled,
  AINotConfigured,
} from "./analyze.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT ?? 3000);

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

app.get("/api", (_req, res) => {
  res.json(
    ok("hyperscope", null, {
      message: "Hyperliquid read-only data tools for agents",
      endpoints: [
        "POST /positions  { wallet }",
        "POST /vault      { vault }",
        "GET  /vaults     ?sort=tvl|apr|createTimeMillis&order=desc|asc&limit=50",
      ],
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

app.listen(PORT, () => {
  console.log(`hyperscope listening on :${PORT}`);
  warmVaultCache();
});

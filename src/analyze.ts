// AI analysis layer. Takes the raw Hyperliquid data and asks a model to turn it
// into judgment an agent can act on: a risk read on a wallet's positions, and a
// follow/watch/avoid verdict on a vault. Uses NVIDIA's OpenAI-compatible NIM API.
//
// Needs NVIDIA_API_KEY in the environment. Get a free key at build.nvidia.com.
// Model is configurable via NVIDIA_MODEL; defaults to a solid free instruct model.

import {
  getPositions,
  getVault,
  getWalletFills,
  getNonFundingLedgerUpdates,
  getFundingHistory,
  getAccountValueHistory,
  type Position,
} from "./hyperliquid.js";
import { positionsContext, fillsMetrics, exposureMetrics } from "./metrics.js";
import { buildEquityCurve, buildMtmCurve } from "./equity.js";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = process.env.NVIDIA_MODEL ?? "meta/llama-3.3-70b-instruct";

export class AINotConfigured extends Error {
  constructor() {
    super("ai_not_configured");
  }
}

export function aiEnabled(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY);
}

async function chat(system: string, user: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new AINotConfigured();

  const res = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: 700,
    }),
  });

  if (!res.ok) {
    throw new Error(`nvidia ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

// Pull the first {...} block out of a model reply and parse it, so a stray
// sentence before or after the JSON doesn't break us.
function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("model did not return JSON");
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

// ---- positions risk read --------------------------------------------------

export interface PositionsAnalysis {
  riskLevel: "low" | "moderate" | "high" | "extreme";
  netBias: "long" | "short" | "neutral";
  summary: string;
  signals: string[];
}

export async function analyzePositions(
  wallet: string
): Promise<{ wallet: string; positionsContext: unknown; analysis: PositionsAnalysis }> {
  const { positions } = await getPositions(wallet);
  const ctx = positionsContext(positions);

  const system =
    "You are a risk analyst for an autonomous crypto trading agent. You read a wallet's open perpetual positions and give a concise, grounded risk read. Be direct and specific. Respond with ONLY a JSON object, no prose around it.";

  const user = `Here is the wallet's position summary on Hyperliquid:
${JSON.stringify(ctx, null, 2)}

Individual positions:
${JSON.stringify(
  positions.map((p) => ({
    coin: p.coin,
    side: p.side,
    value: Math.round(p.positionValue),
    upnl: Math.round(p.unrealizedPnl),
    leverage: p.leverage.value,
  })),
  null,
  2
)}

Return JSON exactly in this shape:
{
  "riskLevel": "low | moderate | high | extreme",
  "netBias": "long | short | neutral",
  "summary": "2-3 sentences on the overall posture and the main risk",
  "signals": ["short bullet observations, e.g. concentration, leverage, liquidation proximity"]
}`;

  const analysis = parseJson<PositionsAnalysis>(await chat(system, user));
  return { wallet, positionsContext: ctx, analysis };
}

// ---- vault verdict --------------------------------------------------------

export interface VaultAnalysis {
  verdict: "follow" | "watch" | "avoid";
  score: number;
  summary: string;
  pros: string[];
  cons: string[];
}

export async function analyzeVault(
  vault: string
): Promise<{ vault: string; analysis: VaultAnalysis }> {
  const v = await getVault(vault);

  const system =
    "You are a due-diligence analyst for an autonomous crypto trading agent deciding whether to follow a Hyperliquid vault. Weigh APR, leader commission, follower count, deposit availability, and whether it is closed. Be skeptical of unsustainable APRs. Respond with ONLY a JSON object.";

  const user = `Vault data:
${JSON.stringify(
  {
    name: v.name,
    aprPct: Number((v.apr * 100).toFixed(2)),
    followerCount: v.followerCount,
    leaderCommissionPct: Number((v.leaderCommission * 100).toFixed(2)),
    allowDeposits: v.allowDeposits,
    isClosed: v.isClosed,
    maxDistributable: v.maxDistributable,
    description: v.description,
  },
  null,
  2
)}

Return JSON exactly in this shape:
{
  "verdict": "follow | watch | avoid",
  "score": 0-100 integer for how attractive this vault is to follow,
  "summary": "2-3 sentences with the bottom line",
  "pros": ["short points in favor"],
  "cons": ["short points against or risks"]
}`;

  const analysis = parseJson<VaultAnalysis>(await chat(system, user));
  return { vault, analysis };
}

// ---- performance read (strategy evaluation) -------------------------------

export interface PerformanceAnalysis {
  edgeStatus: "real" | "fading" | "absent";
  primaryDriver: string; // what's actually producing the PnL
  riskFlag: string; // the main way this strategy could blow up
  summary: string;
  signals: string[];
}

// The structural twin of analyzePositions/analyzeVault: gather grounded facts,
// hand them to the model, get a structured judgment back. Here the facts are the
// fills-based performance metrics + the live exposure + the realized curve.
export async function analyzePerformance(
  wallet: string
): Promise<{
  wallet: string;
  performanceContext: unknown;
  analysis: PerformanceAnalysis;
}> {
  // Pull all the raw streams in parallel, then compute deterministic metrics.
  const [{ positions }, fillsResult, ledger, funding, mtmHistory] = await Promise.all([
    getPositions(wallet),
    getWalletFills(wallet, 200),
    getNonFundingLedgerUpdates(wallet).catch(() => []),
    getFundingHistory(wallet).catch(() => []),
    getAccountValueHistory(wallet).catch(() => null),
  ]);

  const fmetrics = fillsMetrics(fillsResult.fills);
  const exposure = exposureMetrics(positions);
  // Prefer the continuous mark-to-market curve for the equity facts the model
  // sees; fall back to the realized reconstruction when no history is available.
  const mtm = mtmHistory && mtmHistory.points.length > 1 ? buildMtmCurve(mtmHistory) : null;
  const curve = mtm ?? buildEquityCurve(fillsResult.fills, ledger, funding);

  // Grounding facts: everything the model reasons about is precomputed so its
  // read is anchored in real numbers, not inferred from raw fills.
  const performanceContext = {
    sample: fmetrics.sample,
    pnl: fmetrics.pnl,
    ratios: fmetrics.ratios,
    winLoss: fmetrics.winLoss,
    concentration: fmetrics.concentration,
    maxDrawdown: fmetrics.maxDrawdown,
    exposure: {
      grossExposure: exposure.grossExposure,
      netExposure: exposure.netExposure,
      netBias: exposure.netBias,
      maxLeverage: exposure.maxLeverage,
      positionCount: exposure.positionCount,
    },
    curve: {
      source: curve.method, // "mark-to-market" or "realized-reconstruction"
      spanDays: curve.spanDays,
      finalEquity: Math.round(curve.finalEquity),
      peak: Math.round(curve.peak),
      trough: Math.round(curve.trough),
    },
  };

  const system =
    "You are a performance analyst for an autonomous crypto trading agent. You read a wallet's track record (realized PnL, win/loss, risk ratios, exposure, drawdown) and judge whether the edge is real, fading, or absent — and what's driving it. Be direct and skeptical. Respond with ONLY a JSON object, no prose around it.";

  const user = `Wallet performance on Hyperliquid:
${JSON.stringify(performanceContext, null, 2)}

Top coins by realized PnL:
${JSON.stringify(fmetrics.concentration.byCoin.slice(0, 5), null, 2)}

Return JSON exactly in this shape:
{
  "edgeStatus": "real | fading | absent",
  "primaryDriver": "one short phrase: the coin, side, or condition producing most of the PnL",
  "riskFlag": "one short phrase: the main way this strategy could blow up",
  "summary": "2-3 sentences on whether the edge is genuine and what's behind it",
  "signals": ["short bullet observations, e.g. profit factor, drawdown depth, concentration risk, sample size"]
}`;

  const analysis = parseJson<PerformanceAnalysis>(await chat(system, user));
  return { wallet, performanceContext, analysis };
}

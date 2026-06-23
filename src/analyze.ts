// AI analysis layer. Takes the raw Hyperliquid data and asks a model to turn it
// into judgment an agent can act on: a risk read on a wallet's positions, and a
// follow/watch/avoid verdict on a vault. Uses NVIDIA's OpenAI-compatible NIM API.
//
// Needs NVIDIA_API_KEY in the environment. Get a free key at build.nvidia.com.
// Model is configurable via NVIDIA_MODEL; defaults to a solid free instruct model.

import { getPositions, getVault, type Position } from "./hyperliquid.js";

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

// Deterministic facts we compute ourselves and hand to the model, so its read is
// grounded in real numbers rather than vibes.
function positionsContext(positions: Position[]) {
  let longNtl = 0;
  let shortNtl = 0;
  let totalUpnl = 0;
  let maxLev = 0;
  let nearestLiqPct: number | null = null;

  for (const p of positions) {
    if (p.side === "long") longNtl += p.positionValue;
    else shortNtl += p.positionValue;
    totalUpnl += p.unrealizedPnl;
    maxLev = Math.max(maxLev, p.leverage.value);
    if (p.liquidationPrice && p.entryPrice) {
      const dist = Math.abs(p.entryPrice - p.liquidationPrice) / p.entryPrice;
      nearestLiqPct =
        nearestLiqPct === null ? dist : Math.min(nearestLiqPct, dist);
    }
  }

  return {
    positionCount: positions.length,
    longNotional: Math.round(longNtl),
    shortNotional: Math.round(shortNtl),
    totalUnrealizedPnl: Math.round(totalUpnl),
    maxLeverage: maxLev,
    nearestLiquidationDistancePct:
      nearestLiqPct === null ? null : Number((nearestLiqPct * 100).toFixed(1)),
  };
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

// Strategy evaluation metrics. Pure functions, no framework, no AI.
// Sits on top of the data layer (Fill[], Position[]) the same way QuantStats's
// `stats` module sits on a returns series: deterministic numbers an agent (or
// the AI layer) can ground a judgment in.
//
// All math is plain JS floating point. Good enough for a perception tool; if
// precision ever matters at the cent level, swap the accumulators for a
// fixed-point library (decimal.js) — the function signatures won't change.

import type { Fill, Position } from "./hyperliquid.js";

// ---- primitive helpers ----------------------------------------------------

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (xs.length - 1));
}

// Downside deviation — only the negative excursions, squared. The Sortino
// denominator. Target defaults to 0 (any loss is downside).
export function downsideDev(xs: number[], target = 0): number {
  if (!xs.length) return 0;
  let acc = 0;
  let n = 0;
  for (const x of xs) {
    const d = x - target;
    if (d < 0) {
      acc += d * d;
      n++;
    }
  }
  // Sortino convention divides by the full sample count, not just the downside
  // observations — keep that so the number is comparable across literature.
  return Math.sqrt(acc / xs.length);
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

// Convert a per-period mean return into an annualized figure using the gap
// (in ms) between observations. Assumes roughly periodic samples.
export function annualize(periodicReturn: number, periodMs: number): number {
  if (periodMs <= 0) return 0;
  const periodsPerYear = SECONDS_PER_YEAR / (periodMs / 1000);
  return periodicReturn * periodsPerYear;
}

// Sharpe of a returns series. rf and the series are both per-period; we
// annualize the result using the mean observation gap.
export function sharpe(returns: number[], rf = 0, periodMs = SECONDS_PER_DAY * 1000): number {
  if (returns.length < 2) return 0;
  const sd = stdev(returns);
  if (sd === 0) return 0;
  const excess = mean(returns) - rf;
  return (excess / sd) * Math.sqrt(SECONDS_PER_YEAR / (periodMs / 1000));
}

// Sortino: same as Sharpe but penalizes only downside volatility.
export function sortino(returns: number[], rf = 0, periodMs = SECONDS_PER_DAY * 1000): number {
  if (returns.length < 2) return 0;
  const dd = downsideDev(returns, rf);
  if (dd === 0) return 0;
  const excess = mean(returns) - rf;
  return (excess / dd) * Math.sqrt(SECONDS_PER_YEAR / (periodMs / 1000));
}

// Calmar = CAGR / |max drawdown|. A return-per-unit-of-worst-pain ratio.
export function calmar(cagr: number, maxDd: number): number {
  if (!maxDd) return 0;
  return cagr / Math.abs(maxDd);
}

// Profit factor = sum(wins) / |sum(losses)|. >1 means net profitable.
// Returns null when there are no losing trades: the ratio is mathematically
// undefined (an unbounded "infinite" profit factor), and Infinity would just
// serialize to null in JSON anyway. Callers disambiguate with winLoss.losses:
// losses === 0 with wins > 0 means a clean run, not missing data.
export function profitFactor(pnl: number[]): number | null {
  let wins = 0;
  let losses = 0;
  for (const p of pnl) {
    if (p > 0) wins += p;
    else if (p < 0) losses += p;
  }
  if (!losses) return null;
  return wins / Math.abs(losses);
}

export interface DrawdownResult {
  maxDrawdown: number; // most negative peak-to-trough fraction (e.g. -0.32)
  avgDrawdown: number; // mean of all in-drawdown observations
  maxDurationMs: number; // longest time spent underwater
  currentDrawdown: number; // how far under water right now (0 if at a high)
  underwater: { time: number; drawdown: number }[]; // series for plotting
}

// Walk an equity curve (timestamps + values), track the running peak, and
// report drawdown stats + an underwater series for the plot.
export function drawdown(curve: { time: number; equity: number }[]): DrawdownResult {
  if (!curve.length) {
    return { maxDrawdown: 0, avgDrawdown: 0, maxDurationMs: 0, currentDrawdown: 0, underwater: [] };
  }
  let peak = curve[0].equity;
  let peakTime = curve[0].time;
  let maxDd = 0;
  let maxDur = 0;
  let ddSum = 0;
  let ddCount = 0;
  const underwater: { time: number; drawdown: number }[] = [];
  for (const pt of curve) {
    if (pt.equity > peak) {
      peak = pt.equity;
      peakTime = pt.time;
    }
    const dd = peak > 0 ? (pt.equity - peak) / peak : 0;
    underwater.push({ time: pt.time, drawdown: dd });
    if (dd < 0) {
      ddSum += dd;
      ddCount++;
      if (dd < maxDd) maxDd = dd;
      const dur = pt.time - peakTime;
      if (dur > maxDur) maxDur = dur;
    }
  }
  return {
    maxDrawdown: maxDd,
    avgDrawdown: ddCount ? ddSum / ddCount : 0,
    maxDurationMs: maxDur,
    currentDrawdown: underwater[underwater.length - 1].drawdown,
    underwater,
  };
}

// ---- fills-based metrics (the realized track record) ----------------------

export interface FillsMetrics {
  sample: {
    fills: number;
    closingFills: number; // fills that realized a non-zero pnl
    firstFillMs: number | null;
    lastFillMs: number | null;
    spanDays: number;
  };
  pnl: {
    realized: number; // sum of closedPnl
    fees: number;
    net: number; // realized - fees
    bestDay: number;
    worstDay: number;
  };
  ratios: {
    sharpe: number; // annualized, daily buckets
    sortino: number;
    calmar: number;
    profitFactor: number | null; // gross win / gross loss; null when no losing trades (undefined ratio)
    expectancy: number; // avg PnL per closing fill
  };
  winLoss: {
    wins: number;
    losses: number;
    winRate: number; // over closing fills
    avgWin: number;
    avgLoss: number;
  };
  concentration: {
    byCoin: { coin: string; realizedPnl: number; fills: number; share: number }[];
    topCoin: string | null;
  };
  monthly: { month: string; pnl: number }[]; // YYYY-MM buckets, for the heatmap
  dailyCurve: { time: number; equity: number }[]; // realized-PnL cumulative, for plotting
  maxDrawdown: number;
  note?: string;
}

const DAY_MS = SECONDS_PER_DAY * 1000;

// Group fills into per-day realized-PnL buckets keyed by UTC midnight. Fees
// are subtracted per fill so the daily figure is the net contribution.
function dailyBuckets(fills: Fill[]): Map<string, { time: number; pnl: number }> {
  const m = new Map<string, { time: number; pnl: number }>();
  for (const f of fills) {
    const day = Math.floor(f.time / DAY_MS) * DAY_MS;
    const key = String(day);
    const cur = m.get(key) ?? { time: day, pnl: 0 };
    cur.pnl += f.closedPnl - f.fee;
    m.set(key, cur);
  }
  return m;
}

// Month key (YYYY-MM) from a millisecond timestamp.
function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function fillsMetrics(fills: Fill[]): FillsMetrics {
  const sorted = [...fills].sort((a, b) => a.time - b.time);

  if (!sorted.length) {
    return {
      sample: { fills: 0, closingFills: 0, firstFillMs: null, lastFillMs: null, spanDays: 0 },
      pnl: { realized: 0, fees: 0, net: 0, bestDay: 0, worstDay: 0 },
      ratios: { sharpe: 0, sortino: 0, calmar: 0, profitFactor: null, expectancy: 0 },
      winLoss: { wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0 },
      concentration: { byCoin: [], topCoin: null },
      monthly: [],
      dailyCurve: [],
      maxDrawdown: 0,
      note: "no fills to evaluate",
    };
  }

  const closing = sorted.filter((f) => f.closedPnl !== 0);
  const realized = sorted.reduce((s, f) => s + f.closedPnl, 0);
  const fees = sorted.reduce((s, f) => s + f.fee, 0);
  const wins = closing.filter((f) => f.closedPnl > 0);
  const losses = closing.filter((f) => f.closedPnl < 0);
  const grossWin = wins.reduce((s, f) => s + f.closedPnl, 0);
  const grossLoss = losses.reduce((s, f) => s + f.closedPnl, 0); // negative

  // Per-day PnL series → ratios + cumulative equity curve + drawdown.
  const buckets = dailyBuckets(sorted);
  const days = [...buckets.values()].sort((a, b) => a.time - b.time);
  const dayPnls = days.map((d) => d.pnl);
  const spanDays = days.length
    ? Math.max(1, Math.round((days[days.length - 1].time - days[0].time) / DAY_MS))
    : 0;

  // Cumulative net realized PnL as the equity proxy. This is a *realized* curve
  // (closed PnL minus fees), not a continuous mark-to-market — flagged in the
  // note so callers don't mistake it for account value.
  let cum = 0;
  const dailyCurve = days.map((d) => {
    cum += d.pnl;
    return { time: d.time, equity: cum };
  });

  const dd = drawdown(dailyCurve);
  const spanYears = spanDays / 365;
  const cagr =
    spanYears > 0 && cum !== 0 && dailyCurve[0] // needs a positive base to be meaningful
      ? Math.pow(1 + cum / Math.max(1, dailyCurve[0].equity - cum || 1), 1 / spanYears) - 1
      : 0;

  // Concentration per coin.
  const coinMap = new Map<string, { realizedPnl: number; fills: number }>();
  for (const f of sorted) {
    const cur = coinMap.get(f.coin) ?? { realizedPnl: 0, fills: 0 };
    cur.realizedPnl += f.closedPnl;
    cur.fills++;
    coinMap.set(f.coin, cur);
  }
  const byCoin = [...coinMap.entries()]
    .map(([coin, v]) => ({
      coin,
      realizedPnl: Math.round(v.realizedPnl),
      fills: v.fills,
      share: realized !== 0 ? v.realizedPnl / realized : 0,
    }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);

  // Monthly buckets for the heatmap.
  const monthMap = new Map<string, number>();
  for (const f of sorted) {
    const k = monthKey(f.time);
    monthMap.set(k, (monthMap.get(k) ?? 0) + (f.closedPnl - f.fee));
  }
  const monthly = [...monthMap.entries()]
    .map(([month, pnl]) => ({ month, pnl: Math.round(pnl) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    sample: {
      fills: sorted.length,
      closingFills: closing.length,
      firstFillMs: sorted[0].time,
      lastFillMs: sorted[sorted.length - 1].time,
      spanDays,
    },
    pnl: {
      realized: Math.round(realized),
      fees: Math.round(fees),
      net: Math.round(realized - fees),
      bestDay: dayPnls.length ? Math.max(...dayPnls) : 0,
      worstDay: dayPnls.length ? Math.min(...dayPnls) : 0,
    },
    ratios: {
      sharpe: sharpe(dayPnls, 0, DAY_MS),
      sortino: sortino(dayPnls, 0, DAY_MS),
      calmar: calmar(cagr, dd.maxDrawdown),
      profitFactor: profitFactor(closing.map((f) => f.closedPnl)),
      expectancy: closing.length ? realized / closing.length : 0,
    },
    winLoss: {
      wins: wins.length,
      losses: losses.length,
      winRate: closing.length ? wins.length / closing.length : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? grossLoss / losses.length : 0,
    },
    concentration: { byCoin, topCoin: byCoin[0]?.coin ?? null },
    monthly,
    dailyCurve,
    maxDrawdown: dd.maxDrawdown,
    note: "realized-PnL curve (closed PnL minus fees), not continuous mark-to-market",
  };
}

// ---- position-based exposure (the live snapshot) --------------------------

export interface PositionsContext {
  positionCount: number;
  longNotional: number;
  shortNotional: number;
  totalUnrealizedPnl: number;
  maxLeverage: number;
  nearestLiquidationDistancePct: number | null;
}

// The deterministic grounding facts used by the AI risk read. Exported so the
// exposure endpoint and any future tool share the exact same computation.
export function positionsContext(positions: Position[]): PositionsContext {
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
      nearestLiqPct = nearestLiqPct === null ? dist : Math.min(nearestLiqPct, dist);
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

export interface ExposureMetrics extends PositionsContext {
  grossExposure: number; // longNtl + shortNtl
  netExposure: number; // longNtl - shortNtl
  netBias: number; // net / gross, in [-1, 1]
  byCoin: {
    coin: string;
    side: "long" | "short";
    notional: number;
    unrealizedPnl: number;
    leverage: number;
    share: number; // share of gross
    liquidationDistancePct: number | null;
  }[];
  leverageBuckets: { leverage: number; count: number }[]; // count of positions at each leverage tier
}

// Full exposure breakdown from a live position snapshot. Generalizes
// positionsContext with the per-coin detail a dashboard wants.
export function exposureMetrics(positions: Position[]): ExposureMetrics {
  const base = positionsContext(positions);
  const gross = base.longNotional + base.shortNotional;

  const byCoin = positions
    .map((p) => {
      const liqDist =
        p.liquidationPrice && p.entryPrice
          ? Number((((p.entryPrice - p.liquidationPrice) / p.entryPrice) * 100).toFixed(1))
          : null;
      return {
        coin: p.coin,
        side: p.side,
        notional: Math.round(p.positionValue),
        unrealizedPnl: Math.round(p.unrealizedPnl),
        leverage: p.leverage.value,
        share: gross > 0 ? p.positionValue / gross : 0,
        // for shorts the liq is above entry, so flip the sign for "distance"
        liquidationDistancePct:
          liqDist === null ? null : p.side === "short" ? Math.abs(liqDist) : liqDist,
      };
    })
    .sort((a, b) => b.notional - a.notional);

  const levMap = new Map<number, number>();
  for (const p of positions) {
    levMap.set(p.leverage.value, (levMap.get(p.leverage.value) ?? 0) + 1);
  }
  const leverageBuckets = [...levMap.entries()]
    .map(([leverage, count]) => ({ leverage, count }))
    .sort((a, b) => a.leverage - b.leverage);

  return {
    ...base,
    grossExposure: gross,
    netExposure: base.longNotional - base.shortNotional,
    netBias: gross > 0 ? (base.longNotional - base.shortNotional) / gross : 0,
    byCoin,
    leverageBuckets,
  };
}

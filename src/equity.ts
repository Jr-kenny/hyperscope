// Equity curve reconstruction. Pure functions over the three Hyperliquid event
// streams (fills, non-funding ledger updates, funding). No persistence, no
// framework — stateless like the rest of the data layer.
//
// What you get back is a *realized* equity curve: cumulative (closed PnL − fees
// − funding + capital flows), sampled per event. This is not a continuous
// mark-to-market — for that see the Phase D persistence tier (store.ts). The
// distinction is documented in every response that uses it so callers don't
// mistake the two.

import type {
  Fill,
  LedgerUpdate,
  FundingUpdate,
} from "./hyperliquid.js";
import { drawdown, type DrawdownResult } from "./metrics.js";

export interface EquityPoint {
  time: number;
  equity: number; // cumulative realized equity at this event
  realizedPnl: number; // cumulative closed PnL
  cumulativeFees: number;
  cumulativeFunding: number;
  capitalFlows: number; // cumulative deposits − withdrawals
  kind: "fill" | "ledger" | "funding";
  detail: string; // human label, e.g. "BTC fill" or "deposit"
}

export interface EquityCurve {
  points: EquityPoint[];
  startMs: number | null;
  endMs: number | null;
  spanDays: number;
  peak: number;
  trough: number;
  finalEquity: number;
  method: "realized-reconstruction";
  note: string;
}

export interface EquityOptions {
  // Include funding payments in the curve. Default true — funding is a real
  // cash drag on perp strategies and hiding it flatters the curve.
  includeFunding?: boolean;
  since?: number; // ms epoch; events before this are dropped
}

// Merge the three streams into one ordered event list, then walk it building
// cumulative totals. The equity at each point is the sum of everything that has
// happened to the wallet up to that timestamp.
export function buildEquityCurve(
  fills: Fill[],
  ledger: LedgerUpdate[],
  funding: FundingUpdate[],
  opts: EquityOptions = {}
): EquityCurve {
  const includeFunding = opts.includeFunding ?? true;
  const since = opts.since ?? 0;

  type Ev = { time: number; kind: EquityPoint["kind"]; detail: string; pnl: number; fee: number; funding: number; capital: number };
  const events: Ev[] = [];

  for (const f of fills) {
    if (f.time < since) continue;
    events.push({ time: f.time, kind: "fill", detail: `${f.coin} ${f.side}`, pnl: f.closedPnl, fee: f.fee, funding: 0, capital: 0 });
  }
  for (const l of ledger) {
    if (l.time < since) continue;
    events.push({ time: l.time, kind: "ledger", detail: l.type, pnl: 0, fee: 0, funding: 0, capital: l.amount });
  }
  if (includeFunding) {
    for (const fu of funding) {
      if (fu.time < since) continue;
      events.push({ time: fu.time, kind: "funding", detail: `${fu.coin} funding`, pnl: 0, fee: 0, funding: fu.amount, capital: 0 });
    }
  }

  events.sort((a, b) => a.time - b.time);

  let cumPnl = 0;
  let cumFee = 0;
  let cumFund = 0;
  let cumCap = 0;
  let peak = -Infinity;
  let trough = Infinity;
  const points: EquityPoint[] = events.map((e) => {
    cumPnl += e.pnl;
    cumFee += e.fee;
    cumFund += e.funding;
    cumCap += e.capital;
    const equity = cumPnl - cumFee + cumFund + cumCap;
    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;
    return {
      time: e.time,
      equity,
      realizedPnl: cumPnl,
      cumulativeFees: cumFee,
      cumulativeFunding: cumFund,
      capitalFlows: cumCap,
      kind: e.kind,
      detail: e.detail,
    };
  });

  const startMs = points.length ? points[0].time : null;
  const endMs = points.length ? points[points.length - 1].time : null;
  const spanDays = startMs && endMs ? Math.max(1, Math.round((endMs - startMs) / 86_400_000)) : 0;

  return {
    points,
    startMs,
    endMs,
    spanDays,
    peak: points.length ? peak : 0,
    trough: points.length ? trough : 0,
    finalEquity: points.length ? points[points.length - 1].equity : 0,
    method: "realized-reconstruction",
    note:
      "Realized equity reconstructed from fills (closed PnL − fees), funding payments, and non-funding ledger updates (deposits/withdrawals). Not a continuous mark-to-market; intra-event unrealized PnL is not captured.",
  };
}

export interface DrawdownReport extends DrawdownResult {
  method: string;
  spanDays: number;
}

// Build the underwater curve from an equity curve. Thin wrapper so /drawdown
// has its own service entry point and the surface mirrors /equity_curve.
export function drawdownReport(curve: EquityCurve): DrawdownReport {
  const dd = drawdown(
    curve.points.map((p) => ({ time: p.time, equity: p.equity }))
  );
  return {
    ...dd,
    method: curve.method,
    spanDays: curve.spanDays,
  };
}

// ---- mark-to-market curve -------------------------------------------------
// Same plotting/drawdown surface as the reconstructed curve, but fed by
// Hyperliquid's native account-value history instead of replayed events. This
// is continuous equity (margin + uPnL), so it captures the intra-event moves
// the realized reconstruction can't.

export interface MtmCurve {
  points: { time: number; equity: number }[];
  startMs: number | null;
  endMs: number | null;
  spanDays: number;
  startEquity: number;
  finalEquity: number;
  peak: number;
  trough: number;
  change: number; // finalEquity − startEquity
  changePct: number; // change / startEquity
  method: "mark-to-market";
  period: string;
  note: string;
  drawdown: DrawdownResult;
}

export function buildMtmCurve(history: {
  points: { time: number; equity: number }[];
  period: string;
}): MtmCurve {
  const points = [...history.points].sort((a, b) => a.time - b.time);
  const startMs = points.length ? points[0].time : null;
  const endMs = points.length ? points[points.length - 1].time : null;
  const spanDays =
    startMs && endMs ? Math.max(1, Math.round((endMs - startMs) / 86_400_000)) : 0;
  const startEquity = points.length ? points[0].equity : 0;
  const finalEquity = points.length ? points[points.length - 1].equity : 0;
  const change = finalEquity - startEquity;
  // reduce instead of Math.max(...spread) so a long series can't blow the stack
  let peak = points.length ? points[0].equity : 0;
  let trough = peak;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    if (p.equity < trough) trough = p.equity;
  }
  return {
    points,
    startMs,
    endMs,
    spanDays,
    startEquity,
    finalEquity,
    peak,
    trough,
    change,
    changePct: startEquity ? change / startEquity : 0,
    method: "mark-to-market",
    period: history.period,
    note:
      "Mark-to-market account value (margin balance + unrealized PnL) sampled by Hyperliquid's portfolio endpoint. Continuous equity, unlike the realized-reconstruction curve.",
    drawdown: drawdown(points),
  };
}

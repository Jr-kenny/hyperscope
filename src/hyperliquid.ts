// Thin client over Hyperliquid's public read-only endpoints.
// No keys, no auth, no local state. Everything here is pure data fetching +
// normalization, kept framework-free so an MCP server or a CLI can reuse it.

const INFO_URL = "https://api.hyperliquid.xyz/info";
const STATS_URL = "https://stats-data.hyperliquid.xyz/Mainnet/vaults";

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`hyperliquid info ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// ---- open positions -------------------------------------------------------

export interface Position {
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
  returnOnEquity: number;
  leverage: { type: string; value: number };
}

interface RawClearinghouse {
  marginSummary: { accountValue: string; totalNtlPos: string };
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string | null;
      positionValue: string;
      unrealizedPnl: string;
      liquidationPx: string | null;
      returnOnEquity: string;
      leverage: { type: string; value: number };
    };
  }>;
  time: number;
}

export async function getPositions(wallet: string): Promise<{
  positions: Position[];
  count: number;
  time: number;
}> {
  const data = await postInfo<RawClearinghouse>({
    type: "clearinghouseState",
    user: wallet,
  });

  const positions: Position[] = (data.assetPositions ?? []).map((p) => {
    const size = Number(p.position.szi);
    return {
      coin: p.position.coin,
      side: size >= 0 ? "long" : "short",
      size: Math.abs(size),
      entryPrice: p.position.entryPx ? Number(p.position.entryPx) : 0,
      positionValue: Number(p.position.positionValue),
      unrealizedPnl: Number(p.position.unrealizedPnl),
      liquidationPrice: p.position.liquidationPx
        ? Number(p.position.liquidationPx)
        : null,
      returnOnEquity: Number(p.position.returnOnEquity),
      leverage: {
        type: p.position.leverage.type,
        value: p.position.leverage.value,
      },
    };
  });

  return { positions, count: positions.length, time: data.time };
}

// ---- single vault review --------------------------------------------------

export interface VaultReview {
  vaultAddress: string;
  name: string;
  leader: string;
  description: string;
  apr: number;
  followerCount: number;
  leaderFraction: number;
  leaderCommission: number;
  maxDistributable: number;
  maxWithdrawable: number;
  isClosed: boolean;
  allowDeposits: boolean;
  alwaysCloseOnWithdraw: boolean;
  relationship: unknown;
}

interface RawVaultDetails {
  name: string;
  vaultAddress: string;
  leader: string;
  description: string;
  apr: number;
  followers: unknown[] | null;
  leaderFraction: number;
  leaderCommission: number;
  maxDistributable: number;
  maxWithdrawable: number;
  isClosed: boolean;
  allowDeposits: boolean;
  alwaysCloseOnWithdraw: boolean;
  relationship: unknown;
}

export async function getVault(vaultAddress: string): Promise<VaultReview> {
  const d = await postInfo<RawVaultDetails>({
    type: "vaultDetails",
    vaultAddress,
  });

  return {
    vaultAddress: d.vaultAddress,
    name: d.name,
    leader: d.leader,
    description: d.description,
    apr: d.apr,
    followerCount: Array.isArray(d.followers) ? d.followers.length : 0,
    leaderFraction: d.leaderFraction,
    leaderCommission: d.leaderCommission,
    maxDistributable: Number(d.maxDistributable),
    maxWithdrawable: Number(d.maxWithdrawable),
    isClosed: d.isClosed,
    allowDeposits: d.allowDeposits,
    alwaysCloseOnWithdraw: d.alwaysCloseOnWithdraw,
    relationship: d.relationship,
  };
}

// ---- vault discovery ------------------------------------------------------

export interface VaultListItem {
  vaultAddress: string;
  name: string;
  leader: string;
  tvl: number;
  apr: number;
  status: "open" | "closed";
  relationship: unknown;
  createTimeMillis: number;
}

interface RawVaultSummary {
  apr: number;
  summary: {
    name: string;
    vaultAddress: string;
    leader: string;
    tvl: string;
    isClosed: boolean;
    relationship: unknown;
    createTimeMillis: number;
  };
}

export type VaultSortKey = "tvl" | "apr" | "createTimeMillis";

// The vault listing is a single ~2.5MB payload covering every vault, and the
// host can be slow. Cache the normalized list briefly so repeat calls (and the
// UI's sort toggles) are instant instead of refetching megabytes each time.
const VAULTS_TTL_MS = 60_000;
let vaultsCache: { at: number; data: VaultListItem[] } | null = null;
let vaultsInflight: Promise<VaultListItem[]> | null = null;

async function refetchVaultList(): Promise<VaultListItem[]> {
  const res = await fetch(STATS_URL);
  if (!res.ok) {
    throw new Error(`hyperliquid vaults ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as RawVaultSummary[];
  const data: VaultListItem[] = raw.map((v) => ({
    vaultAddress: v.summary.vaultAddress,
    name: v.summary.name,
    leader: v.summary.leader,
    tvl: Number(v.summary.tvl),
    apr: v.apr,
    status: v.summary.isClosed ? "closed" : "open",
    relationship: v.summary.relationship,
    createTimeMillis: v.summary.createTimeMillis,
  }));
  vaultsCache = { at: Date.now(), data };
  return data;
}

// Dedupe concurrent refreshes so a burst of requests triggers one upstream fetch.
function refreshVaultList(): Promise<VaultListItem[]> {
  if (!vaultsInflight) {
    vaultsInflight = refetchVaultList().finally(() => {
      vaultsInflight = null;
    });
  }
  return vaultsInflight;
}

async function fetchVaultList(): Promise<VaultListItem[]> {
  // Fresh cache: serve it.
  if (vaultsCache && Date.now() - vaultsCache.at < VAULTS_TTL_MS) {
    return vaultsCache.data;
  }
  // Stale cache: serve it now, refresh in the background (stale-while-revalidate).
  if (vaultsCache) {
    void refreshVaultList().catch(() => {});
    return vaultsCache.data;
  }
  // Cold start, nothing cached yet: we have to wait for the first fetch.
  return refreshVaultList();
}

// Kick off the first fetch at boot so the endpoint is warm before anyone calls it.
export function warmVaultCache(): void {
  void refreshVaultList().catch(() => {});
}

export async function listVaults(opts: {
  sort?: VaultSortKey;
  order?: "asc" | "desc";
  limit?: number;
}): Promise<{ vaults: VaultListItem[]; count: number; total: number }> {
  const all = await fetchVaultList();
  // copy before sorting so we never mutate the cached array's order
  let vaults: VaultListItem[] = [...all];

  const total = vaults.length;
  const sort = opts.sort ?? "tvl";
  const order = opts.order ?? "desc";
  vaults.sort((a, b) =>
    order === "desc" ? b[sort] - a[sort] : a[sort] - b[sort]
  );

  const limit = opts.limit ?? 50;
  vaults = vaults.slice(0, limit);

  return { vaults, count: vaults.length, total };
}

export async function vaultStats(): Promise<{
  totalVaults: number;
  openVaults: number;
  totalTvl: number;
}> {
  const all = await fetchVaultList();
  return {
    totalVaults: all.length,
    openVaults: all.filter((v) => v.status === "open").length,
    totalTvl: all.reduce((s, v) => s + v.tvl, 0),
  };
}

// ---- coin market + funding ------------------------------------------------

export interface CoinContext {
  coin: string;
  markPrice: number;
  oraclePrice: number;
  midPrice: number;
  // funding is charged hourly on Hyperliquid; we surface both the raw hourly
  // rate and the annualized figure an agent actually reasons about for carry.
  fundingHourly: number;
  fundingAnnualized: number;
  openInterest: number; // in coin units
  openInterestNotional: number; // in USD at mark
  dayNotionalVolume: number;
  dayChange: number; // fractional 24h price change vs prev day
  premium: number;
  maxLeverage: number;
}

interface RawAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
}
interface RawUniverseItem {
  name: string;
  maxLeverage: number;
  isDelisted?: boolean;
}

export async function getCoinContext(coin: string): Promise<CoinContext> {
  const [meta, ctxs] = await postInfo<[{ universe: RawUniverseItem[] }, RawAssetCtx[]]>(
    { type: "metaAndAssetCtxs" }
  );
  const want = coin.trim().toLowerCase();
  const idx = meta.universe.findIndex((u) => u.name.toLowerCase() === want);
  if (idx === -1) {
    throw new Error(`unknown_coin:${coin}`);
  }
  const u = meta.universe[idx];
  const c = ctxs[idx];
  const mark = Number(c.markPx);
  const oi = Number(c.openInterest);
  const fundingHourly = Number(c.funding);
  const prevDay = Number(c.prevDayPx);
  return {
    coin: u.name,
    markPrice: mark,
    oraclePrice: Number(c.oraclePx),
    midPrice: Number(c.midPx),
    fundingHourly,
    fundingAnnualized: fundingHourly * 24 * 365,
    openInterest: oi,
    openInterestNotional: oi * mark,
    dayNotionalVolume: Number(c.dayNtlVlm),
    dayChange: prevDay ? (mark - prevDay) / prevDay : 0,
    premium: Number(c.premium),
    maxLeverage: u.maxLeverage,
  };
}

// ---- order book depth -----------------------------------------------------

export interface BookLevel {
  price: number;
  size: number;
  orders: number;
}
export interface OrderBook {
  coin: string;
  time: number;
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  spreadBps: number;
  bidDepthNotional: number; // USD resting on the bid side across returned levels
  askDepthNotional: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

interface RawLevel {
  px: string;
  sz: string;
  n: number;
}

export async function getOrderBook(coin: string, depth = 10): Promise<OrderBook> {
  const raw = await postInfo<{ coin: string; time: number; levels: [RawLevel[], RawLevel[]] }>(
    { type: "l2Book", coin: coin.trim() }
  );
  const lvls = (side: RawLevel[]): BookLevel[] =>
    side.slice(0, depth).map((l) => ({
      price: Number(l.px),
      size: Number(l.sz),
      orders: l.n,
    }));
  const bidsRaw = raw.levels?.[0] ?? [];
  const asksRaw = raw.levels?.[1] ?? [];
  if (!bidsRaw.length || !asksRaw.length) {
    throw new Error(`unknown_coin:${coin}`);
  }
  const bids = lvls(bidsRaw);
  const asks = lvls(asksRaw);
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const notional = (ls: BookLevel[]) =>
    ls.reduce((s, l) => s + l.price * l.size, 0);
  return {
    coin: raw.coin,
    time: raw.time,
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps: mid ? (spread / mid) * 10_000 : 0,
    bidDepthNotional: notional(bids),
    askDepthNotional: notional(asks),
    bids,
    asks,
  };
}

// ---- wallet trade history (realized track record) -------------------------

export interface Fill {
  coin: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional: number;
  closedPnl: number;
  fee: number;
  dir: string;
  time: number;
}
export interface FillsResult {
  wallet: string;
  count: number;
  realizedPnl: number;
  totalFees: number;
  totalVolume: number;
  wins: number;
  losses: number;
  winRate: number; // over closing fills that realized a pnl
  fills: Fill[];
}

interface RawFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  dir: string;
  closedPnl: string;
  fee: string;
}

export async function getWalletFills(
  wallet: string,
  limit = 50
): Promise<FillsResult> {
  const raw = await postInfo<RawFill[]>({ type: "userFills", user: wallet });
  const recent = (raw ?? []).slice(0, limit);
  const fills: Fill[] = recent.map((f) => {
    const price = Number(f.px);
    const size = Number(f.sz);
    return {
      coin: f.coin,
      side: f.side === "B" ? "buy" : "sell",
      price,
      size,
      notional: price * size,
      closedPnl: Number(f.closedPnl),
      fee: Number(f.fee),
      dir: f.dir,
      time: f.time,
    };
  });
  let wins = 0;
  let losses = 0;
  let realizedPnl = 0;
  let totalFees = 0;
  let totalVolume = 0;
  for (const f of fills) {
    realizedPnl += f.closedPnl;
    totalFees += f.fee;
    totalVolume += f.notional;
    if (f.closedPnl > 0) wins++;
    else if (f.closedPnl < 0) losses++;
  }
  const decided = wins + losses;
  return {
    wallet,
    count: fills.length,
    realizedPnl,
    totalFees,
    totalVolume,
    wins,
    losses,
    winRate: decided ? wins / decided : 0,
    fills,
  };
}

// ---- equity reconstruction inputs -----------------------------------------
// Two ways to see a wallet's equity over time, both keyless. The realized
// reconstruction below replays three event streams (deposits/withdrawals,
// funding, fills) into a cumulative realized-PnL curve. The portfolio endpoint
// (getAccountValueHistory, further down) gives the continuous mark-to-market
// account value. Both point at Hyperliquid; we expose each since they answer
// different questions (what did trading earn vs what is the account worth).

export interface LedgerUpdate {
  time: number;
  type: string; // "deposit" | "withdraw" | "transfer" | …
  amount: number; // signed: + in, − out
  hash: string | null;
}

interface RawLedgerUpdate {
  time: number;
  type: string;
  usdc?: string;
  delta?: { type: string; usdc?: string };
  hash?: string;
}

// Non-funding ledger updates: deposits, withdrawals, transfers. Reconstructs
// capital flows so an equity curve reflects money in/out, not just trading PnL.
export async function getNonFundingLedgerUpdates(
  wallet: string,
  startTime?: number
): Promise<LedgerUpdate[]> {
  const body: Record<string, unknown> = { type: "userNonFundingLedgerUpdates", user: wallet };
  if (startTime !== undefined) body.startTime = startTime;
  const raw = await postInfo<RawLedgerUpdate[]>(body);
  return (raw ?? []).map((u) => {
    // amount appears as either top-level `usdc` or nested under `delta.usdc`
    const raw = u.usdc ?? u.delta?.usdc ?? "0";
    return {
      time: u.time,
      type: u.type,
      amount: Number(raw),
      hash: u.hash ?? null,
    };
  });
}

export interface FundingUpdate {
  time: number;
  coin: string;
  amount: number; // signed: + received, − paid
  fundingRate: number | null;
}

interface RawFundingUpdate {
  time: number;
  coin: string;
  fundingRate?: string;
  delta?: { type: string; usdc?: string };
  usdc?: string;
}

// Funding payments history per coin. Subtracting these gives a funding-adjusted
// realized curve, which matters for perp strategies held across funding times.
export async function getFundingHistory(
  wallet: string,
  startTime?: number
): Promise<FundingUpdate[]> {
  const body: Record<string, unknown> = { type: "userFunding", user: wallet };
  if (startTime !== undefined) body.startTime = startTime;
  const raw = await postInfo<RawFundingUpdate[]>(body);
  return (raw ?? []).map((f) => ({
    time: f.time,
    coin: f.coin,
    amount: Number(f.usdc ?? f.delta?.usdc ?? "0"),
    fundingRate: f.fundingRate !== undefined ? Number(f.fundingRate) : null,
  }));
}

// ---- mark-to-market account value history ---------------------------------
// Hyperliquid's `portfolio` endpoint hands back a real mark-to-market account
// value series (margin balance + unrealized PnL) over several windows, already
// timestamped and keyless. This is the continuous equity curve the realized
// reconstruction above can only approximate, so we read it straight from source
// rather than polling and storing our own snapshots.

export type PortfolioPeriod =
  | "day" | "week" | "month" | "allTime"
  | "perpDay" | "perpWeek" | "perpMonth" | "perpAllTime";

export interface AccountValuePoint {
  time: number;
  equity: number; // account value (margin balance + uPnL) at this timestamp
}

export interface AccountValueHistory {
  wallet: string;
  period: PortfolioPeriod;
  points: AccountValuePoint[];
  pnlPoints: { time: number; pnl: number }[];
  availablePeriods: string[];
}

// The endpoint returns [periodName, { accountValueHistory, pnlHistory, vlm }][].
type RawPortfolioEntry = [
  string,
  {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  }
];

export async function getAccountValueHistory(
  wallet: string,
  period: PortfolioPeriod = "allTime"
): Promise<AccountValueHistory> {
  const raw = await postInfo<RawPortfolioEntry[]>({ type: "portfolio", user: wallet });
  const byPeriod = new Map(raw);
  const chosen = byPeriod.get(period) ?? byPeriod.get("allTime") ?? raw[0]?.[1];
  const avh = chosen?.accountValueHistory ?? [];
  const ph = chosen?.pnlHistory ?? [];
  return {
    wallet,
    period,
    points: avh.map(([t, v]) => ({ time: t, equity: Number(v) })),
    pnlPoints: ph.map(([t, v]) => ({ time: t, pnl: Number(v) })),
    availablePeriods: raw.map((p) => p[0]),
  };
}

// ---- vault comparison (strategy evaluation) -------------------------------

export interface VaultCompareRow {
  vaultAddress: string;
  name: string;
  apr: number;
  followerCount: number;
  leaderCommission: number;
  tvl: number; // max distributable as a stand-in for vault size
  isClosed: boolean;
  allowDeposits: boolean;
}

export async function compareVaults(
  addresses: string[]
): Promise<{ count: number; vaults: VaultCompareRow[] }> {
  const rows = await Promise.all(
    addresses.map(async (a): Promise<VaultCompareRow> => {
      const v = await getVault(a);
      return {
        vaultAddress: v.vaultAddress,
        name: v.name,
        apr: v.apr,
        followerCount: v.followerCount,
        leaderCommission: v.leaderCommission,
        tvl: v.maxDistributable,
        isClosed: v.isClosed,
        allowDeposits: v.allowDeposits,
      };
    })
  );
  // best APR first, the most common way to rank candidates
  rows.sort((a, b) => b.apr - a.apr);
  return { count: rows.length, vaults: rows };
}

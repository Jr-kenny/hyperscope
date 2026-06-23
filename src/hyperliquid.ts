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

export async function listVaults(opts: {
  sort?: VaultSortKey;
  order?: "asc" | "desc";
  limit?: number;
}): Promise<{ vaults: VaultListItem[]; count: number; total: number }> {
  const res = await fetch(STATS_URL);
  if (!res.ok) {
    throw new Error(`hyperliquid vaults ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as RawVaultSummary[];

  let vaults: VaultListItem[] = raw.map((v) => ({
    vaultAddress: v.summary.vaultAddress,
    name: v.summary.name,
    leader: v.summary.leader,
    tvl: Number(v.summary.tvl),
    apr: v.apr,
    status: v.summary.isClosed ? "closed" : "open",
    relationship: v.summary.relationship,
    createTimeMillis: v.summary.createTimeMillis,
  }));

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

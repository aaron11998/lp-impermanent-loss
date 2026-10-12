/**
 * Free market data (no API key) — GeckoTerminal public API v2.
 * Bounty #7: LP Impermanent Loss Estimator.
 *
 * Used for:
 *  - live pool metrics (price, volume, reserve, fee tier) across 7 chains
 *  - OHLCV price history -> initial price at `windowHours` ago
 *  - realized volume over the requested window (real backtest data)
 *
 * Worker-safe: only fetch(). Handles 404/network errors with null so the
 * caller can fall back to on-chain RPC metrics.
 */

const GT_BASE = "https://api.geckoterminal.com/api/v2";

/** GeckoTerminal network slugs, keyed by canonical chain id. */
export const GT_NETWORKS = {
  ethereum: "eth",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  polygon: "polygon_pos",
  bsc: "bsc",
  avalanche: "avax",
} as const;

export interface GTToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface GTPoolMetrics {
  poolAddress: string;
  name: string;
  /** token0/token1 (sorted by address, Uniswap/V2 convention). */
  token0: GTToken;
  token1: GTToken;
  /** True when GT's base token is token0 (pair price orientation). */
  baseIsToken0: boolean;
  /** token0/token1 USD prices right now. */
  priceToken0Usd: number;
  priceToken1Usd: number;
  /** base-token price in quote-token units right now (the pair price). */
  currentPrice: number;
  feeBps: number;
  volume24hUsd: number;
  reserveUsd: number;
}

export interface PricePath {
  /** Pair price (base in quote units) at window start. */
  initialPrice: number;
  /** Pair price right now (same units). */
  currentPrice: number;
  /** Sum of candle volumes (USD) across the requested window. */
  volumeWindowUsd: number;
  /** Candle closes oldest→newest within the window (worst-case IL scans). */
  closes: number[];
  /** Candles actually used. */
  candlesUsed: number;
  timeframe: "hour" | "day";
  baseToken: GTToken;
  quoteToken: GTToken;
  /** True when GT's base token is token0 (canonical base/quote orientation). */
  baseIsToken0: boolean;
  /** True when the quote token is a USD stablecoin (enables USD approximations). */
  quoteIsStable: boolean;
  /** Initial (window-start) USD price per token — quote-start≈current-quote. */
  initialPriceToken0Usd?: number;
  initialPriceToken1Usd?: number;
}

const STABLES = new Set(["usdc", "usdt", "dai", "frax", "usde", "usds", "susd", "lp-yusd", "gusd", "pyusd"]);

function gtHeaders(): HeadersInit {
  return { Accept: "application/json;version=20230302" };
}

async function gtFetch(url: string, timeoutMs = 12000): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: gtHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function tokenFromIncluded(included: any[], key: string): GTToken {
  const tok = (included || []).find(
    (i) => i?.type === "token" && (i?.id || "").toLowerCase() === String(key || "").toLowerCase(),
  );
  if (tok) {
    const attrs = tok.attributes || {};
    return {
      address: String(tok.id || "").replace(/^eth_/, "0x"),
      symbol: attrs.symbol || "UNKNOWN",
      decimals: Number(attrs.decimals ?? 18),
    };
  }
  return { address: key || "", symbol: "UNKNOWN", decimals: 18 };
}

/** Fetch live pool metrics from GeckoTerminal. Returns null when not indexed. */
export async function fetchGTPoolMetrics(poolAddress: string, chain: string): Promise<GTPoolMetrics | null> {
  const slug = (GT_NETWORKS as Record<string, string>)[chain];
  if (!slug) return null;
  const url = `${GT_BASE}/networks/${slug}/pools/${poolAddress.toLowerCase()}?include=base_token%2Cquote_token`;
  const json = await gtFetch(url);
  if (!json?.data?.attributes) return null;

  const attrs = json.data.attributes;
  const included = json.included || [];
  const rels = json.data.relationships || {};

  const baseAddrRaw = rels?.base_token?.data?.id || "";
  const quoteAddrRaw = rels?.quote_token?.data?.id || "";
  const base = tokenFromIncluded(included, baseAddrRaw);
  const quote = tokenFromIncluded(included, quoteAddrRaw);
  if (!base.address || !quote.address) return null;

  // token0 = lexically lower address (V2/V3 convention); map prices accordingly.
  const baseFirst = base.address.toLowerCase() < quote.address.toLowerCase();
  const token0 = baseFirst ? base : quote;
  const token1 = baseFirst ? quote : base;
  const basePriceUsd = parseFloat(attrs.base_token_price_usd || "0");
  const quotePriceUsd = parseFloat(attrs.quote_token_price_usd || "0");
  const priceToken0Usd = baseFirst ? basePriceUsd : quotePriceUsd;
  const priceToken1Usd = baseFirst ? quotePriceUsd : basePriceUsd;

  const feePct = parseFloat(String(attrs.pool_fee_percentage || "0").replace("%", "").trim());
  const feeBps = isFinite(feePct) ? feePct * 100 : 0;

  return {
    poolAddress: (attrs.address || poolAddress).toLowerCase(),
    name: attrs.name || `${token0.symbol}/${token1.symbol}`,
    token0,
    token1,
    baseIsToken0: baseFirst,
    priceToken0Usd,
    priceToken1Usd,
    currentPrice: parseFloat(attrs.base_token_price_quote_token || "0"),
    feeBps,
    volume24hUsd: parseFloat(attrs.volume_usd?.h24 || "0"),
    reserveUsd: parseFloat(attrs.reserve_in_usd || "0"),
  };
}

/** USD-stablecoin detection by symbol (quote token of the pool). */
export function isStableSymbol(symbol: string): boolean {
  return STABLES.has((symbol || "").toLowerCase());
}

/**
 * OHLCV price path over the requested window.
 * hour candles cover ~6 months back; day candles cover the rest.
 */
export async function fetchPricePath(
  poolAddress: string,
  chain: string,
  windowHours: number,
  live: GTPoolMetrics,
): Promise<PricePath | null> {
  const slug = (GT_NETWORKS as Record<string, string>)[chain];
  if (!slug) return null;
  const tf: "hour" | "day" = windowHours <= 168 ? "hour" : "day";
  const limit = tf === "hour" ? Math.min(500, Math.max(2, windowHours + 1)) : Math.min(400, Math.max(2, Math.ceil(windowHours / 24) + 1));
  const url = `${GT_BASE}/networks/${slug}/pools/${poolAddress.toLowerCase()}/ohlcv/${tf}?limit=${limit}`;
  const json = await gtFetch(url);
  const list: any[] | undefined = json?.data?.attributes?.ohlcv_list;
  if (!list || list.length < 2) return null;

  // list is newest-first: [ts, open, high, low, close, volume]
  const windowStartTs = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const ordered = [...list].sort((a, b) => a[0] - b[0]);
  const startIdx = ordered.findIndex((c) => c[0] >= windowStartTs);
  const firstCandle = startIdx >= 0 ? ordered[startIdx] : ordered[0];
  const initialPrice = Number(firstCandle?.[1]);

  // Closes within the window, oldest→newest (worst-case IL scan).
  const closes: number[] = [];
  let volumeWindowUsd = 0;
  for (const c of ordered) {
    if (c[0] >= windowStartTs) {
      closes.push(Number(c[4]));
      volumeWindowUsd += Number(c[5]) || 0;
    }
  }
  if (volumeWindowUsd === 0) volumeWindowUsd = live.volume24hUsd || Number(ordered[ordered.length - 1]?.[5]) || 0;

  if (!isFinite(initialPrice) || initialPrice <= 0) return null;

  // GT's own base/quote tokens from the OHLCV meta (authoritative), fallback
  // to the live-pool tokens.
  const rels = json?.meta || {};
  const baseToken: GTToken = {
    address: rels.base?.address || live.token0.address,
    symbol: rels.base?.symbol || "UNKNOWN",
    decimals: 18,
  };
  const quoteToken: GTToken = {
    address: rels.quote?.address || live.token1.address,
    symbol: rels.quote?.symbol || "UNKNOWN",
    decimals: 18,
  };

  // Orientation: GT base vs canonical token0 (by address).
  const baseIsToken0 =
    (baseToken.address || "").toLowerCase() < (quoteToken.address || "").toLowerCase();

  // Initial per-token USD prices at window start. When the quote token is a
  // stablecoin, current quote-price ≈ initial quote-price (USD approximations
  // for stable quotes); base initial = initialPrice (base in quote units).
  const quoteUsdNow = baseIsToken0 ? live.priceToken1Usd : live.priceToken0Usd;
  const quoteUsdInitial =
    isStableSymbol(quoteToken.symbol) ? (quoteUsdNow || 1) : quoteUsdNow;
  const baseUsdInitial =
    isFinite(quoteUsdInitial) && quoteUsdInitial > 0 ? initialPrice * quoteUsdInitial : undefined;

  return {
    initialPrice,
    currentPrice: live.currentPrice,
    volumeWindowUsd,
    closes,
    candlesUsed: ordered.filter((c) => c[0] >= windowStartTs).length || ordered.length,
    timeframe: tf,
    baseToken,
    quoteToken,
    baseIsToken0,
    quoteIsStable: isStableSymbol(quoteToken.symbol),
    initialPriceToken0Usd: baseIsToken0 ? baseUsdInitial : quoteUsdInitial,
    initialPriceToken1Usd: baseIsToken0 ? quoteUsdInitial : baseUsdInitial,
  };
}
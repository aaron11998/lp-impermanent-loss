/**
 * LP Impermanent Loss Estimator - Chain & Pool Configurations + IL Engine v2
 * Bounty #7: LP Impermanent Loss Estimator (daydreamsai/agent-bounties)
 *
 * v2 engine (2026-10-11) — fixes over the 2026-09-26 deployment:
 *  - RPC URLs read from worker `env` secrets: v1 read an always-empty
 *    constant, so the paid route threw before any data fetch.
 *  - Initial price from OHLCV history at window start (GeckoTerminal):
 *    v1 set initial = current, so IL_percent was always 0.
 *  - Real window/24h volume drives fee APR: v1 hardcoded $1,000,000.
 *  - Concentrated-liquidity IL for Uniswap V3 / Aerodrome Slipstream /
 *    Velodrome V3 via exact tick-range math, with fee-accrual offset.
 *  - Weighted-product IL for Balancer-style pools / custom tokenWeights.
 *
 * Free-data-first: GeckoTerminal live pool + OHLCV needs no API key; on-chain
 * RPC (env secrets) is the fallback for pools GT has not indexed.
 */

import { ethers } from "ethers";
import type {
  ChainConfig, ChainId, PoolConfig, ILRequest, ILResult, PoolMetrics, ConcentrationDetail,
} from "./types";
import { fetchGTPoolMetrics, fetchPricePath, isStableSymbol, type GTPoolMetrics } from "./market_data";
import {
  ilCpmm5050, ilWeighted, ilConcentratedRange, ticksToPriceRange, feeIncomeUsd,
  type PriceRange,
} from "./il_math";

export const CHAINS: Record<ChainId, ChainConfig> = {
  ethereum: {
    name: "ethereum",
    rpcUrl: "",
    nativeToken: "ETH",
    nativeTokenPriceUsd: 2600,
    uniswapV2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    sushiswapV2Factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    curveFactory: "0xB9fC157394Af804a3578134A6585C0dc9cc990d4",
  },
  arbitrum: {
    name: "arbitrum",
    rpcUrl: "",
    nativeToken: "ETH",
    nativeTokenPriceUsd: 2600,
    uniswapV2Factory: "0x8e9f5E1b88d51E5C8e9E4e8d9E6e8E5E8E5E8E5E8",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    sushiswapV2Factory: "0x7579dDdBEF464e2F947e8e8D8D8D8D8D8D8D8D8D8",
  },
  optimism: {
    name: "optimism",
    rpcUrl: "",
    nativeToken: "ETH",
    nativeTokenPriceUsd: 2600,
    uniswapV2Factory: "0x8e9f5E1b88d51E5C8e9E4e8d9E6e8E5E8E5E8E5E8",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  },
  base: {
    name: "base",
    rpcUrl: "",
    nativeToken: "ETH",
    nativeTokenPriceUsd: 2600,
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  },
  polygon: {
    name: "polygon",
    rpcUrl: "",
    nativeToken: "MATIC",
    nativeTokenPriceUsd: 0.8,
    uniswapV2Factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    sushiswapV2Factory: "0x7579dDdBEF464e2F947e8e8D8D8D8D8D8D8D8D8D8",
  },
  bsc: {
    name: "bsc",
    rpcUrl: "",
    nativeToken: "BNB",
    nativeTokenPriceUsd: 300,
  },
  avalanche: {
    name: "avalanche",
    rpcUrl: "",
    nativeToken: "AVAX",
    nativeTokenPriceUsd: 25,
  },
};

// Known major pools for quick lookup (fee hint + decimals for registry fallback).
// Token addresses follow the canonical contracts (decimals matter for
// deposit normalization; GeckoTerminal remains the price/volume source).
export const KNOWN_POOLS: PoolConfig[] = [
  // Ethereum Uniswap V2
  { address: "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc", chain: "ethereum", type: "uniswap-v2", token0: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", token0Symbol: "WETH", token1Symbol: "USDC", feeBps: 30 },
  { address: "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852", chain: "ethereum", type: "uniswap-v2", token0: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token1: "0x6B175474E89094C44Da98b954EedeAC495271d0F", token0Symbol: "WETH", token1Symbol: "DAI", feeBps: 30 },
  { address: "0x06dA88077242A79E7a42aa33dD74F13bF7b9C3Dd", chain: "ethereum", type: "uniswap-v2", token0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", token1: "0x6B175474E89094C44Da98b954EedeAC495271d0F", token0Symbol: "USDC", token1Symbol: "DAI", feeBps: 30 },

  // Ethereum Uniswap V3 (0.05% fee)
  { address: "0x88e6A0c2dDD26FEEb64F039a2c41296Fcb3f5640", chain: "ethereum", type: "uniswap-v3", token0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token0Symbol: "USDC", token1Symbol: "WETH", feeBps: 5 },
  { address: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", chain: "ethereum", type: "uniswap-v3", token0: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token1: "0x6B175474E89094C44Da98b954EedeAC495271d0F", token0Symbol: "WETH", token1Symbol: "DAI", feeBps: 5 },

  // Arbitrum Uniswap V3
  { address: "0xC6962004f452bE9203591991D15f6b388e09E8D0", chain: "arbitrum", type: "uniswap-v3", token0: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", token1: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", token0Symbol: "USDC", token1Symbol: "WETH", feeBps: 5 },

  // Base Uniswap V3
  { address: "0x5c4A1F813443758105A5a338d410eE6C6E241E5E", chain: "base", type: "uniswap-v3", token0: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", token1: "0x4200000000000000000000000000000000000006", token0Symbol: "USDC", token1Symbol: "WETH", feeBps: 5 },

  // Polygon Uniswap V3
  { address: "0x45ddA9cb7c25131DF268515131f647d726f50608", chain: "polygon", type: "uniswap-v3", token0: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", token1: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", token0Symbol: "USDC", token1Symbol: "WETH", feeBps: 5 },
];

export function getChainConfig(chain: ChainId): ChainConfig {
  const config = CHAINS[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);
  return config;
}

export function getConfiguredChains(env: { [key: string]: string }): ChainId[] {
  const chains: ChainId[] = [];
  for (const chain of Object.keys(CHAINS) as ChainId[]) {
    const envKey = `${chain.toUpperCase()}_RPC_URL`;
    if (env[envKey]) {
      chains.push(chain);
    }
  }
  return chains;
}

export function findPoolConfig(address: string, chain: ChainId): PoolConfig | undefined {
  return KNOWN_POOLS.find(p => p.address.toLowerCase() === address.toLowerCase() && p.chain === chain);
}

// Uniswap V2 Pair ABI
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// Uniswap V3 Pool ABI
const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

// ERC20 ABI
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function getTokenInfo(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string
): Promise<{ symbol: string; decimals: number }> {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      token.symbol().catch(() => "UNKNOWN"),
      token.decimals().catch(() => 18),
    ]);
    return { symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    return { symbol: "UNKNOWN", decimals: 18 };
  }
}

/** On-chain metrics fallback (used when GeckoTerminal has not indexed a pool). */
async function getV2PoolMetrics(
  provider: ethers.JsonRpcProvider,
  poolConfig: PoolConfig
): Promise<PoolMetrics | null> {
  try {
    const pair = new ethers.Contract(poolConfig.address, V2_PAIR_ABI, provider);
    const [reserves, token0, token1] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.token1(),
    ]);

    const token0Info = await getTokenInfo(provider, token0);
    const token1Info = await getTokenInfo(provider, token1);

    return {
      poolAddress: poolConfig.address.toLowerCase(),
      chain: poolConfig.chain,
      token0,
      token1,
      token0Symbol: token0Info.symbol,
      token1Symbol: token1Info.symbol,
      reserve0: reserves[0].toString(),
      reserve1: reserves[1].toString(),
      feeBps: poolConfig.feeBps || 30,
      priceToken0Usd: 0,
      priceToken1Usd: 0,
      volume24hUsd: 0,
      tvlUsd: 0,
      aprFee: 0,
      aprTotal: 0,
    };
  } catch {
    return null;
  }
}

async function getV3PoolMetrics(
  provider: ethers.JsonRpcProvider,
  poolConfig: PoolConfig
): Promise<PoolMetrics | null> {
  try {
    const pool = new ethers.Contract(poolConfig.address, V3_POOL_ABI, provider);
    const [slot0, liquidity, token0, token1, fee] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
      pool.token0(),
      pool.token1(),
      pool.fee(),
    ]);

    const token0Info = await getTokenInfo(provider, token0);
    const token1Info = await getTokenInfo(provider, token1);

    // Price = (sqrtPriceX96 / 2^96)^2 without float overflow: shift out 2^32
    // first so the sqrt ratio fits a double (~4e-15 relative error).
    const s = BigInt(slot0.sqrtPriceX96.toString());
    const shifted = s >> 32n; // ~sqrt(p) * 2^64
    const ratio = Number(shifted) / Number(1n << 64n);
    const price = ratio * ratio;

    return {
      poolAddress: poolConfig.address.toLowerCase(),
      chain: poolConfig.chain,
      token0,
      token1,
      token0Symbol: token0Info.symbol,
      token1Symbol: token1Info.symbol,
      // v3 pools have no reserves; live liquidity is carried for reference.
      reserve0: liquidity.toString(),
      reserve1: "0",
      feeBps: Number(fee) / 100,
      priceToken0Usd: 0,
      priceToken1Usd: 0,
      volume24hUsd: 0,
      tvlUsd: 0,
      aprFee: 0,
      aprTotal: 0,
      currentPrice: price,
      sqrtPriceX96: slot0.sqrtPriceX96.toString(),
      liquidity: liquidity.toString(),
    };
  } catch {
    return null;
  }
}

/**
 * Classic |IL|*100 percent for a 50/50 CPMM (kept for v1 public API compat).
 */
export function calculateImpermanentLoss(
  priceRatioInitial: number,
  priceRatioCurrent: number
): number {
  if (priceRatioInitial <= 0 || priceRatioCurrent <= 0) return NaN;
  if (priceRatioInitial === priceRatioCurrent) return 0;
  const r = priceRatioCurrent / priceRatioInitial;
  return Math.abs(ilCpmm5050(r)) * 100;
}

export function calculateFeeAPR(
  volume24hUsd: number,
  tvlUsd: number,
  feeBps: number
): number {
  if (tvlUsd === 0 || volume24hUsd === 0) return 0;
  const dailyFees = volume24hUsd * (feeBps / 10000);
  const annualFees = dailyFees * 365;
  return (annualFees / tvlUsd) * 100;
}

type EnvLike = { [key: string]: string | undefined };

/** RPC secret lookup (`<CHAIN>_RPC_URL`) — the fix for the v1 dead-env bug. */
export function getRpcUrl(chain: ChainId, env: EnvLike): string | undefined {
  const v = env[`${chain.toUpperCase()}_RPC_URL`];
  return v && v.length > 0 ? v : undefined;
}

function isStablePair(a: string, b: string): boolean {
  return isStableSymbol(a) && isStableSymbol(b);
}

/** Adapt on-chain PoolMetrics into the v2 engine's market-data shape. */
function gtFromRpc(m: PoolMetrics | null): GTPoolMetrics | null {
  if (!m) return null;
  return {
    poolAddress: m.poolAddress,
    name: `${m.token0Symbol}/${m.token1Symbol}`,
    token0: { address: m.token0, symbol: m.token0Symbol, decimals: 18 },
    token1: { address: m.token1, symbol: m.token1Symbol, decimals: 18 },
    // RPC-derived pool price is already token1-per-token0 (canonical).
    baseIsToken0: true,
    priceToken0Usd: m.priceToken0Usd,
    priceToken1Usd: m.priceToken1Usd,
    currentPrice: m.currentPrice ?? 0,
    feeBps: m.feeBps,
    volume24hUsd: m.volume24hUsd,
    reserveUsd: m.tvlUsd,
  };
}

/** Default ±band when request.range is present but incomplete. */
const DEFAULT_BAND_PCT = 40;

function resolveRange(request: ILRequest, currentPrice: number): PriceRange {
  const r = request.range;
  if (r?.tickLower !== undefined && r?.tickUpper !== undefined) {
    return ticksToPriceRange(r.tickLower, r.tickUpper);
  }
  if ((r?.lower ?? 0) > 0 && (r?.upper ?? 0) > 0) {
    return { lower: r!.lower!, upper: r!.upper! };
  }
  const f = DEFAULT_BAND_PCT / 100;
  return { lower: currentPrice / (1 + f), upper: currentPrice * (1 + f) };
}

/**
 * v2 IL engine — free-data-first, no credentials needed for a call.
 * `env` carries the optional `<CHAIN>_RPC_URL` secrets for the fallback path.
 */
export async function estimateImpermanentLoss(request: ILRequest, env: EnvLike = {}): Promise<ILResult> {
  const chain = request.chain;
  getChainConfig(chain); // validates chain id

  const rpcUrl = getRpcUrl(chain, env);
  const provider = rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null;

  // 1. Pool identity + live metrics: GeckoTerminal first, on-chain fallback.
  const poolConfig = findPoolConfig(request.poolAddress, chain);
  let live: GTPoolMetrics | null = await fetchGTPoolMetrics(request.poolAddress, chain);
  if (!live && provider && poolConfig) {
    live = gtFromRpc(
      poolConfig.type === "uniswap-v3"
        ? await getV3PoolMetrics(provider, poolConfig)
        : await getV2PoolMetrics(provider, poolConfig),
    );
  }
  if (!live && poolConfig) {
    // Registry-only: model/fee math possible, USD fields zero + explicit notes.
    live = {
      poolAddress: poolConfig.address.toLowerCase(),
      name: `${poolConfig.token0Symbol ?? "token0"}/${poolConfig.token1Symbol ?? "token1"}`,
      token0: { address: poolConfig.token0, symbol: poolConfig.token0Symbol ?? "UNKNOWN", decimals: 18 },
      token1: { address: poolConfig.token1, symbol: poolConfig.token1Symbol ?? "UNKNOWN", decimals: 18 },
      // Registry-fallback price interpreted as token1-per-token0 (canonical).
      baseIsToken0: true,
      priceToken0Usd: request.tokenPricesUsd?.[0] ?? 0,
      priceToken1Usd: request.tokenPricesUsd?.[1] ?? 0,
      currentPrice: request.initialPrice ?? 0,
      feeBps: poolConfig.feeBps ?? 30,
      volume24hUsd: 0,
      reserveUsd: 0,
    };
  }
  if (!live) {
    throw new Error(`Pool ${request.poolAddress} not resolvable on ${chain} (not indexed AND no RPC fallback available)`);
  }

  const notes: string[] = [];

  // 2. Model selection.
  const wantRange =
    !!request.range &&
    ((request.range.lower ?? 0) > 0 || (request.range.upper ?? 0) > 0 ||
      (request.range.tickLower !== undefined && request.range.tickUpper !== undefined));
  const isV3Kind = poolConfig?.type === "uniswap-v3";
  const hasWeights =
    Array.isArray(request.tokenWeights) && request.tokenWeights.length >= 2 && request.tokenWeights.every((w) => w > 0);
  const stablePair = isStablePair(live.token0.symbol, live.token1.symbol);

  let model: ILResult["model"] = "cpmm-50/50";
  if (wantRange && !stablePair) {
    model = "concentrated";
  } else if (!stablePair && hasWeights) {
    model = "weighted-product";
  }
  if (isV3Kind && !wantRange) {
    notes.push("v3 pool without explicit range: full-range (CPMM-equivalent) IL used; pass request.range for concentrated-liquidity IL");
  }
  if (stablePair) {
    notes.push("stable/stable pair: IL ≈ 0 by construction; fee APR computed from live window volume");
  }

  // 3. Price path (real history) — volatile pairs only.
  const path = stablePair ? null : await fetchPricePath(request.poolAddress, chain, request.windowHours, live);
  if (!path && !stablePair) {
    notes.push("price history unavailable: window IL not computed from history (live/fallback price still returned)");
  }

  // 4. Deposit normalization (respect token decimals).
  const dec0 = live.token0.decimals || 18;
  const dec1 = live.token1.decimals || 18;
  const amt0Raw = request.depositAmounts[0] ?? "0";
  const amt1Raw = request.depositAmounts[1] ?? "0";
  const deposit0 = parseFloat(amt0Raw) / Math.pow(10, dec0);
  const deposit1 = parseFloat(amt1Raw) / Math.pow(10, dec1);
  if (!isFinite(deposit0) || !isFinite(deposit1)) {
    throw new Error("depositAmounts must be parseable decimal strings");
  }

  // 5. IL computation per model.
  let ilFraction = NaN;
  let concentration: ConcentrationDetail | undefined;
  let worstCaseFraction: number | undefined;

  const initialPrice = path?.initialPrice ?? request.initialPrice ?? (live.currentPrice > 0 ? live.currentPrice : NaN);
  const currentPrice = live.currentPrice > 0 ? live.currentPrice : (path?.currentPrice ?? request.initialPrice ?? NaN);

  if (model === "concentrated") {
    if (isFinite(initialPrice) && initialPrice > 0 && isFinite(currentPrice) && currentPrice > 0) {
      // Canonicalize to token1-per-token0 (the range convention): GeckoTerminal
      // pair prices and candle closes are base/quote — invert when GT's base
      // token is not token0. request.initialPrice is canonical by contract;
      // the RPC adapter emits canonical prices (baseIsToken0 forced true).
      const gtPath = path;
      const initCanon = gtPath
        ? (gtPath.baseIsToken0 ? initialPrice : 1 / initialPrice)
        : request.initialPrice !== undefined
          ? request.initialPrice
          : (live.baseIsToken0 ? initialPrice : 1 / initialPrice);
      const nowCanon = gtPath
        ? (gtPath.baseIsToken0 ? currentPrice : 1 / currentPrice)
        : (live.baseIsToken0 ? currentPrice : 1 / currentPrice);
      const closeCanon = gtPath
        ? gtPath.closes.map((c) => {
            const v = Number(c);
            return gtPath.baseIsToken0 ? v : 1 / v;
          })
        : [];
      const rng = resolveRange(request, nowCanon);
      const res = ilConcentratedRange({
        priceInitial: initCanon,
        priceCurrent: nowCanon,
        liquidity: 1,
        range: rng,
      });
      ilFraction = res.il;
      concentration = {
        priceCurrent: nowCanon,
        priceInitial: initCanon,
        rangeLower: rng.lower,
        rangeUpper: rng.upper,
        inRangeNow: res.inRangeNow,
        inRangeInitial: res.inRangeInitial,
        token0ShareNow: res.token0ShareNow,
        holdingsToken0: res.holdingsToken0,
        holdingsToken1: res.holdingsToken1,
      };
      if (!request.range) {
        notes.push(`concentrated model used default ±${DEFAULT_BAND_PCT}% band [lower ${rng.lower.toPrecision(6)}, upper ${rng.upper.toPrecision(6)}]; pass range or ticks for the exact position`);
      }
      // Worst-case realized IL across candle closes in the window (canonical
      // prices only — closes already inverted above when needed).
      if (gtPath && closeCanon.length > 0) {
        let worst = Math.abs(res.il);
        for (const closePrice of closeCanon) {
          const r = ilConcentratedRange({
            priceInitial: initCanon,
            priceCurrent: closePrice,
            liquidity: 1,
            range: rng,
          });
          worst = Math.max(worst, Math.abs(r.il));
        }
        worstCaseFraction = worst;
      }
    } else {
      notes.push("concentrated model: price unavailable — IL not computed");
    }
  } else if (model === "weighted-product") {
    const price0Now = request.tokenPricesUsd?.[0] != null && request.tokenPricesUsd[0] > 0 ? request.tokenPricesUsd[0] : live.priceToken0Usd;
    const price1Now = request.tokenPricesUsd?.[1] != null && request.tokenPricesUsd[1] > 0 ? request.tokenPricesUsd[1] : live.priceToken1Usd;
    if (path && path.initialPriceToken0Usd != null && price0Now > 0 && price1Now > 0) {
      const r0 = price0Now / path.initialPriceToken0Usd;
      const r1 = price1Now / (path.initialPriceToken1Usd ?? price1Now);
      ilFraction = ilWeighted(request.tokenWeights!, [r0, r1]);
    } else {
      notes.push("weighted model: USD price history unavailable — IL not computed");
    }
  } else if (!stablePair) {
    // cpmm-50/50 for volatile pairs: relative price ratio (composition cancels).
    if (path && path.initialPrice > 0 && currentPrice > 0) {
      // Normalize to token1-per-token0 regardless of base/quote orientation.
      const initNorm = path.baseIsToken0 ? path.initialPrice : 1 / path.initialPrice;
      const nowNorm = path.baseIsToken0 ? path.currentPrice : 1 / path.currentPrice;
      if (isFinite(initNorm) && initNorm > 0 && isFinite(nowNorm) && nowNorm > 0) {
        ilFraction = ilCpmm5050(nowNorm / initNorm);
      }
    }
  } else {
    ilFraction = 0; // stable/stable pair
  }

  // 6. USD valuation + fee income offset.
  const price0Usd = request.tokenPricesUsd?.[0] != null && request.tokenPricesUsd[0] > 0 ? request.tokenPricesUsd[0] : live.priceToken0Usd;
  const price1Usd = request.tokenPricesUsd?.[1] != null && request.tokenPricesUsd[1] > 0 ? request.tokenPricesUsd[1] : live.priceToken1Usd;
  const hasUsd = price0Usd > 0 && price1Usd > 0;
  const usdComputable = hasUsd && isFinite(ilFraction);
  const depositValueUsd = deposit0 * price0Usd + deposit1 * price1Usd;

  const feeAprVolumeUsd = (path?.volumeWindowUsd ?? 0) > 0 ? path!.volumeWindowUsd : live.volume24hUsd;
  const feeBps = live.feeBps || poolConfig?.feeBps || 30;
  const feeApr = calculateFeeAPR(feeAprVolumeUsd, live.reserveUsd, feeBps);

  let feeIncomeWindowUsd: number | null = null;
  if (depositValueUsd > 0 && live.reserveUsd > 0 && feeAprVolumeUsd > 0) {
    const share = Math.min(1, depositValueUsd / live.reserveUsd);
    feeIncomeWindowUsd = feeIncomeUsd({
      poolVolumeUsd: feeAprVolumeUsd,
      feeBps,
      positionShareOfPoolLiquidity: share,
      windowHours: request.windowHours,
    });
  }

  // 7. Notes.
  if (!hasUsd) {
    notes.push("USD prices unavailable (market-data missing and tokenPricesUsd not provided): USD figures null");
  }
  if (path && isFinite(initialPrice) && isFinite(currentPrice)) {
    const move = (currentPrice / initialPrice - 1) * 100;
    notes.push(`window price move ${move >= 0 ? "+" : ""}${move.toFixed(2)}% over ${request.windowHours}h (initial $${initialPrice.toPrecision(6)})`);
  }
  if (worstCaseFraction !== undefined) {
    notes.push(`worst-case IN WINDOW: IL up to ${(worstCaseFraction * 100).toFixed(2)}% on intra-window candle closes`);
  }
  if (feeIncomeWindowUsd !== null) {
    notes.push(`fee accrual on this deposit over window ≈ $${feeIncomeWindowUsd.toFixed(2)}, offsetting IL when accrued since deposit`);
  }
  if (ilFraction === 0 && model === "cpmm-50/50" && !stablePair && path) {
    // ilCpmm5050 always exact-zero only at r=1; 0 here would be a compute failure.
    notes.push("IL computed as 0: verify initial/current prices look correct for this window");
  }
  if (isFinite(ilFraction) && ilFraction * 100 > 10) {
    notes.push("High impermanent loss detected - consider single-sided or stable pools");
  }
  notes.push(
    `pool data: GeckoTerminal (${live.name}, fee ${feeBps}bp, 24h vol $${live.volume24hUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}, reserve $${live.reserveUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })})`,
  );

  const poolMetrics: PoolMetrics = {
    poolAddress: live.poolAddress,
    chain,
    token0: live.token0.address,
    token1: live.token1.address,
    token0Symbol: live.token0.symbol,
    token1Symbol: live.token1.symbol,
    reserve0: amt0Raw,
    reserve1: amt1Raw,
    feeBps,
    priceToken0Usd: hasUsd ? price0Usd : 0,
    priceToken1Usd: hasUsd ? price1Usd : 0,
    volume24hUsd: live.volume24hUsd,
    tvlUsd: live.reserveUsd,
    aprFee: feeApr,
    aprTotal: feeApr,
    currentPrice: isFinite(currentPrice) ? currentPrice : undefined,
    sqrtPriceX96: undefined,
    liquidity: undefined,
  };

  return {
    IL_percent: ilFraction === ilFraction ? Math.abs(ilFraction) * 100 : -1,
    il_fraction: ilFraction === ilFraction ? ilFraction : -1,
    model,
    fee_apr_est: feeApr,
    volume_window: feeAprVolumeUsd,
    hodlValueUsd: usdComputable ? depositValueUsd : null,
    lpValueUsd: usdComputable ? depositValueUsd * (1 - ilFraction) : null,
    impermanentLossUsd: usdComputable ? depositValueUsd * Math.abs(ilFraction) : null,
    concentration,
    poolMetrics,
    depositValueUsd,
    tokenAmounts: { token0: amt0Raw, token1: amt1Raw },
    notes,
    timestamp: Date.now(),
  };
}

export type { ChainConfig, PoolConfig, PoolMetrics, ILResult } from "./types";
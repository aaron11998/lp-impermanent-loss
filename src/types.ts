/**
 * LP Impermanent Loss Estimator - Shared Types
 * Bounty #7: LP Impermanent Loss Estimator
 */

// Supported chains
export type ChainId = "ethereum" | "arbitrum" | "optimism" | "base" | "polygon" | "bsc" | "avalanche";

// Chain configuration
export interface ChainConfig {
  name: ChainId;
  rpcUrl: string;
  nativeToken: string;
  nativeTokenPriceUsd: number;
  uniswapV2Factory?: string;
  uniswapV3Factory?: string;
  sushiswapV2Factory?: string;
  curveFactory?: string;
}

// Pool configuration
export interface PoolConfig {
  address: string;
  chain: ChainId;
  type: "uniswap-v2" | "uniswap-v3" | "sushiswap-v2" | "curve" | "balancer";
  token0: string;
  token1: string;
  token0Symbol?: string;
  token1Symbol?: string;
  feeBps?: number; // For V3 pools
  weights?: number[]; // For Balancer
}

// IL request
export interface ILRequest {
  poolAddress: string;
  chain: ChainId;
  depositAmounts: string[]; // Amount of each token (wei as strings)
  tokenWeights?: number[]; // Token weight distribution (must sum ~= 1)
  windowHours: number; // Historical window (default: 24h)
  tokenPricesUsd?: number[]; // Optional: provide prices for USD calculations
  /** Optional initial price override (token1 per token0) at deposit time.
   *  Omitted: derived from the deposit composition (simulated-deposit semantics). */
  initialPrice?: number;
  /** Optional concentrated-liquidity range (V3 / Slipstream / Velodrome V3). */
  range?: {
    /** Human price bounds (token1 per token0). */
    lower?: number;
    upper?: number;
    /** Tick bounds (override lower/upper when both given). */
    tickLower?: number;
    tickUpper?: number;
  };
}

// Pool metrics
export interface PoolMetrics {
  poolAddress: string;
  chain: ChainId;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  reserve0: string;
  reserve1: string;
  feeBps: number;
  priceToken0Usd: number;
  priceToken1Usd: number;
  volume24hUsd: number;
  tvlUsd: number;
  aprFee: number;
  aprTotal: number;
  /** Live on-chain price (token1 per token0, human decimals) when RPC available. */
  currentPrice?: number;
  /** Raw Uniswap V3 slot0.sqrtPriceX96 (Q64.96) when available. */
  sqrtPriceX96?: string;
  /** Uniswap V3 in-range liquidity (uint128) when available. */
  liquidity?: string;
}

// IL result
export interface ILResult {
  IL_percent: number; // Impermanent loss percentage (positive = loss vs HODL)
  fee_apr_est: number; // Estimated APR from fees
  volume_window: number; // Trading volume in window (USD)
  /** AMM model used for the IL computation. */
  model: "cpmm-50/50" | "weighted-product" | "concentrated";
  /** IL in fractional units (e.g. 0.2 = 20%). */
  il_fraction: number;
  /** HODL vs LP comparison at the current price. Null when pricing unavailable. */
  hodlValueUsd: number | null;
  lpValueUsd: number | null;
  impermanentLossUsd: number | null;
  /** Concentrated-range details (uniswap-v3 / slipstream / velodrome-v3). */
  concentration?: ConcentrationDetail;
  poolMetrics: PoolMetrics;
  depositValueUsd: number;
  tokenAmounts: {
    token0: string;
    token1: string;
  };
  notes: string[];
  timestamp: number;
}

export interface ConcentrationDetail {
  priceCurrent: number;
  priceInitial: number;
  rangeLower: number;
  rangeUpper: number;
  inRangeNow: boolean;
  inRangeInitial: boolean;
  token0ShareNow: number;
  holdingsToken0: number;
  holdingsToken1: number;
}

// Health endpoint response
export interface HealthResponse {
  status: "ok" | "degraded";
  chains: Record<ChainId, { configured: boolean; lastBlock?: number }>;
  timestamp: number;
}

// x402 manifest
export interface X402Manifest {
  x402Version: number;
  resource: string;
  description: string;
  accepts: Array<{
    scheme: "exact";
    network: string;
    asset: string;
    payTo: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
  }>;
  free: string[];
}
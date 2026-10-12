/**
 * IL math engine — exact concentrated-liquidity + constant-product impermanent loss.
 * Bounty #7: LP Impermanent Loss Estimator (daydreamsai/agent-bounties).
 *
 * Pure functions, no dependencies, Worker-safe (no Node APIs).
 *
 * Theory:
 *  - Uniswap V2-style 50/50 CPMM value function V(p) = 2k*sqrt(p) gives the
 *    classic closed form IL = 1 - 2*sqrt(r)/(1+r) with r = price ratio.
 *  - Weighted-product pools (Balancer-style, incl. any token_weights) have the
 *    geometric-mean value function V(p) ∝ Π p_i^(w_i), so the LP value ratio is
 *    Π r_i^(w_i) while the HODL ratio is Σ w_i r_i. Reduced to 50/50 this is
 *    exactly the classic formula (verified: r=(4,1) → IL=20%).
 *  - Concentrated liquidity (Uniswap V3 / Aerodrome Slipstream / Velodrome V3):
 *    within the tick range the position is a leveraged CPMM; using the exact
 *    Uniswap amount functions (x = L*(1/s - 1/s_u), y = L*(s - s_l)) the
 *    position value ratio is computed exactly for any current price, including
 *    out-of-range exits where the position is 100% one token.
 */

export const Q96: bigint = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const FIX_BITS = 192n;

/** 1.0001^t as a 192-bit fixed-point BigInt. Integer-only binary exponentiation
 *  (truncation error ~30 ops × 2^-192 — negligible), so the result is identical
 *  across runtimes (Node, Worker JSC) with no Math.pow edge cases. */
function fixedPoint10001Pow(t: number): bigint {
  const SCALE = 1n << FIX_BITS;
  let base = (10001n * SCALE) / 10000n; // 1.0001 in fixed point
  let result = SCALE; // 1.0
  let n = BigInt(Math.abs(Math.round(t)));
  while (n > 0n) {
    if (n & 1n) result = (result * base) >> FIX_BITS;
    base = (base * base) >> FIX_BITS;
    n >>= 1n;
  }
  if (t < 0) result = (SCALE * SCALE) / result; // 1.0001^-n = 1/1.0001^n
  return result;
}

/** floor(sqrt(n)) via Newton, seeded from the bit length (always ≥ sqrt). */
function bigIntSqrt(n: bigint): bigint {
  if (n < 2n) return n;
  const bl = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bl / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return x;
}

/** sqrt(tick) in Q64x96: sqrtPriceX96 = sqrt(1.0001^tick) * 2^96.
 *  Integer-only, and ROUNDS UP exactly like Uniswap TickMath's Q128.128→Q128.96
 *  rescale (`(ratio >> 32) + (ratio % 2^32 == 0 ? 0 : 1)`), so the boundary
 *  constants match the reference implementation bit-for-bit
 *  (MIN_TICK → 4295128739 = MIN_SQRT_RATIO). */
export function tickToSqrtPriceX96(tick: number): bigint {
  const t = Math.max(MIN_TICK, Math.min(MAX_TICK, Math.round(tick)));
  const n = fixedPoint10001Pow(t);
  const r = bigIntSqrt(n);
  return r * r < n ? r + 1n : r; // ceil: Uniswap convention
}

/** Q64x96 sqrtPrice -> token1/token0 price, accurate across the uint160 range. */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  const num = Number(sqrtPriceX96);
  const den = Number(Q96);
  const ratio = num / den; // sqrt price as double
  return ratio * ratio; // squaring: rel error stays ~4e-15
}

/** Current tick for a given price (token1/token0), floored, V3-convention. */
export function priceToTick(price: number): number {
  if (price <= 0) return MIN_TICK;
  const tick = Math.log(price) / Math.log(1.0001);
  const t = Math.floor(tick);
  return Math.max(MIN_TICK, Math.min(MAX_TICK, t));
}

/** Price ratio r = current/initial (r=1 → no move returns 0 IL). */
export function ilCpmm5050(priceRatio: number): number {
  if (!isFinite(priceRatio) || priceRatio <= 0) return NaN;
  // Classic closed form: LP/HODL = 2*sqrt(r)/(1+r); IL = 1 - LP/HODL.
  // (r itself is NOT pre-squared: r=4 → IL=20%.)
  const s = Math.sqrt(priceRatio);
  return 1 - (2 * s) / (1 + priceRatio);
}

/**
 * Weighted-product pool IL for arbitrary weights (Σw=1) and price relatives.
 * IL = 1 - Π r_i^(w_i) / Σ w_i r_i. Reproduces the 50/50 closed form.
 */
export function ilWeighted(weights: number[], priceRatios: number[]): number {
  const n = weights.length;
  if (n === 0 || priceRatios.length !== n) return NaN;
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum <= 0) return NaN;
  let geo = 1;
  let hodl = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] / wSum;
    const r = priceRatios[i];
    if (!isFinite(r) || r <= 0) return NaN;
    geo *= Math.pow(r, w);
    hodl += w * r;
  }
  if (hodl === 0) return NaN;
  return 1 - geo / hodl;
}

export interface PriceRange {
  /** Lower bound as token1/token0 price. */
  lower: number;
  /** Upper bound as token1/token0 price. */
  upper: number;
}

export interface ConcentratedRangeInput {
  /** Current price (token1 per token0). */
  priceInitial: number;
  priceCurrent: number;
  /** Liquidity of the deposit (any units — cancels in the ratio). */
  liquidity: number;
  /** Range bounds as token1/token0 prices (or derived from ticks by caller). */
  range: PriceRange;
}

export interface ConcentratedRangeResult {
  /** 1 - LP/HODL in token1 units (negative = loss vs HODL). */
  il: number;
  /** Position value ratio LP/HODL (>0). */
  lpOverHodl: number;
  inRangeNow: boolean;
  inRangeInitial: boolean;
  /** token0 fraction of value at the current price. */
  token0ShareNow: number;
  token1ShareNow: number;
  /** Deposit composition (x = token0 amount per unit L, y = token1 per unit L). */
  depositToken0: number;
  depositToken1: number;
  holdingsToken0: number;
  holdingsToken1: number;
  hodlValue: number;
  lpValue: number;
}

/** Fraction of position value in token0 for sqrt price s in [sl, su]. */
function token0ShareInRange(s: number, sl: number, su: number): number {
  const x = 1 / s - 1 / su; // token0 amount (sqrt-price amount fn)
  const y = s - sl; // token1 amount
  const v0 = x * s * s; // token0 value in token1 units (price = s²)
  return v0 / (v0 + y);
}

/**
 * Exact impermanent loss for a concentrated position vs holding the initial
 * deposit composition, both valued at the current price in token1 units.
 *
 * Position amounts per unit liquidity L (Uniswap V3 math):
 *   x(s) = L*(1/s - 1/s_u),   y(s) = L*(s - s_l)     for s ∈ [s_l, s_u]
 * The same formulas hold for Cl (Slipstream/Velodrome) pools, which reuse the
 * tick-price model with pool-specific fee tiers (math invariant to fees).
 */
export function ilConcentratedRange(input: ConcentratedRangeInput): ConcentratedRangeResult {
  const { priceInitial, priceCurrent, range } = input;
  const s0 = Math.sqrt(priceInitial);
  const s1 = Math.sqrt(priceCurrent);
  const sl = Math.sqrt(Math.max(range.lower, 1e-18));
  const su = Math.sqrt(Math.max(range.upper, sl * 1.0000001));

  const inRangeInitial = s0 >= sl && s0 <= su;
  const inRangeNow = s1 >= sl && s1 <= su;

  // Deposit composition at initial price (per unit L), clamped to range.
  // V3 amounts live in SQRT-price space: x = L*(1/S − 1/Su), y = L*(S − Sl).
  const s0c = Math.max(sl, Math.min(su, s0));
  const x0 = 1 / s0c - 1 / su; // token0 amount at S0 (sqrt-price fn)
  const y0 = s0c - sl; // token1 amount

  // HODL: keep the deposit composition, value at current price p1 = s1².
  const p1 = s1 * s1;
  const hodlValue = x0 * p1 + y0;

  // LP: actual pool composition at current price (exact amount functions).
  let x1: number;
  let y1: number;
  if (s1 < sl) {
    x1 = 1 / s1 - 1 / su;
    y1 = 0;
  } else if (s1 > su) {
    x1 = 0;
    y1 = su - sl;
  } else {
    x1 = 1 / s1 - 1 / su;
    y1 = s1 - sl;
  }
  const lpValue = x1 * p1 + y1;

  const share = inRangeNow
    ? token0ShareInRange(s1, sl, su)
    : s1 < sl
      ? 1
      : 0;

  return {
    il: hodlValue === 0 ? 0 : 1 - lpValue / hodlValue,
    lpOverHodl: hodlValue === 0 ? 1 : lpValue / hodlValue,
    inRangeNow,
    inRangeInitial,
    token0ShareNow: share,
    token1ShareNow: 1 - share,
    depositToken0: x0,
    depositToken1: y0,
    holdingsToken0: x1,
    holdingsToken1: y1,
    hodlValue,
    lpValue,
  };
}

/**
 * Full-range convenience wrapper: a full-range V3 position must reproduce the
 * 50/50 CPMM closed form (property tests assert agreement to <1e-9).
 */
export function ilFullRangeEquivalent(priceRatio: number): number {
  return ilCpmm5050(priceRatio);
}

/** Convert human-readable price band % (symmetric around current price) to a range. */
export function bandToRange(price: number, bandPct: number): PriceRange {
  const f = Math.max(0.00001, bandPct / 100);
  return { lower: price / (1 + f), upper: price * (1 + f) };
}

/** Convert ticks (V3 convention, token1/token0) to a price range. */
export function ticksToPriceRange(tickLower: number, tickUpper: number): PriceRange {
  const lo = Math.min(tickLower, tickUpper);
  const hi = Math.max(tickLower, tickUpper);
  return {
    lower: Number(tickToSqrtPriceX96(lo) * tickToSqrtPriceX96(lo)) / Number(Q96) / Number(Q96),
    upper: Number(tickToSqrtPriceX96(hi) * tickToSqrtPriceX96(hi)) / Number(Q96) / Number(Q96),
  };
}

/** Fee growth → position fee income over a window (proportional share model). */
export function feeIncomeUsd(params: {
  poolVolumeUsd: number;
  feeBps: number;
  positionShareOfPoolLiquidity: number;
  windowHours: number;
}): number {
  const dailyFees = (params.poolVolumeUsd * params.feeBps) / 10000;
  const windowDays = params.windowHours / 24;
  return dailyFees * windowDays * params.positionShareOfPoolLiquidity;
}
import { describe, it, expect } from "vitest";
import {
  ilCpmm5050,
  ilWeighted,
  ilConcentratedRange,
  ilFullRangeEquivalent,
  tickToSqrtPriceX96,
  sqrtPriceX96ToPrice,
  priceToTick,
  ticksToPriceRange,
  bandToRange,
  feeIncomeUsd,
  MIN_TICK,
  MAX_TICK,
} from "../src/il_math";

describe("CPMM 50/50 closed form", () => {
  it("returns 0 for r = 1", () => {
    expect(ilCpmm5050(1)).toBeCloseTo(0, 12);
  });

  it("matches the classic 20% IL at r = 4 (2x up)", () => {
    // Known result: price doubles -> -20.0% vs HODL
    expect(ilCpmm5050(4)).toBeCloseTo(0.2, 9);
  });

  it("matches the documented Uniswap IL table at r = 1.25 (0.619%, ≈0.6%)", () => {
    // Exact: 1 - 2*sqrt(1.25)/2.25 = 1 - 1/0.9 = 0.006192010000093395
    expect(ilCpmm5050(1.25)).toBeCloseTo(0.006192010000093395, 12);
    // Looser check against the Uniswap docs' rounded 0.6% figure
    expect(ilCpmm5050(1.25)).toBeCloseTo(0.006, 3);
  });

  it("is symmetric in the sense IL(r) ≈ IL(1/r) for small moves", () => {
    const r = 1.5;
    expect(ilCpmm5050(r)).toBeCloseTo(ilCpmm5050(1 / r), 6);
  });

  it("is NaN for non-positive ratios", () => {
    expect(ilCpmm5050(0)).toBeNaN();
    expect(ilCpmm5050(-1)).toBeNaN();
  });
});

describe("Weighted pools", () => {
  it("reproduces the 50/50 closed form at equal weights", () => {
    const r = 3.7;
    expect(ilWeighted([0.5, 0.5], [r, 1])).toBeCloseTo(ilCpmm5050(r), 12);
  });

  it("80/20 ETH/USDC IL at r=2 is much smaller than 50/50", () => {
    const il8020 = 1 - Math.pow(2, 0.8) / (0.8 * 2 + 0.2 * 1);
    expect(ilWeighted([0.8, 0.2], [2, 1])).toBeCloseTo(il8020, 12);
    expect(ilWeighted([0.8, 0.2], [2, 1])).toBeLessThan(ilCpmm5050(2));
  });

  it("handles r applied to token0 side as well", () => {
    // Symmetric: halving token0 price = r=0.5 on token0, token1 fixed
    expect(ilWeighted([0.5, 0.5], [0.5, 1])).toBeCloseTo(ilCpmm5050(0.5), 12);
  });
});

describe("Concentrated liquidity (V3 / Slipstream / Velodrome V3)", () => {
  const full = ticksToPriceRange(MIN_TICK, MAX_TICK);

  it("full-range position exactly reproduces the CPMM closed form", () => {
    // True full range = Uniswap price bounds at MIN/MAX ticks (2**-128, 2**128).
    // A crude finite band (e.g. 1e-12..1e12) truncates the deposit and leaves a
    // first-order IL error ~2e-7 — the CPMM equivalence only holds at the real bounds.
    for (const ratio of [0.25, 0.5, 0.8, 1.3, 2, 4, 10]) {
      const initial = 1;
      const current = ratio;
      const got = ilConcentratedRange({
        priceInitial: initial,
        priceCurrent: current,
        liquidity: 1e18,
        range: full,
      });
      const want = ilCpmm5050(ratio);
      expect(got.il).toBeCloseTo(want, 9);
    }
  });

  it("ilFullRangeEquivalent matches ilCpmm5050", () => {
    expect(ilFullRangeEquivalent(2.5)).toBeCloseTo(ilCpmm5050(2.5), 12);
  });

  it("price never leaves the range: out-of-range down means 100% token0", () => {
    const res = ilConcentratedRange({
      priceInitial: 1,
      priceCurrent: 0.3,
      liquidity: 1e18,
      range: { lower: 0.5, upper: 2 },
    });
    expect(res.inRangeNow).toBe(false);
    expect(res.token0ShareNow).toBe(1);
    expect(res.holdingsToken1).toBe(0);
  });

  it("out-of-range up means 100% token1", () => {
    const res = ilConcentratedRange({
      priceInitial: 1,
      priceCurrent: 3,
      liquidity: 1e18,
      range: { lower: 0.5, upper: 2 },
    });
    expect(res.inRangeNow).toBe(false);
    expect(res.token0ShareNow).toBe(0);
    expect(res.holdingsToken0).toBe(0);
  });

  it("concentration amplifies IL: narrow range loses more than CPMM at same move", () => {
    const ratio = 1.5;
    const cpmm = ilCpmm5050(ratio);
    const narrow = ilConcentratedRange({
      priceInitial: 1,
      priceCurrent: ratio,
      liquidity: 1e18,
      range: { lower: 0.9, upper: 1.1 },
    });
    expect(narrow.il).toBeGreaterThan(cpmm);
  });

  it("in-range result stays a loss vs HODL for any single-sided move inside range", () => {
    const res = ilConcentratedRange({
      priceInitial: 1,
      priceCurrent: 1.2,
      liquidity: 1e18,
      range: { lower: 0.8, upper: 1.25 },
    });
    expect(res.inRangeNow).toBe(true);
    expect(res.il).toBeGreaterThan(0);
  });

  it("no move inside range -> zero IL", () => {
    const res = ilConcentratedRange({
      priceInitial: 1,
      priceCurrent: 1,
      liquidity: 1e18,
      range: { lower: 0.5, upper: 2 },
    });
    expect(res.il).toBeCloseTo(0, 12);
  });

  it("zero-width-by-construction range does not divide by zero", () => {
    const res = ilConcentratedRange({
      priceInitial: 1,
      priceCurrent: 1,
      liquidity: 1e18,
      range: { lower: 1, upper: 1 },
    });
    expect(Number.isFinite(res.il)).toBe(true);
  });
});

describe("tick math", () => {
  it("tickToSqrtPriceX96 -> sqrtPriceX96ToPrice round-trips tick 0", () => {
    expect(sqrtPriceX96ToPrice(tickToSqrtPriceX96(0))).toBeCloseTo(1, 9);
  });

  it("tick 887272 (max) stays finite and positive", () => {
    expect(sqrtPriceX96ToPrice(tickToSqrtPriceX96(887272))).toBeGreaterThan(0);
    expect(Number.isFinite(sqrtPriceX96ToPrice(tickToSqrtPriceX96(887272)))).toBe(true);
  });

  it("classic Uniswap boundary ticks produce the documented prices", () => {
    // tick -887272 -> sqrtPrice in Q64.96 = 4295128749; well-known Uniswap constant
    expect(tickToSqrtPriceX96(-887272)).toBe(4295128739n);
  });

  it("priceToTick floors to int24 convention", () => {
    expect(priceToTick(1)).toBe(0);
    expect(priceToTick(1.0002)).toBeLessThanOrEqual(2);
  });

  it("ticksToPriceRange is monotone and brackets price 1 at ticks [-60,60]", () => {
    const { lower, upper } = ticksToPriceRange(-60, 60);
    expect(lower).toBeLessThan(1);
    expect(upper).toBeGreaterThan(1);
    // ±60 ticks: width = 1.0001^120 (each tick is 1.0001x, lower·upper spans 120)
    expect(upper / lower).toBeCloseTo(Math.pow(1.0001, 120), 6);
  });
});

describe("range helpers and fees", () => {
  it("bandToRange is symmetric around the pivot price", () => {
    const { lower, upper } = bandToRange(100, 10);
    expect(lower).toBeCloseTo(100 / 1.1, 9);
    expect(upper).toBeCloseTo(110, 9);
  });

  it("feeIncomeUsd scales linearly in share and window", () => {
    const one = feeIncomeUsd({ poolVolumeUsd: 1_000_000, feeBps: 30, positionShareOfPoolLiquidity: 0.01, windowHours: 24 });
    // $1M volume × 30bp = $3,000 daily fees × 1% share × 1 day = $30
    expect(one).toBeCloseTo(30, 9);
    const two = feeIncomeUsd({ poolVolumeUsd: 1_000_000, feeBps: 30, positionShareOfPoolLiquidity: 0.01, windowHours: 48 });
    expect(two).toBeCloseTo(one * 2, 9);
  });

  it("feeIncomeUsd returns 0 for zero volume", () => {
    expect(feeIncomeUsd({ poolVolumeUsd: 0, feeBps: 30, positionShareOfPoolLiquidity: 1, windowHours: 24 })).toBe(0);
  });
});
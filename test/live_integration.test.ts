import { describe, it, expect } from "vitest";
import { estimateImpermanentLoss } from "../src/chains";

/**
 * Opt-in live integration tests (real GeckoTerminal data).
 * Run once locally with: LIVE_TESTS=1 npx vitest run test/live_integration.test.ts
 * Skipped by default so offline CI stays green and deterministic.
 */
const LIVE = !!process.env.LIVE_TESTS;

describe.skipIf(!LIVE)("live GeckoTerminal integration (free-data path)", () => {
  it("ETH/USDC uniswap-v3 pool: real 24h window IL is finite and plausible", async () => {
    const result = await estimateImpermanentLoss(
      {
        poolAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296Fcb3f5640",
        chain: "ethereum",
        depositAmounts: ["1000000000", "3000000000000000000"], // 1000 USDC + 3 ETH (6/18 decimals)
        windowHours: 24,
        range: { tickLower: -887220, tickUpper: 887220 },
      },
      {}
    );

    // The v1 bug this engine fixes: IL_percent hardcoded to 0. A real 24h
    // ETH/USDC window virtually never yields exactly 0 IL.
    expect(result.IL_percent).toBeGreaterThanOrEqual(0);
    expect(result.IL_percent).not.toBe(0);
    expect(Number.isFinite(result.IL_percent)).toBe(true);
    expect(result.model).toBe("concentrated");
    expect(result.il_fraction).not.toBe(0);
    expect(result.concentration).toBeDefined();
    expect(result.concentration!.inRangeNow).toBe(true);
    // Fee APR from real 24h volume / TVL must be positive.
    expect(result.fee_apr_est).toBeGreaterThan(0);
    expect(result.volume_window).toBeGreaterThan(0);
    // Pool metrics must be populated from GT (not the v1 all-zeros).
    expect(result.poolMetrics.tvlUsd).toBeGreaterThan(0);
    expect(result.notes.some((n) => n.startsWith("pool data: GeckoTerminal"))).toBe(true);
  }, 45000);

  it("stable/stable pair returns IL 0 with a fee-APR note", async () => {
    // GT-indexed USDC/USDT pool (Uniswap v3 0.05%, Ethereum)
    const result = await estimateImpermanentLoss(
      {
        poolAddress: "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b",
        chain: "ethereum",
        depositAmounts: ["500000000", "500000000"],
        windowHours: 24,
      },
      {}
    );
    expect(result.IL_percent).toBe(0);
    expect(result.fee_apr_est).toBeGreaterThanOrEqual(0);
    expect(result.notes.some((n) => n.includes("stable/stable"))).toBe(true);
  }, 45000);
});
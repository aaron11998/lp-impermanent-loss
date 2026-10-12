import { describe, it, expect } from "vitest";
import { CHAINS, getChainConfig, getConfiguredChains, findPoolConfig, calculateImpermanentLoss, calculateFeeAPR } from "../src/chains";
import { ChainId } from "../src/types";

describe("Chains Configuration", () => {
  it("should have all 7 chains configured", () => {
    expect(Object.keys(CHAINS).length).toBe(7);
    expect(CHAINS.ethereum).toBeDefined();
    expect(CHAINS.arbitrum).toBeDefined();
    expect(CHAINS.optimism).toBeDefined();
    expect(CHAINS.base).toBeDefined();
    expect(CHAINS.polygon).toBeDefined();
    expect(CHAINS.bsc).toBeDefined();
    expect(CHAINS.avalanche).toBeDefined();
  });

  it("should have required properties for each chain", () => {
    const chains: ChainId[] = ["ethereum", "arbitrum", "optimism", "base", "polygon", "bsc", "avalanche"];
    for (const chain of chains) {
      const config = CHAINS[chain];
      expect(config.name).toBe(chain);
      expect(config.nativeToken).toBeDefined();
      expect(config.nativeTokenPriceUsd).toBeGreaterThan(0);
    }
  });

  it("should have Uniswap V2 and V3 factories for Ethereum", () => {
    const eth = CHAINS.ethereum;
    expect(eth.uniswapV2Factory).toBeDefined();
    expect(eth.uniswapV3Factory).toBeDefined();
  });
});

describe("Chain Helpers", () => {
  it("getChainConfig should return correct config", () => {
    const eth = getChainConfig("ethereum");
    expect(eth.name).toBe("ethereum");
    expect(eth.nativeToken).toBe("ETH");
    expect(eth.nativeTokenPriceUsd).toBe(2600);
  });

  it("getChainConfig should throw for unknown chain", () => {
    expect(() => getChainConfig("unknown" as ChainId)).toThrow();
  });

  it("getConfiguredChains should filter by env vars", () => {
    const env = {
      ETHEREUM_RPC_URL: "https://eth.example.com",
      ARBITRUM_RPC_URL: "https://arb.example.com",
    };
    const configured = getConfiguredChains(env);
    expect(configured).toContain("ethereum");
    expect(configured).toContain("arbitrum");
    expect(configured).not.toContain("optimism");
  });

  it("getConfiguredChains should return empty for no config", () => {
    const configured = getConfiguredChains({});
    expect(configured.length).toBe(0);
  });
});

describe("Pool Lookup", () => {
  it("findPoolConfig should find known pools", () => {
    const pool = findPoolConfig("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc", "ethereum");
    expect(pool).toBeDefined();
    expect(pool?.token0Symbol).toBe("WETH");
    expect(pool?.token1Symbol).toBe("USDC");
    expect(pool?.feeBps).toBe(30);
  });

  it("findPoolConfig should return undefined for unknown pool", () => {
    const pool = findPoolConfig("0x0000000000000000000000000000000000000000", "ethereum");
    expect(pool).toBeUndefined();
  });
});

describe("IL Calculations", () => {
  it("calculateImpermanentLoss should return 0 for no price change", () => {
    const il = calculateImpermanentLoss(1, 1);
    expect(il).toBe(0);
  });

  it("calculateImpermanentLoss should return positive for price divergence", () => {
    const il = calculateImpermanentLoss(1, 2); // 2x price change
    expect(il).toBeGreaterThan(0);
    expect(il).toBeLessThan(100);
  });

  it("calculateImpermanentLoss should be symmetric", () => {
    const il1 = calculateImpermanentLoss(1, 2);
    const il2 = calculateImpermanentLoss(2, 1);
    expect(il1).toBeCloseTo(il2, 5);
  });
});

describe("Fee APR Calculation", () => {
  it("calculateFeeAPR should return 0 for zero TVL", () => {
    const apr = calculateFeeAPR(1000000, 0, 30);
    expect(apr).toBe(0);
  });

  it("calculateFeeAPR should calculate correctly", () => {
    // $1M volume, $10M TVL, 0.3% fee
    const apr = calculateFeeAPR(1000000, 10000000, 30);
    // Daily fees = 1M * 0.003 = 3000
    // Annual = 3000 * 365 = 1,095,000
    // APR = 1,095,000 / 10,000,000 * 100 = 10.95%
    expect(apr).toBeCloseTo(10.95, 1);
  });
});
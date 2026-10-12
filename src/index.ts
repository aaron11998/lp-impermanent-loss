/**
 * LP Impermanent Loss Estimator - Main Entry Point
 * Bounty #7: LP Impermanent Loss Estimator
 * Cloudflare Worker with x402 payment gating
 */

import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { handleHealth } from "./health";
import { handleIL, handleX402Manifest } from "./il_endpoint";

type Bindings = {
  ORG_EVM_PAYTO: string;
  ETHEREUM_RPC_URL: string;
  ARBITRUM_RPC_URL: string;
  OPTIMISM_RPC_URL: string;
  BASE_RPC_URL: string;
  POLYGON_RPC_URL: string;
  BSC_RPC_URL: string;
  AVALANCHE_RPC_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Free endpoints
app.get("/health", async (c) => {
  const health = await handleHealth(c.env);
  return c.json(health);
});

app.get("/.well-known/x402.json", async (c) => {
  return handleX402Manifest();
});

// Paid endpoint with x402
app.use("/il", async (c, next) => {
  const mw = paymentMiddleware(c.env.ORG_EVM_PAYTO as `0x${string}`, {
    "/il": {
      price: "$0.01",
      network: "base",
      config: {
        description: "LP Impermanent Loss Estimator: Calculate IL and fee APR for any LP position",
      },
    },
  });
  return mw(c, next);
});

app.post("/il", async (c) => {
  return handleIL(c.req.raw, c.env);
});

export default app;
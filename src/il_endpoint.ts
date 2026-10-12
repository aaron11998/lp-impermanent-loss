/**
 * LP Impermanent Loss Estimator - x402 IL Endpoint
 * Bounty #7: LP Impermanent Loss Estimator
 */

import { ILRequest, ILResult, X402Manifest } from "./types";
import { estimateImpermanentLoss } from "./chains";

const X402_NETWORK = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ORG_EVM_PAYTO = "0x76EfB727cd3271C7DE22f92437Be212766C9631f";

export async function handleIL(request: Request, env: { [key: string]: string }): Promise<Response> {
  try {
    const body: ILRequest = await request.json();
    
    // Validate required fields
    if (!body.poolAddress || !body.chain || !body.depositAmounts || !body.depositAmounts.length) {
      return new Response(JSON.stringify({ error: "Missing required fields: poolAddress, chain, depositAmounts" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.windowHours || body.windowHours <= 0) {
      body.windowHours = 24; // spec default
    }
    if (body.windowHours > 24 * 400) {
      body.windowHours = 24 * 400; // ~13 months of daily candles
    }

    // Estimate impermanent loss (env carries <CHAIN>_RPC_URL secrets)
    const result = await estimateImpermanentLoss(body, env);
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function handleX402Manifest(): Promise<Response> {
  const manifest: X402Manifest = {
    x402Version: 2,
    resource: "/il",
    description: "LP Impermanent Loss Estimator: Calculate IL and fee APR for any LP position",
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK,
        asset: USDC_BASE,
        payTo: ORG_EVM_PAYTO,
        maxAmountRequired: "10000", // $0.01 in USDC base units
        resource: "/il",
        description: "One /il API call",
      },
    ],
    free: ["/health", "/.well-known/x402.json"],
  };
  
  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
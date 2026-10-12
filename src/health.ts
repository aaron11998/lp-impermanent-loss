/**
 * LP Impermanent Loss Estimator - Health Endpoint
 * Bounty #7: LP Impermanent Loss Estimator
 */

import { HealthResponse, ChainId } from "./types";
import { CHAINS } from "./chains";

export async function handleHealth(env: { [key: string]: string }): Promise<HealthResponse> {
  const chains: Record<ChainId, { configured: boolean; lastBlock?: number }> = {
    ethereum: { configured: !!env.ETHEREUM_RPC_URL },
    arbitrum: { configured: !!env.ARBITRUM_RPC_URL },
    optimism: { configured: !!env.OPTIMISM_RPC_URL },
    base: { configured: !!env.BASE_RPC_URL },
    polygon: { configured: !!env.POLYGON_RPC_URL },
    bsc: { configured: !!env.BSC_RPC_URL },
    avalanche: { configured: !!env.AVALANCHE_RPC_URL },
  };

  const allConfigured = Object.values(chains).every(c => c.configured);
  
  return {
    status: allConfigured ? "ok" : "degraded",
    chains,
    timestamp: Date.now(),
  };
}
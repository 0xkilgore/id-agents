// Register Claude Code team members onchain via AgentRegistrar
import { registerAgentOnchain } from '../src/onchain/agent-registry.js';
import { encodeERC7930 } from '../src/core/erc7930.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Hex, Address } from 'viem';
import 'dotenv/config';

const TEAM_MEMBERS = ['project-manager', 'backend-dev', 'frontend-dev', 'copywriter'];

async function main() {
  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  const registrarKey = process.env.ID_REGISTRAR_PRIVATE_KEY as Hex;
  const registrarAddress = process.env.AGENT_REGISTRAR_ADDRESS as Address;
  const chainId = parseInt(process.env.REGISTRY_CHAIN_ID || '11155111');

  if (!rpcUrl || !registrarKey || !registrarAddress) {
    console.error('Missing env vars: SEPOLIA_RPC_URL, ID_REGISTRAR_PRIVATE_KEY, AGENT_REGISTRAR_ADDRESS');
    process.exit(1);
  }

  const owner = privateKeyToAccount(registrarKey).address;
  const results: Record<string, any> = {};

  for (const name of TEAM_MEMBERS) {
    console.log(`\nRegistering ${name}...`);

    // Generate a wallet for the agent
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    console.log(`  Wallet: ${account.address}`);

    try {
      const result = await registerAgentOnchain({
        rpcUrl,
        chainId,
        registrarPrivateKey: registrarKey,
        registrarAddress,
        owner,
        endpointType: 'claude-code-teams',
        endpoint: `local://${name}`,
        agentAccount: account.address,
        name,
      });

      const erc7930 = encodeERC7930(chainId, result.registryAddress);
      const displayId = result.domain || name;

      results[name] = {
        tokenId: result.tokenId,
        txHash: result.txHash,
        registryAddress: result.registryAddress,
        wallet: account.address,
        privateKey,
        erc7930,
        displayId,
      };

      console.log(`  Token ID: ${result.tokenId}`);
      console.log(`  Tx: ${result.txHash}`);
      console.log(`  ID: ${displayId}`);
    } catch (err: any) {
      console.error(`  Failed: ${err.message}`);
      results[name] = { error: err.message };
    }
  }

  // Save results
  const outDir = join(import.meta.dirname, '..', '.claude', 'team-registry');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'web-dev-team.json'), JSON.stringify(results, null, 2));
  console.log(`\nResults saved to .claude/team-registry/web-dev-team.json`);

  // Print summary
  console.log('\n=== Team Registry ===');
  for (const [name, data] of Object.entries(results)) {
    if (data.error) {
      console.log(`  ${name}: FAILED - ${data.error}`);
    } else {
      console.log(`  ${data.displayId}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

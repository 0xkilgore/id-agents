// SPDX-License-Identifier: MIT
/**
 * ID Chain Registration via id-cli
 *
 * Shells out to the `id-cli` CLI to register agents on ID Chain
 * (IDAgentRegistrar on Base/Ethereum/Optimism/Arbitrum).
 *
 * Replaces the old ERC-6909 agent-registry.ts which called a
 * different NFT contract directly via viem.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface IdChainRegisterResult {
  domain: string;       // e.g. "agent-10.base.xid.eth"
  label: string;        // e.g. "agent-10"
  txHash: string;
  chainId: number;
  chain: string;        // e.g. "Base"
}

export interface IdChainEndpointsResult {
  domain: string;
  txHash: string;
  records: Array<{ key: string; value: string }>;
}

/**
 * Register a new agent on ID Chain via `id-cli register`.
 * Returns the domain name and label assigned by the sequential registrar.
 */
export async function registerOnIdChain(opts: {
  chain?: string;
  textRecords?: Record<string, string>;
  privateKey?: string;
}): Promise<IdChainRegisterResult> {
  const chain = opts.chain || 'base';
  const args = ['register', '--chain', chain, '--output', 'json'];

  if (opts.textRecords) {
    for (const [key, value] of Object.entries(opts.textRecords)) {
      args.push('--text', `${key}=${value}`);
    }
  }

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.privateKey) {
    env.PRIVATE_KEY = opts.privateKey;
  }

  console.log(`[ID Chain] Registering agent on ${chain} via id-cli...`);

  const { stdout } = await execFileAsync('id-cli', args, {
    encoding: 'utf8',
    env,
    timeout: 120000,
  });

  const parsed = JSON.parse(stdout);
  if (parsed.status !== 'ok') {
    throw new Error(`id-cli register failed: ${JSON.stringify(parsed)}`);
  }

  console.log(`[ID Chain] Registered: ${parsed.data.domain} (tx: ${parsed.data.txHash})`);

  return {
    domain: parsed.data.domain,
    label: parsed.data.label,
    txHash: parsed.data.txHash,
    chainId: parsed.metadata.chainId,
    chain: parsed.metadata.chain,
  };
}

/**
 * Set ENSIP-26 agent endpoints on a registered name via `id-cli set-agent-endpoints`.
 */
export async function setAgentEndpoints(opts: {
  name: string;
  chain?: string;
  privateKey?: string;
  mcp?: string;
  a2a?: string;
  web?: string;
  context?: string;
}): Promise<IdChainEndpointsResult> {
  const chain = opts.chain || 'base';
  const args = ['set-agent-endpoints', opts.name, '--chain', chain, '--output', 'json'];

  if (opts.mcp) args.push('--mcp', opts.mcp);
  if (opts.a2a) args.push('--a2a', opts.a2a);
  if (opts.web) args.push('--web', opts.web);
  if (opts.context) args.push('--context', opts.context);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.privateKey) {
    env.PRIVATE_KEY = opts.privateKey;
  }

  console.log(`[ID Chain] Setting endpoints on ${opts.name}...`);

  const { stdout } = await execFileAsync('id-cli', args, {
    encoding: 'utf8',
    env,
    timeout: 120000,
  });

  const parsed = JSON.parse(stdout);

  console.log(`[ID Chain] Endpoints set on ${parsed.data?.domain || opts.name}`);

  return {
    domain: parsed.data?.domain || opts.name,
    txHash: parsed.data?.txHash || '',
    records: parsed.data?.records || [],
  };
}

/**
 * Create a subname under an existing agent name via `id-cli create-subname`.
 * e.g. createSubnameOnIdChain({ parent: 'agent-10', sublabel: 'x', chain: 'sepolia' })
 *   → id-cli create-subname agent-10 x --chain sepolia --output json
 *   → x.agent-10.sep.xid.eth
 */
export async function createSubnameOnIdChain(opts: {
  sublabel: string;
  parent: string;
  chain?: string;
  privateKey?: string;
  owner?: string;
}): Promise<{ domain: string; txHash: string }> {
  const chain = opts.chain || 'base';
  const args = ['create-subname', opts.sublabel, '--parent', opts.parent, '--chain', chain, '--output', 'json'];

  if (opts.owner) args.push('--owner', opts.owner);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.privateKey) {
    env.PRIVATE_KEY = opts.privateKey;
  }

  const { stdout } = await execFileAsync('id-cli', args, {
    encoding: 'utf8',
    env,
    timeout: 120000,
  });

  const parsed = JSON.parse(stdout);
  return {
    domain: parsed.data?.domain || `${opts.sublabel}.${opts.parent}`,
    txHash: parsed.data?.txHash || '',
  };
}

/**
 * Get info about a registered name via `id-cli info`.
 */
export async function getAgentInfo(opts: {
  name: string;
  chain?: string;
}): Promise<any> {
  const chain = opts.chain || 'base';
  const args = ['info', opts.name, '--chain', chain, '--output', 'json'];

  const { stdout } = await execFileAsync('id-cli', args, {
    encoding: 'utf8',
    timeout: 30000,
  });

  const parsed = JSON.parse(stdout);
  return parsed.data;
}

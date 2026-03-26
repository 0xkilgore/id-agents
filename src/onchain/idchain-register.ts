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

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Build env for id-cli, setting either OWS_WALLET or PRIVATE_KEY. */
function buildIdCliEnv(opts: { privateKey?: string; wallet?: string }): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.wallet) {
    env.OWS_WALLET = opts.wallet;
  } else if (opts.privateKey) {
    env.PRIVATE_KEY = opts.privateKey;
  }
  return env;
}

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
  wallet?: string;
}): Promise<IdChainRegisterResult> {
  const chain = opts.chain || 'base';
  const args = ['register', '--chain', chain, '--output', 'json'];

  if (opts.textRecords) {
    for (const [key, value] of Object.entries(opts.textRecords)) {
      args.push('--text', `${key}=${value}`);
    }
  }

  const env = buildIdCliEnv(opts);

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
  wallet?: string;
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

  const env = buildIdCliEnv(opts);

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
  wallet?: string;
  owner?: string;
}): Promise<{ domain: string; txHash: string }> {
  const chain = opts.chain || 'base';
  const args = ['create-subname', opts.sublabel, '--parent', opts.parent, '--chain', chain, '--output', 'json'];

  if (opts.owner) args.push('--owner', opts.owner);

  const env = buildIdCliEnv(opts);

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

/**
 * ENSIP-11 coin types for multi-chain address records.
 * Maps CAIP-2-style chain prefixes from OWS output to ENSIP-11 coin types.
 */
const CHAIN_COIN_TYPES: Array<{ prefix: string; coinType: number; label: string }> = [
  { prefix: 'eip155:1',        coinType: 2147483648, label: 'EVM wildcard' },    // 0x80000000
  { prefix: 'bip122:',         coinType: 0,          label: 'Bitcoin' },
  { prefix: 'cosmos:',         coinType: 118,        label: 'Cosmos' },
  { prefix: 'tron:',           coinType: 195,        label: 'Tron' },
  { prefix: 'ton:',            coinType: 607,        label: 'TON' },
  { prefix: 'fil:',            coinType: 461,        label: 'Filecoin' },
  { prefix: 'sui:',            coinType: 784,        label: 'Sui' },
];

/**
 * Parse addresses from `ows wallet list` output for a specific wallet.
 * Returns a map of CAIP-2 chain prefix → address.
 */
function parseOwsWalletAddresses(walletName: string): Map<string, string> {
  const addresses = new Map<string, string>();
  try {
    const output = execFileSync('ows', ['wallet', 'list'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    // Find the section for our wallet and parse its addresses
    let inWallet = false;
    for (const line of output.split('\n')) {
      if (line.includes('Name:') && line.includes(walletName)) {
        inWallet = true;
        continue;
      }
      if (inWallet && line.includes('Name:')) break; // next wallet
      if (inWallet) {
        const match = line.trim().match(/^(.+?)\s*(?:\([^)]*\)\s*)?→\s*(\S+)/);
        if (match) {
          addresses.set(match[1].trim(), match[2].trim());
        }
      }
    }
  } catch {
    // OWS not installed or wallet not found — skip silently
  }
  return addresses;
}

/**
 * Set multi-chain address records on a registered ENS name.
 * Reads addresses from an OWS wallet and calls `id-cli set-addr` for each
 * supported chain (ENSIP-11 coin types).
 *
 * Skips silently if OWS is not installed, wallet has no addresses,
 * or id-cli set-addr fails for a given chain.
 */
export async function setMultiChainAddresses(opts: {
  name: string;
  walletName: string;
  chain?: string;
  privateKey?: string;
  wallet?: string;
}): Promise<{ set: string[]; skipped: string[] }> {
  const set: string[] = [];
  const skipped: string[] = [];

  const addresses = parseOwsWalletAddresses(opts.walletName);
  if (addresses.size === 0) {
    return { set, skipped: ['no-addresses'] };
  }

  const idCliChain = opts.chain || 'base';
  const env = buildIdCliEnv(opts);

  // Build batch of coin types and addresses for a single set-record call
  const coinTypes: string[] = [];
  const addrs: string[] = [];

  for (const { prefix, coinType, label } of CHAIN_COIN_TYPES) {
    let addr: string | undefined;
    for (const [key, value] of addresses) {
      if (key.startsWith(prefix)) {
        addr = value;
        break;
      }
    }

    if (!addr) {
      skipped.push(label);
      continue;
    }

    coinTypes.push(String(coinType));
    addrs.push(addr);
    set.push(label);
  }

  if (coinTypes.length === 0) {
    return { set, skipped };
  }

  // Use set-record to batch all addresses in one transaction
  try {
    const args = [
      'set-record', opts.name,
      '--chain', idCliChain,
      '--output', 'json',
    ];

    // Add each coinType=address pair
    for (let i = 0; i < coinTypes.length; i++) {
      args.push('--addr', `${coinTypes[i]}=${addrs[i]}`);
    }

    await execFileAsync('id-cli', args, {
      encoding: 'utf8',
      env,
      timeout: 120000,
    });

    console.log(`[ID Chain] Set ${set.length} addresses in one transaction: ${set.join(', ')}`);
  } catch (err: any) {
    const stderr = err.stderr || err.stdout || '';
    console.warn(`[ID Chain] Failed to set addresses: ${err.message}`);
    if (stderr) console.warn(`[ID Chain] stderr: ${stderr.slice(0, 500)}`);
    // Fall back to individual calls if batch fails
    set.length = 0;
    skipped.push('batch-failed');
  }

  return { set, skipped };
}

#!/usr/bin/env node
/**
 * Check ENS resolution for xid.eth names via CCIP-Read.
 *
 * Usage: node scripts/check-ens-resolution.mjs [name1] [name2] ...
 * Default: checks alice.agent-23.xid.eth and bob.agent-24.xid.eth
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

const RPC = process.env.MAINNET_RPC_URL || 'https://eth.llamarpc.com';

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC),
});

const defaults = [
  'alice.agent-23.xid.eth',
  'bob.agent-24.xid.eth',
  'agent-23.xid.eth',
  'agent-24.xid.eth',
];

const names = process.argv.length > 2 ? process.argv.slice(2) : defaults;

console.log(`Resolving ${names.length} names via ${RPC.replace(/\/v2\/.*/, '/v2/...')}\n`);

for (const name of names) {
  try {
    const addr = await client.getEnsAddress({ name: normalize(name) });
    console.log(addr ? '✅' : '❌', `${name} → ${addr || 'null'}`);
  } catch (e) {
    console.log('❌', `${name} → ERROR: ${e.message?.substring(0, 120)}`);
  }
}

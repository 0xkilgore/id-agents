// SPDX-License-Identifier: MIT
/**
 * OWS Signer for XMTP
 *
 * Creates an XMTP-compatible Signer backed by an OWS wallet.
 * The private key never leaves the OWS vault — all signing is
 * delegated to the OWS CLI.
 */

import { execFileSync } from 'child_process';
import { createIdentifier } from '@xmtp/agent-sdk';
import type { Signer } from '@xmtp/node-sdk';

/**
 * Create an XMTP Signer backed by an OWS wallet.
 *
 * @param walletName - OWS wallet name (e.g., "xmtp-test-alice")
 * @returns XMTP Signer that delegates signing to OWS
 */
export function createOwsSigner(walletName: string): { signer: Signer; address: string } {
  // Get the EVM address from OWS
  const address = getOwsAddress(walletName);
  if (!address) {
    throw new Error(`Could not get EVM address for OWS wallet "${walletName}"`);
  }

  const signer: Signer = {
    type: 'EOA',

    getIdentifier: () => createIdentifier({
      key: `0x${'00'.repeat(32)}` as `0x${string}`, // dummy key — not used, OWS signs
      account: { address: address.toLowerCase() as `0x${string}` } as any,
      wallet: {} as any,
    }),

    signMessage: async (message: string): Promise<Uint8Array> => {
      // Delegate signing to OWS CLI
      const sig = execFileSync('ows', [
        'sign', 'message',
        '--wallet', walletName,
        '--chain', 'eip155:1',
        '--message', message,
      ], {
        encoding: 'utf8',
        timeout: 30000,
      }).trim();

      // OWS returns hex signature (0x-prefixed), convert to Uint8Array
      const hex = sig.startsWith('0x') ? sig.slice(2) : sig;
      return Uint8Array.from(Buffer.from(hex, 'hex'));
    },
  };

  return { signer, address };
}

/**
 * Get the EVM address from an OWS wallet.
 */
function getOwsAddress(walletName: string): string | null {
  try {
    const output = execFileSync('ows', ['wallet', 'list'], {
      encoding: 'utf8',
      timeout: 10000,
    });

    // Parse the wallet list to find the EVM address for this wallet
    const lines = output.split('\n');
    let inWallet = false;

    for (const line of lines) {
      if (line.includes(`Name:`) && line.includes(walletName)) {
        inWallet = true;
        continue;
      }
      if (inWallet && line.includes('eip155:1')) {
        // Extract address: "  eip155:1 (ethereum) → 0xABC..."
        const match = line.match(/(0x[a-fA-F0-9]{40})/);
        if (match) return match[1];
      }
      // Stop at next wallet
      if (inWallet && line.includes('Name:') && !line.includes(walletName)) {
        break;
      }
    }

    return null;
  } catch (err: any) {
    console.error(`[OWS] Failed to get address for "${walletName}": ${err.message}`);
    return null;
  }
}

// SPDX-License-Identifier: MIT
/**
 * ERC-7930 Interoperable Address utilities
 *
 * Encodes and decodes chain-specific addresses per ERC-7930 specification.
 * Format: Version (2) + ChainType (2) + ChainRefLen (1) + ChainRef (var) + AddrLen (1) + Addr (var)
 */

export interface ERC7930Address {
  version: number;
  chainType: number;
  chainId: number;
  address: string; // 0x-prefixed lowercase hex
}

const VERSION_V1 = 0x0001;
const CHAIN_TYPE_EVM = 0x0000;

/**
 * Encode a chain ID and address into ERC-7930 format
 */
export function encodeERC7930(chainId: number, address: string): string {
  // Normalize address
  const addr = address.toLowerCase().replace(/^0x/, '');
  if (addr.length !== 40) {
    throw new Error('Address must be 20 bytes (40 hex chars)');
  }

  // Encode chain ID as minimal bytes
  const chainIdBytes = encodeChainId(chainId);

  // Build the binary structure
  const parts: string[] = [];

  // Version (2 bytes)
  parts.push(uint16ToHex(VERSION_V1));

  // ChainType (2 bytes) - EVM = 0x0000
  parts.push(uint16ToHex(CHAIN_TYPE_EVM));

  // ChainReferenceLength (1 byte)
  parts.push(uint8ToHex(chainIdBytes.length / 2));

  // ChainReference (variable)
  parts.push(chainIdBytes);

  // AddressLength (1 byte) - always 20 for EVM
  parts.push(uint8ToHex(20));

  // Address (20 bytes)
  parts.push(addr);

  return '0x' + parts.join('');
}

/**
 * Decode an ERC-7930 address into its components
 */
export function decodeERC7930(encoded: string): ERC7930Address {
  const hex = encoded.toLowerCase().replace(/^0x/, '');

  if (hex.length < 12) {
    throw new Error('ERC-7930 address too short');
  }

  let offset = 0;

  // Version (2 bytes)
  const version = parseInt(hex.slice(offset, offset + 4), 16);
  offset += 4;

  if (version !== VERSION_V1) {
    throw new Error(`Unsupported ERC-7930 version: ${version}`);
  }

  // ChainType (2 bytes)
  const chainType = parseInt(hex.slice(offset, offset + 4), 16);
  offset += 4;

  if (chainType !== CHAIN_TYPE_EVM) {
    throw new Error(`Unsupported chain type: ${chainType} (only EVM supported)`);
  }

  // ChainReferenceLength (1 byte)
  const chainRefLen = parseInt(hex.slice(offset, offset + 2), 16);
  offset += 2;

  // ChainReference (variable)
  const chainRefHex = hex.slice(offset, offset + chainRefLen * 2);
  offset += chainRefLen * 2;

  const chainId = chainRefLen > 0 ? parseInt(chainRefHex, 16) : 0;

  // AddressLength (1 byte)
  const addrLen = parseInt(hex.slice(offset, offset + 2), 16);
  offset += 2;

  if (addrLen !== 20) {
    throw new Error(`Invalid EVM address length: ${addrLen}`);
  }

  // Address (20 bytes)
  const address = '0x' + hex.slice(offset, offset + 40);

  return { version, chainType, chainId, address };
}

/**
 * Check if a string is a valid ERC-7930 address
 */
export function isERC7930(value: string): boolean {
  try {
    decodeERC7930(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format ERC-7930 address for short display
 * Example: "84532:0xabcd...ef12"
 */
export function formatERC7930Short(encoded: string): string {
  try {
    const { chainId, address } = decodeERC7930(encoded);
    const shortAddr = address.slice(0, 6) + '...' + address.slice(-4);
    return `${chainId}:${shortAddr}`;
  } catch {
    return encoded.slice(0, 10) + '...';
  }
}

/**
 * Encode chain ID as minimal big-endian bytes
 */
function encodeChainId(chainId: number): string {
  if (chainId === 0) {
    return '00';
  }

  let hex = chainId.toString(16);
  // Ensure even length
  if (hex.length % 2 !== 0) {
    hex = '0' + hex;
  }
  return hex;
}

function uint16ToHex(n: number): string {
  return n.toString(16).padStart(4, '0');
}

function uint8ToHex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

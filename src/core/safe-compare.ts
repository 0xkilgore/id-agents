// SPDX-License-Identifier: MIT
/**
 * Timing-safe string comparison for API keys and secrets.
 * Prevents timing attacks by using constant-time comparison.
 */

import crypto from 'crypto';

/**
 * Compare two strings in constant time to prevent timing attacks.
 * Returns false if either value is falsy.
 */
export function safeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  // Normalize lengths to prevent length-leaking via timingSafeEqual's equal-length requirement
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self so we still spend constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

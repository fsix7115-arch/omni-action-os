/**
 * Tamper-evident journal chain.
 *
 * Every entry hashes the previous entry's hash:
 *
 *     hash(n) = SHA-256( hash(n-1) + canonicalJSON(payload(n)) )
 *
 * The genesis previousHash is 64 zeroes. Because each link embeds the last,
 * editing or deleting a historical row invalidates every row after it — which
 * is the point. A plain append-only log without a hash chain can be quietly
 * edited; this one cannot.
 *
 * Canonicalisation matters more than it looks. Two runs must produce identical
 * hashes for identical logical content, so keys are sorted recursively and
 * undefined values are dropped before hashing.
 */

import { createHash } from 'node:crypto';
import type { ChainVerification, JournalEntry } from './types';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Stable JSON: sorted keys, no undefined, arrays keep their order.
 * Array order is significant; object key order is not.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    // undefined would be dropped by JSON.stringify anyway; normalise it to
    // null here so nested values behave predictably.
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue; // undefined properties are not content
    out[key] = sortValue(v);
  }
  return out;
}

export function hashEntry(previousHash: string, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash + canonicalize(payload))
    .digest('hex');
}

export interface AppendInput {
  timestamp: string;
  principal: string;
  type: JournalEntry['type'];
  payload: Record<string, unknown>;
}

/**
 * Append one entry to a chain. Pure: returns a new array, never mutates.
 */
export function appendEntry(chain: JournalEntry[], input: AppendInput): JournalEntry[] {
  const previousHash = chain.length === 0 ? GENESIS_HASH : chain[chain.length - 1].hash;
  const seq = chain.length === 0 ? 1 : chain[chain.length - 1].seq + 1;

  const fullPayload = {
    seq,
    timestamp: input.timestamp,
    principal: input.principal,
    type: input.type,
    payload: input.payload,
  };

  const entry: JournalEntry = {
    seq,
    timestamp: input.timestamp,
    principal: input.principal,
    type: input.type,
    previousHash,
    hash: hashEntry(previousHash, fullPayload),
    payload: input.payload,
  };

  return [...chain, entry];
}

/**
 * Verify a chain end to end.
 *
 * Checks three separate things, and says which one failed:
 *  - sequence numbers are contiguous
 *  - each previousHash matches the prior entry's hash
 *  - each hash recomputes to the stored value
 */
export function verifyChain(chain: JournalEntry[]): ChainVerification {
  if (chain.length === 0) {
    return { valid: true, entriesChecked: 0 };
  }

  let expectedPrevious = GENESIS_HASH;
  let expectedSeq = 1;

  for (const entry of chain) {
    if (entry.seq !== expectedSeq) {
      return {
        valid: false,
        entriesChecked: entry.seq,
        brokenAt: entry.seq,
        reason: `sequence gap: expected ${expectedSeq}, found ${entry.seq}`,
      };
    }
    if (entry.previousHash !== expectedPrevious) {
      return {
        valid: false,
        entriesChecked: entry.seq,
        brokenAt: entry.seq,
        reason: `previousHash does not match the prior entry's hash at seq ${entry.seq}`,
      };
    }

    const recomputed = hashEntry(entry.previousHash, {
      seq: entry.seq,
      timestamp: entry.timestamp,
      principal: entry.principal,
      type: entry.type,
      payload: entry.payload,
    });
    if (recomputed !== entry.hash) {
      return {
        valid: false,
        entriesChecked: entry.seq,
        brokenAt: entry.seq,
        reason: `payload does not hash to the stored value at seq ${entry.seq} — entry was altered`,
      };
    }

    expectedPrevious = entry.hash;
    expectedSeq = entry.seq + 1;
  }

  return { valid: true, entriesChecked: chain.length };
}

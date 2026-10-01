/**
 * Core domain types for OmniAction OS.
 *
 * The whole system exists to answer one question honestly: did the thing you
 * asked for actually happen? These types are shaped around that.
 *
 * Two distinctions run through everything here and are easy to lose:
 *
 *   1. `claimed` vs `verified`. An action that returns 200 has *claimed* to
 *      succeed. A verifier has to read back external state to *verify* it.
 *      We store them as separate fields and never let one imply the other.
 *
 *   2. a permission being *granted* vs *exercised*. The permission capsule is
 *      the grant; an invocation is one exercise of it. Both are journaled.
 */

// ---------------------------------------------------------------------------
// Capability graph
// ---------------------------------------------------------------------------

/**
 * How a capability is obtained. This is a machine-readable field, not a label
 * — "free" and "self-hosted" are very different promises and a UI must never
 * render a paid vendor as free.
 */
export type PricingMode = 'free' | 'self-hosted' | 'byo' | 'paid' | 'unknown';

export type CapabilityId = string;

export interface Capability {
  id: CapabilityId;
  /** Machine name used in plans and permissions, e.g. "gmail.send". */
  name: string;
  /** Human sentence: "Send an email from your own Gmail account". */
  description: string;
  /** One of: read | write | delete | send | financial | admin. */
  effect: CapabilityEffect;
  /** Does this change state we cannot get back without a compensation step? */
  destructive: boolean;
  pricing: PricingMode;
  /**
   * Whether the operation can be rolled back, and how. Operations with no
   * compensation are the ones that must be gated hardest — an uncompensable
   * delete is exactly what a dry-run preview is for.
   */
  compensation?: 'full' | 'partial' | 'none';
  /** Connector that provides this capability, e.g. "gmail". */
  connector: string;
}

export type CapabilityEffect = 'read' | 'write' | 'delete' | 'send' | 'financial' | 'admin';

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type Scope = 'once' | 'session' | 'always';

export interface Permission {
  capability: CapabilityId;
  scope: Scope;
  /** Argument patterns the grant is limited to, if any. */
  argumentFilters?: Record<string, string>;
  grantedAt: string;
  /** Set when scope is session/always and the grant has been withdrawn. */
  revokedAt?: string;
  /** Why the grant was made — surfaced verbatim in the audit journal. */
  justification: string;
}

export interface PermissionCapsule {
  id: string;
  principal: string;
  permissions: Permission[];
  createdAt: string;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  /** Natural language, shown in the preview verbatim. */
  description: string;
  capability: CapabilityId;
  inputs: Record<string, unknown>;
  /**
   * Destructive or uncompensable steps are what a dry-run exists for. The UI
   * must call these out; we do not let them blend into a flat list.
   */
  risk: StepRisk;
  dependsOn?: string[];
  compensation?: CompensationStep;
}

export interface StepRisk {
  effect: CapabilityEffect;
  destructive: boolean;
  /** 'none' | 'partial' | 'full' — absent means no rollback is possible. */
  compensable: 'none' | 'partial' | 'full';
  /** Short sentence explaining the concrete consequence, e.g. "Sends mail to 40 external addresses. Cannot be unsent." */
  rationale: string;
}

export interface CompensationStep {
  description: string;
  capability: CapabilityId;
  inputs: Record<string, unknown>;
  /** True only when the compensation is guaranteed to restore prior state. */
  guaranteed: boolean;
}

export interface Plan {
  id: string;
  objective: string;
  steps: PlanStep[];
  /** Total non-compensable steps. The UI refuses to auto-approve above zero. */
  riskSummary: { steps: number; uncompensable: number; destructive: number };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'rolled_back';

export interface StepResult {
  stepId: string;
  status: StepStatus;
  /** What the provider said happened. */
  claimed: string | null;
  /** What the verifier independently observed. Null until a verifier runs. */
  verified: boolean | null;
  /** How verification was established, for the journal. */
  verificationMethod?: string;
  /** Inputs actually used, after provider normalisation. */
  resolvedInputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ExecutionResult {
  executionId: string;
  planId: string;
  status: 'succeeded' | 'failed' | 'partially_failed' | 'blocked';
  steps: StepResult[];
  startedAt: string;
  finishedAt: string;
  /**
   * True only if every step both claimed and verified success. A run where
   * claims are unverified is reported as such rather than as success.
   */
  fullyVerified: boolean;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * A journal entry is tamper-evident: each one hashes the previous entry's
 * hash, so altering a historical row breaks verification for every row after
 * it. This is what makes the audit trail worth anything.
 */
export interface JournalEntry {
  seq: number;
  timestamp: string;
  principal: string;
  type: 'intent' | 'plan' | 'permission' | 'execution' | 'verification';
  /** Stable hash of the previous entry; genesis is 64 zeroes. */
  previousHash: string;
  /** SHA-256 over (previousHash + canonical payload). */
  hash: string;
  payload: Record<string, unknown>;
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  /** First sequence number where the chain broke, if it did. */
  brokenAt?: number;
  reason?: string;
}

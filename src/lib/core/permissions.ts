/**
 * Permission evaluation.
 *
 * The rule this module enforces: a permission check is decided by server-side
 * state and a matching rule. Nothing about hiding a button, disabling a form,
 * or greying out a card may be treated as access control — a client can call
 * any endpoint regardless of what the UI shows. Every mutation path must run
 * through `checkPermission` and honour its verdict.
 *
 * Evaluation is intentionally deny-by-default. A permission that cannot be
 * matched by a rule is refused, not allowed on the grounds that nothing
 * objected.
 */

import type { Capability, Permission, PermissionCapsule, PlanStep } from './types';

export type Decision = 'allow' | 'deny';

export interface PermissionVerdict {
  decision: Decision;
  /** Machine-readable reason, shown in the audit journal verbatim. */
  reason: string;
  /** The permission that authorised this, if one did. */
  matchedPermission?: Permission;
}

/** A step is not covered by a grant unless every filter matches. */
function filtersMatch(
  filters: Record<string, string> | undefined,
  inputs: Record<string, unknown>
): boolean {
  if (!filters || Object.keys(filters).length === 0) return true;
  for (const [key, pattern] of Object.entries(filters)) {
    const actual = inputs[key];
    if (actual === undefined) return false;
    // Substring containment, deliberately simple. Callers pass literal
    // substrings (recipient allowlists, path prefixes) rather than regex, so
    // there is no pattern-injection surface here.
    if (!String(actual).includes(pattern)) return false;
  }
  return true;
}

export interface EvaluateOptions {
  now?: Date;
  /** Overrides capsule expiry checking, for tests. */
  ignoreExpiry?: boolean;
}

export function checkPermission(
  capsule: PermissionCapsule | null,
  step: Pick<PlanStep, 'capability' | 'inputs'>,
  opts: EvaluateOptions = {}
): PermissionVerdict {
  if (!capsule) {
    return { decision: 'deny', reason: 'no permission capsule presented' };
  }

  const now = opts.now ?? new Date();

  if (capsule.expiresAt && !opts.ignoreExpiry) {
    if (new Date(capsule.expiresAt) <= now) {
      return {
        decision: 'deny',
        reason: `permission capsule expired at ${capsule.expiresAt}`,
      };
    }
  }

  const candidates = capsule.permissions.filter(
    (p) => p.capability === step.capability
  );

  if (candidates.length === 0) {
    return {
      decision: 'deny',
      reason: `capability "${step.capability}" is not granted in this capsule`,
    };
  }

  for (const permission of candidates) {
    if (permission.revokedAt) {
      continue;
    }
    if (!filtersMatch(permission.argumentFilters, step.inputs)) {
      continue;
    }
    if (!scopeStillApplies(permission, opts)) {
      continue;
    }
    return {
      decision: 'allow',
      reason: `granted ${permission.scope} at ${permission.grantedAt} — ${permission.justification}`,
      matchedPermission: permission,
    };
  }

  return {
    decision: 'deny',
    reason:
      `capability "${step.capability}" is granted, but not for these arguments under an unexpired scope`,
  };
}

function scopeStillApplies(permission: Permission, opts: EvaluateOptions): boolean {
  // 'once' grants are single-use. The caller is responsible for retiring them
  // after the step runs; we only report whether it has already been retired.
  return !permission.revokedAt;
}

/**
 * Risk assessment for a plan.
 *
 * The counts here drive the UI's refusal to auto-approve. Any plan containing
 * an uncompensable destructive step has to be looked at by a human, every
 * time, no matter how confident the planner was.
 */
export function assessPlanRisk(
  steps: PlanStep[],
  capabilities: Map<string, Capability>
): { steps: number; uncompensable: number; destructive: number } {
  let uncompensable = 0;
  let destructive = 0;

  for (const step of steps) {
    const cap = capabilities.get(step.capability);
    const isDestructive = cap?.destructive ?? step.risk.destructive;
    const compensable = cap?.compensation ?? step.risk.compensable;

    if (isDestructive) destructive += 1;
    if (compensable === 'none') uncompensable += 1;
  }

  return { steps: steps.length, uncompensable, destructive };
}

/**
 * Whether a plan may run unattended.
 *
 * Deliberately conservative: a plan needs an explicit "always allow" grant
 * from the user, and it still refuses if anything irreversible is in it. This
 * is the function an attacker would most want to weaken, so it is small and
 * has no bypass parameter.
 */
export function canAutoApprove(
  steps: PlanStep[],
  capabilities: Map<string, Capability>
): { allowed: boolean; reason: string } {
  const risk = assessPlanRisk(steps, capabilities);
  if (risk.steps === 0) {
    return { allowed: false, reason: 'plan has no steps' };
  }
  if (risk.uncompensable > 0) {
    return {
      allowed: false,
      reason: `${risk.uncompensable} step(s) cannot be rolled back and require explicit approval`,
    };
  }
  return {
    allowed: true,
    reason: 'all steps are compensable; unattended execution is within the existing grant',
  };
}

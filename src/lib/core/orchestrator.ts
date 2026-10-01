/**
 * The vertical slice, end to end.
 *
 *   connect → ask → plan (dry-run) → approve → execute → verify → journal
 *
 * Every step is explicit and every transition is recorded. Two properties are
 * enforced here rather than left to callers:
 *
 *  - a step cannot execute without a matching, unexpired permission;
 *  - a step's `verified` flag is only ever set by a verifier that read back
 *    external state, never by the execute call's own return value.
 *
 * The orchestrator is written against interfaces, so the whole slice runs
 * headless in tests with no network and no UI.
 */

import { randomUUID } from 'node:crypto';
import { appendEntry, verifyChain } from './journal';
import { checkPermission, type PermissionVerdict } from './permissions';
import {
  assertOperationAvailable,
  capabilityGraph,
  type Connector,
  type Operation,
} from '../connectors/sdk';
import {
  applyVerification,
  summarise,
  type Verifier,
  type Verdict,
} from './verify';
import type {
  Capability,
  ChainVerification,
  ExecutionResult,
  JournalEntry,
  Permission,
  PermissionCapsule,
  Plan,
  PlanStep,
  StepResult,
} from './types';

export interface RequestedStep {
  /** Connector operation id, e.g. "fs.write". */
  operation: string;
  connectorId: string;
  inputs: Record<string, unknown>;
  /**
   * Verifier for this step. Required for every step — an operation with no
   * declared verifier is a design error, not a step to skip silently.
   */
  verifier: Verifier;
}

export interface PlanRequest {
  objective: string;
  principal: string;
  steps: RequestedStep[];
}

export interface ExecutionRequest {
  plan: Plan;
  principal: string;
  capsule: PermissionCapsule | null;
  /** Connects the plan steps to their connector operations at run time. */
  connectors: Connector[];
  /** Read-back functions, keyed by step id. */
  readBack: Record<string, (inputs: Record<string, unknown>) => Promise<Record<string, unknown>>>;
  /** Injected so tests are deterministic. */
  now?: () => Date;
}

function buildStepRisk(capability: Capability, rationale: string) {
  return {
    effect: capability.effect,
    destructive: capability.destructive,
    compensable: capability.compensation ?? ('none' as const),
    rationale,
  };
}

/**
 * Compile an objective into a plan, running every operation's dry run first.
 *
 * Dry run happens here rather than at execute time on purpose: the plan preview
 * is what the user approves, so a step that cannot describe itself in advance
 * should not reach the approval screen.
 */
export async function planObjectiveAsync(
  request: PlanRequest,
  connectors: Connector[]
): Promise<Plan> {
  const graph = capabilityGraph();
  const now = new Date();
  const steps: PlanStep[] = [];

  for (const [i, requested] of request.steps.entries()) {
    const connector = connectors.find((c) => c.id === requested.connectorId);
    if (!connector) throw new Error(`unknown connector "${requested.connectorId}"`);

    const op = assertOperationAvailable(connector, requested.operation);
    const capability = graph.get(op.capability);
    if (!capability) {
      throw new Error(`operation "${op.id}" references unknown capability "${op.capability}"`);
    }

    const id = `step-${i + 1}`;
    let rationale: string;

    if (op.supportsDryRun && op.dryRun) {
      const dry = await op.dryRun(requested.inputs);
      rationale =
        dry.irreversible.length > 0
          ? `${dry.wouldDo}. Irreversible: ${dry.irreversible.join('; ')}`
          : `${dry.wouldDo}. Fully reversible.`;
    } else {
      rationale = `${op.description}. This operation does not support a dry run, so its effect cannot be previewed before approval.`;
    }

    steps.push({
      id,
      description: op.description,
      capability: op.capability,
      inputs: requested.inputs,
      risk: buildStepRisk(capability, rationale),
    });
  }

  return {
    id: randomUUID(),
    objective: request.objective,
    steps,
    riskSummary: {
      steps: steps.length,
      uncompensable: steps.filter((s) => s.risk.compensable === 'none').length,
      destructive: steps.filter((s) => s.risk.destructive).length,
    },
    createdAt: now.toISOString(),
  };
}

/** Build a capsule granting a single capability, with a stated justification. */
export function grant(
  principal: string,
  capability: string,
  justification: string,
  opts: { scope?: Permission['scope']; filters?: Record<string, string> } = {}
): PermissionCapsule {
  const now = new Date();
  return {
    id: randomUUID(),
    principal,
    permissions: [
      {
        capability,
        scope: opts.scope ?? 'once',
        argumentFilters: opts.filters,
        grantedAt: now.toISOString(),
        justification,
      },
    ],
    createdAt: now.toISOString(),
  };
}

/**
 * Execute a plan, enforcing permissions and verifying every step.
 */
export async function executePlan(
  request: ExecutionRequest,
  journal: JournalEntry[] = []
): Promise<{ result: ExecutionResult; journal: JournalEntry[] }> {
  const now = request.now ?? (() => new Date());
  const startedAt = now();
  let chain = journal;

  chain = appendEntry(chain, {
    timestamp: startedAt.toISOString(),
    principal: request.principal,
    type: 'execution',
    payload: { planId: request.plan.id, objective: request.plan.objective, steps: request.plan.steps.length },
  });

  const results: StepResult[] = [];

  for (const step of request.plan.steps) {
    // 1. Permission gate. Server-side, deny by default, before any I/O.
    const verdict: PermissionVerdict = checkPermission(request.capsule, step, { now: startedAt });
    chain = appendEntry(chain, {
      timestamp: now().toISOString(),
      principal: request.principal,
      type: 'permission',
      payload: {
        stepId: step.id,
        capability: step.capability,
        decision: verdict.decision,
        reason: verdict.reason,
      },
    });

    if (verdict.decision === 'deny') {
      results.push({
        stepId: step.id,
        status: 'blocked',
        claimed: null,
        verified: false,
        resolvedInputs: step.inputs,
        error: verdict.reason,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
      });
      continue;
    }

    // 2. Execute.
    const stepStart = now();
    const connector = request.connectors.find((c) =>
      c.operations.some((o) => o.id === step.capability)
    );
    if (!connector) {
      results.push({
        stepId: step.id,
        status: 'failed',
        claimed: null,
        verified: false,
        resolvedInputs: step.inputs,
        error: `no connector provides capability "${step.capability}"`,
        startedAt: stepStart.toISOString(),
        finishedAt: now().toISOString(),
      });
      continue;
    }

    const operation = connector.operations.find((o) => o.id === step.capability)!;
    let stepResult: StepResult;
    try {
      const outputs = await operation.execute(step.inputs);
      const finished = now();
      stepResult = {
        stepId: step.id,
        status: 'succeeded',
        claimed: outputs ? JSON.stringify(outputs) : 'completed',
        // Explicitly null: the provider has claimed success, nothing is
        // verified yet. The verifier below is the only thing that may fill
        // this in.
        verified: null,
        resolvedInputs: step.inputs,
        outputs,
        startedAt: stepStart.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - stepStart.getTime(),
      };
    } catch (e) {
      const finished = now();
      stepResult = {
        stepId: step.id,
        status: 'failed',
        claimed: null,
        verified: false,
        resolvedInputs: step.inputs,
        error: e instanceof Error ? e.message : String(e),
        startedAt: stepStart.toISOString(),
        finishedAt: finished.toISOString(),
      };
    }

    // 3. Verify, only for steps that actually ran.
    if (stepResult.status === 'succeeded') {
      const readBack = request.readBack[step.id];
      if (!readBack) {
        // No verifier means we cannot confirm anything. That is reported, not
        // assumed away.
        stepResult = {
          ...stepResult,
          verified: false,
          verificationMethod: 'none: no read-back was registered for this step',
        };
      } else {
        const graph = capabilityGraph();
        const capability = graph.get(step.capability)!;
        const verifier = findVerifier(request.plan, step, capability);
        if (!verifier) {
          stepResult = { ...stepResult, verified: false, verificationMethod: 'none: no verifier declared' };
        } else {
          const outcome = await verifier.verify({
            claimed: stepResult.outputs ?? null,
            inputs: step.inputs,
            capability,
            readBack,
          });
          stepResult = applyVerification(stepResult, outcome);
          chain = appendEntry(chain, {
            timestamp: now().toISOString(),
            principal: request.principal,
            type: 'verification',
            payload: {
              stepId: step.id,
              verdict: outcome.verdict satisfies Verdict,
              method: outcome.method,
              detail: outcome.detail,
            },
          });
        }
      }
    }

    results.push(stepResult);
  }

  const roll = summarise(results);
  const finishedAt = now();

  const status: ExecutionResult['status'] =
    results.some((r) => r.status === 'blocked')
      ? 'blocked'
      : roll.failed > 0 || roll.unverified > 0
        ? roll.failed > 0
          ? 'failed'
          : 'partially_failed'
        : 'succeeded';

  const result: ExecutionResult = {
    executionId: randomUUID(),
    planId: request.plan.id,
    status,
    steps: results,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    fullyVerified: roll.fullyVerified,
  };

  chain = appendEntry(chain, {
    timestamp: finishedAt.toISOString(),
    principal: request.principal,
    type: 'verification',
    payload: {
      executionId: result.executionId,
      status,
      fullyVerified: roll.fullyVerified,
      summary: roll.summary,
    },
  });

  return { result, journal: chain };
}

/**
 * Verifiers are carried on the plan's originating request, not the plan
 * itself, because a Plan is a document a human reads and a verifier is
 * executable code. Attaching the pair by step id keeps them in sync.
 */
const verifierRegistry = new WeakMap<Plan, Map<string, Verifier>>();

export function attachVerifiers(plan: Plan, steps: RequestedStep[]): Plan {
  const map = new Map<string, Verifier>();
  steps.forEach((s, i) => map.set(`step-${i + 1}`, s.verifier));
  verifierRegistry.set(plan, map);
  return plan;
}

function findVerifier(plan: Plan, step: PlanStep, _capability: Capability): Verifier | undefined {
  return verifierRegistry.get(plan)?.get(step.id);
}

export function verifyJournal(chain: JournalEntry[]): ChainVerification {
  return verifyChain(chain);
}

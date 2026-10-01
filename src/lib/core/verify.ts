/**
 * Verification: the step most action platforms skip, and the reason this
 * project exists.
 *
 * A provider returning 200 is a *claim*. "The message is in the Sent folder"
 * is *evidence*. We keep those two facts separate all the way through the
 * system, and this module is what turns one into the other.
 *
 * A verifier is a read-back: it re-reads external state through an independent
 * path and decides whether the claimed effect actually occurred. It is
 * deliberately allowed to say "I could not check", and that is reported as
 * unverified rather than as failure or success.
 *
 * The most common wrong implementation is a verifier that echoes the
 * provider's own response. `RejectsInBandVerifier` below documents that trap
 * and refuses to be used for a destructive step, because agreeing with the
 * thing you are auditing is not auditing.
 */

import type { Capability, StepResult } from './types';

export type Verdict = 'verified' | 'failed' | 'unverified';

export interface VerifyInput {
  /** What the provider claimed happened. */
  claimed: Record<string, unknown> | null;
  /** Inputs the step ran with, needed to locate the effect afterwards. */
  inputs: Record<string, unknown>;
  capability: Capability;
  /** Re-read external state. Should throw on a real read failure. */
  readBack: (inputs: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface VerifyOutcome {
  verdict: Verdict;
  /** How this was established, recorded in the journal. */
  method: string;
  detail: string;
}

export interface Verifier {
  name: string;
  verify(input: VerifyInput): Promise<VerifyOutcome>;
}

/**
 * Read back by matching a unique marker the step left in the external system.
 *
 * `markerField` names the field to match on, `markerValue` the value we expect
 * to find. This is the honest form of verification: an independent read of the
 * target system, not a re-read of the provider's response.
 */
export class MarkerReadBackVerifier implements Verifier {
  constructor(
    readonly name: string,
    private readonly markerField: string,
    private readonly markerValue: string
  ) {}

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    let observed: Record<string, unknown>;
    try {
      observed = await input.readBack(input.inputs);
    } catch (e) {
      return {
        verdict: 'unverified',
        method: this.name,
        detail: `read-back failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const found = observed[this.markerField];
    if (found === this.markerValue) {
      return {
        verdict: 'verified',
        method: this.name,
        detail: `confirmed ${this.markerField}="${this.markerValue}" by reading back external state`,
      };
    }

    if (found === undefined) {
      return {
        verdict: 'unverified',
        method: this.name,
        detail: `read-back returned no ${this.markerField}; cannot confirm the effect`,
      };
    }

    return {
      verdict: 'failed',
      method: this.name,
      detail: `read-back found ${this.markerField}="${String(found)}", expected "${this.markerValue}"`,
    };
  }
}

/**
 * Confirms an object exists and is in the expected state. Used for writes that
 * can be fetched by id.
 */
export class ExistsVerifier implements Verifier {
  constructor(
    readonly name: string,
    private readonly idField: string
  ) {}

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    try {
      const observed = await input.readBack(input.inputs);
      const id = observed[this.idField];
      if (id === undefined || id === null) {
        return {
          verdict: 'failed',
          method: this.name,
          detail: `object not found when read back by ${this.idField}`,
        };
      }
      return {
        verdict: 'verified',
        method: this.name,
        detail: `object exists with ${this.idField}="${String(id)}"`,
      };
    } catch (e) {
      return {
        verdict: 'unverified',
        method: this.name,
        detail: `could not read back: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

/**
 * Demonstrates the trap this project exists to avoid.
 *
 * This verifier compares the provider's claim against itself. It is here so
 * the anti-pattern is named and testable — `assertNotUsableForDestructive`
 * below will refuse to let it verify anything irreversible, because agreeing
 * with the thing you are auditing proves nothing.
 */
export class RejectsInBandVerifier implements Verifier {
  name = 'in-band-confirmation';

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    if (input.capability.destructive) {
      return {
        verdict: 'unverified',
        method: this.name,
        detail:
          'refused: this verifier only re-reads the provider response, which cannot verify a destructive effect',
      };
    }
    return {
      verdict: 'verified',
      method: this.name,
      detail: 'provider response echoed; acceptable only for non-destructive reads',
    };
  }
}

export function assertNotUsableForDestructive(
  verifier: Verifier,
  capability: Capability
): void {
  if (verifier instanceof RejectsInBandVerifier && capability.destructive) {
    throw new Error(
      `capability "${capability.name}" is destructive and cannot be verified with ${verifier.name}`
    );
  }
}

/**
 * Attach a verification result to a step result, preserving the distinction
 * between what was claimed and what was observed.
 */
export function applyVerification(
  step: StepResult,
  outcome: VerifyOutcome
): StepResult {
  return {
    ...step,
    // A failed claim never becomes verified, whatever the verifier says.
    verified: step.status === 'succeeded' ? outcome.verdict === 'verified' : false,
    verificationMethod: `${outcome.method}: ${outcome.detail}`,
  };
}

/**
 * Roll a run's results up into an honest overall status.
 *
 * The case that matters: steps that all returned 200 but could not be verified.
 * Reporting that as success is the failure mode we are built to avoid, so
 * `fullyVerified` is false and the status stays 'failed' with the unverified
 * steps named in the reason.
 */
export function summarise(results: StepResult[]): {
  fullyVerified: boolean;
  succeeded: number;
  failed: number;
  unverified: number;
  summary: string;
} {
  const succeeded = results.filter((r) => r.status === 'succeeded');
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'blocked');
  const unverified = succeeded.filter((r) => r.verified !== true);
  const fullyVerified = succeeded.length > 0 && unverified.length === 0 && failed.length === 0;

  let summary: string;
  if (results.length === 0) {
    summary = 'no steps ran';
  } else if (fullyVerified) {
    summary = `${succeeded.length} step(s) executed and independently verified`;
  } else if (failed.length > 0) {
    summary = `${failed.length} step(s) failed; ${unverified.length} succeeded but unverified`;
  } else {
    summary = `${succeeded.length} step(s) returned success but ${unverified.length} could not be independently verified — not counted as verified`;
  }

  return { fullyVerified, succeeded: succeeded.length, failed: failed.length, unverified: unverified.length, summary };
}

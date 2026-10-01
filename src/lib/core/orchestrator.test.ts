/**
 * The vertical slice test: connect → ask → plan → approve → execute → verify.
 *
 * These tests exercise the real filesystem connector against a real temp
 * directory. Nothing is mocked at the I/O boundary, because a mocked boundary
 * is exactly what would let a broken verifier pass.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capabilityGraph, localFilesystemConnector, registry } from '../connectors/sdk';
import { appendEntry, canonicalize, GENESIS_HASH, verifyChain } from './journal';
import { canAutoApprove, checkPermission } from './permissions';
import {
  attachVerifiers,
  executePlan,
  grant,
  planObjectiveAsync,
  type RequestedStep,
} from './orchestrator';
import { ExistsVerifier, MarkerReadBackVerifier, RejectsInBandVerifier } from './verify';
import type { JournalEntry, Plan } from './types';

// The connector is pinned to a fixed sandbox root; point that at a temp dir so
// tests never touch the repository.
let sandbox: string;
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'omni-test-'));
  process.env.OMNI_SANDBOX = sandbox;
});
afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('capability graph', () => {
  it('registers every declared capability', () => {
    const graph = capabilityGraph();
    expect(graph.has('fs.read')).toBe(true);
    expect(graph.has('fs.write')).toBe(true);
  });

  it('marks an overwriting write as destructive and uncompensable', () => {
    const write = capabilityGraph().get('fs.write')!;
    expect(write.destructive).toBe(true);
    expect(write.compensation).toBe('none');
  });

  it('reports pricing as a machine-readable field', () => {
    for (const cap of capabilityGraph().values()) {
      expect(['free', 'self-hosted', 'byo', 'paid', 'unknown']).toContain(cap.pricing);
    }
  });

  it('exposes exactly one registered connector', () => {
    expect(registry()).toHaveLength(1);
    expect(localFilesystemConnector.status).toBe('available');
  });
});

describe('sandbox confinement', () => {
  const conn = localFilesystemConnector;
  const op = (id: string) => conn.operations.find((o) => o.id === id)!;

  it('refuses a path that escapes the sandbox', async () => {
    await expect(op('fs.write').execute({ path: '../escape.txt', content: 'x' })).rejects.toThrow(
      /escapes the sandbox/
    );
  });

  it('refuses an absolute path', async () => {
    await expect(op('fs.read').execute({ path: '/etc/passwd' })).rejects.toThrow(/escapes the sandbox/);
  });

  it('refuses an empty path', async () => {
    await expect(op('fs.read').execute({ path: '' })).rejects.toThrow(/non-empty/);
  });
});

describe('dry run', () => {
  const op = localFilesystemConnector.operations.find((o) => o.id === 'fs.write')!;

  it('names the irreversible part of an overwrite', async () => {
    const dry = await op.dryRun!({ path: 'notes.md', content: 'hello' });
    expect(dry.irreversible).toHaveLength(1);
    expect(dry.irreversible[0]).toMatch(/discarded with no backup/);
  });

  it('creates nothing while dry running', async () => {
    await op.dryRun!({ path: 'dry-run-only.txt', content: 'x' });
    await expect(readFile(join(sandbox, 'dry-run-only.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('permission gate', () => {
  const step = { capability: 'fs.write', inputs: { path: 'a.txt', content: 'x' } };

  it('denies when no capsule is presented', () => {
    expect(checkPermission(null, step).decision).toBe('deny');
  });

  it('denies an ungranted capability', () => {
    const capsule = grant('me', 'fs.read', 'reading is fine');
    expect(checkPermission(capsule, step).decision).toBe('deny');
  });

  it('allows a granted capability', () => {
    const capsule = grant('me', 'fs.write', 'writing the note');
    expect(checkPermission(capsule, step).decision).toBe('allow');
  });

  it('denies when an argument filter does not match', () => {
    const capsule = grant('me', 'fs.write', 'only notes', { filters: { path: 'notes/' } });
    const verdict = checkPermission(capsule, { capability: 'fs.write', inputs: { path: 'secrets/a.txt' } });
    expect(verdict.decision).toBe('deny');
  });

  it('allows when the filter matches', () => {
    const capsule = grant('me', 'fs.write', 'only notes', { filters: { path: 'notes/' } });
    const verdict = checkPermission(capsule, { capability: 'fs.write', inputs: { path: 'notes/a.txt' } });
    expect(verdict.decision).toBe('allow');
  });

  it('denies a revoked permission', () => {
    const capsule = grant('me', 'fs.write', 'oops');
    capsule.permissions[0].revokedAt = new Date().toISOString();
    expect(checkPermission(capsule, step).decision).toBe('deny');
  });

  it('denies an expired capsule', () => {
    const capsule = grant('me', 'fs.write', 'temporary');
    capsule.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(checkPermission(capsule, step).decision).toBe('deny');
  });
});

describe('auto-approval', () => {
  it('refuses a plan containing an uncompensable step', () => {
    const plan = {
      id: 'p',
      objective: '',
      createdAt: '',
      riskSummary: { steps: 1, uncompensable: 1, destructive: 1 },
      steps: [
        {
          id: 's1',
          description: '',
          capability: 'fs.write',
          inputs: {},
          risk: { effect: 'write', destructive: true, compensable: 'none', rationale: '' },
        },
      ],
    } as Plan;
    expect(canAutoApprove(plan.steps, capabilityGraph()).allowed).toBe(false);
  });
});

describe('journal chain', () => {
  it('starts from the genesis hash', () => {
    const chain = appendEntry([], { timestamp: 't', principal: 'p', type: 'intent', payload: { a: 1 } });
    expect(chain[0].previousHash).toBe(GENESIS_HASH);
    expect(chain[0].seq).toBe(1);
  });

  it('links each entry to the previous hash', () => {
    let chain: JournalEntry[] = [];
    for (let i = 0; i < 4; i++) {
      chain = appendEntry(chain, { timestamp: 't', principal: 'p', type: 'intent', payload: { i } });
    }
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].previousHash).toBe(chain[i - 1].hash);
    }
    expect(verifyChain(chain).valid).toBe(true);
  });

  it('detects an altered payload', () => {
    let chain: JournalEntry[] = [];
    chain = appendEntry(chain, { timestamp: 't', principal: 'p', type: 'intent', payload: { amount: 10 } });
    chain = appendEntry(chain, { timestamp: 't', principal: 'p', type: 'intent', payload: { amount: 20 } });
    chain[0].payload = { amount: 999999 };
    const v = verifyChain(chain);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it('detects a deleted entry', () => {
    let chain: JournalEntry[] = [];
    for (let i = 0; i < 3; i++) {
      chain = appendEntry(chain, { timestamp: 't', principal: 'p', type: 'intent', payload: { i } });
    }
    chain.splice(1, 1);
    expect(verifyChain(chain).valid).toBe(false);
  });

  it('canonicalises key order so identical content hashes identically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe('the full vertical slice', () => {
  it('runs connect → plan → approve → execute → verify end to end', async () => {
    const steps: RequestedStep[] = [
      {
        operation: 'fs.write',
        connectorId: 'local-filesystem',
        inputs: { path: 'report.md', content: '# Verified\n\nThis file was written and read back.' },
        verifier: new ExistsVerifier('file-exists', 'path'),
      },
    ];

    const plan = await planObjectiveAsync(
      { objective: 'Write a verified report', principal: 'tester', steps },
      registry()
    );
    attachVerifiers(plan, steps);

    expect(plan.steps).toHaveLength(1);
    expect(plan.riskSummary.uncompensable).toBe(1);
    // The dry run must have described the irreversibility before approval.
    expect(plan.steps[0].risk.rationale).toMatch(/Irreversible/);

    const capsule = grant('tester', 'fs.write', 'writing the report for this test');

    const readBack: Record<string, (i: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
      'step-1': async (inputs) => {
        const content = await readFile(join(sandbox, String(inputs.path)), 'utf8');
        return { path: inputs.path, content, sha: content.length };
      },
    };

    const { result, journal } = await executePlan({
      plan,
      principal: 'tester',
      capsule,
      connectors: registry(),
      readBack,
    });

    // Executed for real.
    const written = await readFile(join(sandbox, 'report.md'), 'utf8');
    expect(written).toContain('read back');

    // And independently verified.
    expect(result.status).toBe('succeeded');
    expect(result.fullyVerified).toBe(true);
    expect(result.steps[0].verified).toBe(true);
    expect(result.steps[0].verificationMethod).toMatch(/file-exists/);

    // The journal records the whole run and is tamper-evident.
    expect(verifyChain(journal).valid).toBe(true);
    expect(journal.map((e) => e.type)).toContain('permission');
    expect(journal.map((e) => e.type)).toContain('verification');
  });

  it('blocks an unpermitted step and executes nothing', async () => {
    const steps: RequestedStep[] = [
      {
        operation: 'fs.write',
        connectorId: 'local-filesystem',
        inputs: { path: 'blocked.txt', content: 'nope' },
        verifier: new ExistsVerifier('file-exists', 'path'),
      },
    ];
    const plan = await planObjectiveAsync({ objective: 'unauthorised', principal: 'tester', steps }, registry());
    attachVerifiers(plan, steps);

    const { result } = await executePlan({
      plan,
      principal: 'tester',
      capsule: grant('tester', 'fs.read', 'read only'), // wrong capability
      connectors: registry(),
      readBack: {},
    });

    expect(result.status).toBe('blocked');
    expect(result.fullyVerified).toBe(false);
    expect(result.steps[0].status).toBe('blocked');
    await expect(readFile(join(sandbox, 'blocked.txt'), 'utf8')).rejects.toThrow();
  });

  it('reports success-without-verification as not verified', async () => {
    const steps: RequestedStep[] = [
      {
        operation: 'fs.write',
        connectorId: 'local-filesystem',
        inputs: { path: 'unverified.txt', content: 'x' },
        verifier: new MarkerReadBackVerifier('marker', 'never-matches', 'expected'),
      },
    ];
    const plan = await planObjectiveAsync({ objective: 'unverifiable', principal: 'tester', steps }, registry());
    attachVerifiers(plan, steps);

    const { result } = await executePlan({
      plan,
      principal: 'tester',
      capsule: grant('tester', 'fs.write', 'testing the unverified path'),
      connectors: registry(),
      readBack: {
        'step-1': async (i) => ({ path: i.path, other: 'value' }),
      },
    });

    // The file really was written and the operation really returned success,
    // but verification failed. This must NOT read as success.
    expect(result.steps[0].status).toBe('succeeded');
    expect(result.steps[0].verified).toBe(false);
    expect(result.fullyVerified).toBe(false);
    expect(result.status).toBe('partially_failed');
  });

  it('refuses to verify a destructive effect with an in-band verifier', async () => {
    const steps: RequestedStep[] = [
      {
        operation: 'fs.write',
        connectorId: 'local-filesystem',
        inputs: { path: 'inband.txt', content: 'x' },
        verifier: new RejectsInBandVerifier(),
      },
    ];
    const plan = await planObjectiveAsync({ objective: 'in-band', principal: 'tester', steps }, registry());
    attachVerifiers(plan, steps);

    const { result } = await executePlan({
      plan,
      principal: 'tester',
      capsule: grant('tester', 'fs.write', 'testing the anti-pattern guard'),
      connectors: registry(),
      readBack: { 'step-1': async (i) => ({ path: i.path }) },
    });

    expect(result.steps[0].verified).toBe(false);
    expect(result.steps[0].verificationMethod).toMatch(/refused/);
  });
});

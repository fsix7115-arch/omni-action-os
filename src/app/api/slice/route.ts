/**
 * The slice, over HTTP.
 *
 * POST /api/slice  { objective, path, content }  →  plan preview
 * POST /api/execute { plan, justification }       →  execute, verify, journal
 *
 * Permissions are enforced here, server-side. The request body carries a
 * justification for the grant but never a grant itself — the capsule is minted
 * in this handler from that justification. A client cannot send a permission
 * capsule and have it believed, which is the whole point of keeping the check
 * out of the browser.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { capabilityGraph, registry } from '@/lib/connectors/sdk';
import { appendEntry, verifyChain } from '@/lib/core/journal';
import {
  attachVerifiers,
  executePlan,
  grant,
  planObjectiveAsync,
  type RequestedStep,
} from '@/lib/core/orchestrator';
import { ExistsVerifier } from '@/lib/core/verify';
import type { JournalEntry, Plan } from '@/lib/core/types';

const requestSchema = z.object({
  objective: z.string().min(1).max(200),
  path: z.string().min(1).max(200),
  content: z.string().max(20_000).default(''),
  principal: z.string().min(1).max(60).default('you'),
});

/**
 * In-memory plans and journal.
 *
 * Deliberately in-memory for this phase: a restart clears them, and the README
 * says so. Swapping this for a database later is mechanical because nothing
 * outside this module holds a reference to the store. It is NOT suitable for
 * more than one process, and pretending otherwise would be the dishonest part.
 */
const plans = new Map<string, Plan>();
const verifiersByPlan = new Map<string, RequestedStep[]>();
let journal: JournalEntry[] = [];

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { objective, path, content, principal } = parsed.data;

  const steps: RequestedStep[] = [
    {
      operation: 'fs.write',
      connectorId: 'local-filesystem',
      inputs: { path, content },
      verifier: new ExistsVerifier('file-exists', 'path'),
    },
  ];

  try {
    const plan = await planObjectiveAsync({ objective, principal, steps }, registry());
    attachVerifiers(plan, steps);
    plans.set(plan.id, plan);
    verifiersByPlan.set(plan.id, steps);

    return NextResponse.json({
      planId: plan.id,
      objective: plan.objective,
      riskSummary: plan.riskSummary,
      capabilities: [...capabilityGraph().values()].map((c) => ({
        id: c.id,
        pricing: c.pricing,
        destructive: c.destructive,
        effect: c.effect,
      })),
      steps: plan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        capability: s.capability,
        inputs: s.inputs,
        risk: s.risk,
      })),
    });
  } catch (e) {
    // Path escape, unknown connector, or a capability with no verifier: all of
    // these are the user seeing why a plan cannot be built.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 422 }
    );
  }
}

/** Execute a previously previewed plan, then verify it. */
export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const schema = z.object({
    planId: z.string().min(1),
    justification: z.string().min(1).max(500),
    principal: z.string().min(1).max(60).default('you'),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'justification required', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { planId, justification, principal } = parsed.data;
  const plan = plans.get(planId);
  if (!plan) {
    return NextResponse.json({ error: 'unknown plan — build a preview first' }, { status: 404 });
  }

  const stepIds = verifiersByPlan.get(planId) ?? [];
  const capabilities = capabilityGraph();

  // The capsule is minted server-side from the justification. Any filter is
  // derived from the plan the user actually saw, not from client input.
  const capsule = grant(
    principal,
    plan.steps[0]?.capability ?? 'fs.write',
    justification,
    { scope: 'once' }
  );

  const readBack: Record<
    string,
    (i: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = {
    [plan.steps[0].id]: async (inputs) => {
      const root = process.env.OMNI_SANDBOX ?? join(process.cwd(), '.omni-sandbox');
      const content = await readFile(join(root, String(inputs.path)), 'utf8');
      return { path: inputs.path, bytes: content.length, content };
    },
  };

  const before = journal.length;
  const { result, journal: next } = await executePlan({
    plan,
    principal,
    capsule,
    connectors: registry(),
    readBack,
  });
  journal = next;

  const chain = verifyChain(journal);
  const cap = capabilities.get(plan.steps[0].capability);

  return NextResponse.json({
    execution: result,
    verification: {
      chainValid: chain.valid,
      entries: chain.entriesChecked,
      brokenAt: chain.brokenAt ?? null,
      // Spelled out so the UI cannot quietly show "200 OK" as success.
      claim: result.steps[0]?.claimed ?? null,
      verified: result.steps[0]?.verified ?? null,
      method: result.steps[0]?.verificationMethod ?? null,
    },
    capability: cap
      ? { id: cap.id, destructive: cap.destructive, compensation: cap.compensation, pricing: cap.pricing }
      : null,
    journalAdded: journal.length - before,
  });
}

/** Read the current journal and its chain status. */
export async function GET() {
  const chain = verifyChain(journal);
  return NextResponse.json({
    entries: journal.length,
    chainValid: chain.valid,
    brokenAt: chain.brokenAt ?? null,
    reason: chain.reason ?? null,
    journal: journal.slice(-50),
  });
}

/** Append a free-form intent entry, so the journal records the ask itself. */
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as { note?: string } | null;
  if (!body?.note) {
    return NextResponse.json({ error: 'note required' }, { status: 400 });
  }
  journal = appendEntry(journal, {
    timestamp: new Date().toISOString(),
    principal: 'you',
    type: 'intent',
    payload: { note: body.note },
  });
  return NextResponse.json({ entries: journal.length, chainValid: verifyChain(journal).valid });
}

'use client';

/**
 * The slice, in the browser.
 *
 * The screen is laid out in the order the system actually works, and it is
 * deliberately literal about the one distinction that matters: what the
 * operation *claimed* is shown in a different place from what was
 * *independently verified*. A user should never have to guess which of the two
 * they are looking at.
 */

import { useState } from 'react';

type Risk = { effect: string; destructive: boolean; compensable: string; rationale: string };
type PlanStep = { id: string; description: string; capability: string; inputs: Record<string, unknown>; risk: Risk };
type Preview = {
  planId: string;
  objective: string;
  riskSummary: { steps: number; uncompensable: number; destructive: number };
  steps: PlanStep[];
  capabilities: { id: string; pricing: string; destructive: boolean; effect: string }[];
};
type StepResult = {
  stepId: string;
  status: string;
  claimed: string | null;
  verified: boolean | null;
  verificationMethod?: string;
  error?: string;
};
type Outcome = {
  execution: { status: string; fullyVerified: boolean; steps: StepResult[] };
  verification: { chainValid: boolean; entries: number; claim: string | null; verified: boolean | null; method: string | null };
};

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'mute'; children: React.ReactNode }) {
  const cls = tone === 'ok' ? 'badge-ok' : tone === 'warn' ? 'badge-warn' : tone === 'bad' ? 'badge-bad' : '';
  return <span className={`badge ${cls}`}>{children}</span>;
}

export default function Home() {
  const [objective, setObjective] = useState('Save a meeting note I can prove was saved');
  const [path, setPath] = useState('notes/meeting.md');
  const [content, setContent] = useState('# Meeting\n\n- agreed the slice\n- verified the write\n');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [justification, setJustification] = useState('Saving my own note, safe to overwrite');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function buildPreview() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await fetch('/api/slice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective, path, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'could not build a plan');
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/slice', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: preview.planId, justification }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'execution failed');
      setOutcome(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <Badge tone="mute">Phase 2 — vertical slice</Badge>
        <h1 className="text-2xl font-semibold">OmniAction OS</h1>
        <p className="text-sm text-muted-foreground">
          State an objective, see the plan, approve the permission, watch it execute — then find out
          whether it actually happened. <code className="text-xs">claimed</code> and{' '}
          <code className="text-xs">verified</code> are shown separately on purpose.
        </p>
      </header>

      {error && (
        <div className="card border-destructive/40 p-3 text-sm text-destructive">{error}</div>
      )}

      <section className="card space-y-3 p-4">
        <h2 className="text-sm font-semibold">1 · Ask</h2>
        <label className="space-y-1">
          <span className="label">Objective</span>
          <input className="input" value={objective} onChange={(e) => setObjective(e.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="label">Target file</span>
            <input className="input" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="label">Content</span>
            <textarea
              className="input h-24 font-mono text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
        </div>
        <button className="btn-primary" onClick={buildPreview} disabled={busy}>
          {busy ? 'Working…' : 'Build plan preview'}
        </button>
      </section>

      {preview && (
        <section className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold">2 · Plan preview</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="mute">{preview.riskSummary.steps} step(s)</Badge>
            {preview.riskSummary.destructive > 0 && (
              <Badge tone="bad">{preview.riskSummary.destructive} destructive</Badge>
            )}
            {preview.riskSummary.uncompensable > 0 && (
              <Badge tone="warn">{preview.riskSummary.uncompensable} cannot be rolled back</Badge>
            )}
          </div>

          {preview.steps.map((s) => (
            <div key={s.id} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{s.description}</span>
                <Badge tone={s.risk.destructive ? 'bad' : 'ok'}>
                  {s.risk.compensable === 'none' ? 'irreversible' : 'reversible'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{s.risk.rationale}</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(s.inputs, null, 2)}
              </pre>
            </div>
          ))}

          <div className="space-y-1">
            <span className="label">Why are you approving this?</span>
            <input
              className="input"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="This is recorded in the journal, verbatim."
            />
          </div>
          <button className="btn-primary" onClick={approve} disabled={busy}>
            Approve and execute
          </button>
        </section>
      )}

      {outcome && (
        <section className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold">3 · Result</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 rounded-md border p-3">
              <span className="label">What the operation claimed</span>
              <p className="text-sm">{outcome.execution.steps[0]?.claimed ?? '—'}</p>
              <p className="text-xs text-muted-foreground">The provider said this happened.</p>
            </div>
            <div className="space-y-1 rounded-md border p-3">
              <span className="label">What was independently verified</span>
              <p className="text-sm">
                {outcome.verification.verified === true
                  ? 'Verified by reading the file back'
                  : outcome.verification.verified === false
                    ? 'Not verified'
                    : 'Not checked'}
              </p>
              <p className="text-xs text-muted-foreground">
                {outcome.verification.method ?? 'No verifier ran.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone={outcome.execution.fullyVerified ? 'ok' : 'bad'}>
              {outcome.execution.fullyVerified ? 'fully verified' : 'not fully verified'}
            </Badge>
            <Badge tone={outcome.verification.chainValid ? 'ok' : 'bad'}>
              journal chain {outcome.verification.chainValid ? 'intact' : 'broken'} ·{' '}
              {outcome.verification.entries} entries
            </Badge>
            <Badge tone="mute">status: {outcome.execution.status}</Badge>
          </div>
        </section>
      )}

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Connectors</h2>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {[
            ['local-filesystem', 'available', 'no credential, no network'],
            ['gmail', 'unavailable', 'needs OAuth credentials — not configured'],
            ['github', 'unavailable', 'needs a token — not configured'],
            ['slack', 'unavailable', 'needs a bot token — not configured'],
          ].map(([id, status, note]) => (
            <li key={id} className="flex items-center gap-2">
              <span className="font-mono">{id}</span>
              <Badge tone={status === 'available' ? 'ok' : 'mute'}>{status}</Badge>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

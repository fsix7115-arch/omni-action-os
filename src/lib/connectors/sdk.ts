/**
 * Connector SDK — the contract every connector implements.
 *
 * A connector is unavailable until proven otherwise. The registry below is
 * honest about this: a connector whose credentials or network are missing
 * reports `unavailable` with the real prerequisite named, and the planner
 * refuses to build a step on top of it. We never hand back a stub that looks
 * like it works.
 *
 * The reference connector is `local-filesystem`, chosen because it needs no
 * network and no credential, so the whole slice is runnable and verifiable in
 * CI and on a fresh machine. It is a real capability provider, not a mock —
 * it reads and writes actual files, and its verifier reads the file back.
 */

import { join } from 'node:path';
import type { Capability, CapabilityId, PricingMode } from '../core/types';

export type ConnectorStatus = 'available' | 'unavailable';

export interface Prerequisite {
  /** What is missing, in plain language. */
  description: string;
  /** How to obtain it. Never contains a secret value. */
  remedy: string;
  /** Env var names, if that is how it is supplied. Values never appear. */
  envVars?: string[];
}

export interface Operation {
  id: string;
  capability: CapabilityId;
  /** Human description used verbatim in the plan preview. */
  description: string;
  /**
   * Dry-run support. Operations that cannot be dry-run must say so, because
   * the plan preview is the main safety surface and it is only meaningful
   * where a dry run exists.
   */
  supportsDryRun: boolean;
  /** Run with no side effects and describe what would happen. */
  dryRun?(inputs: Record<string, unknown>): Promise<DryRunResult>;
  execute(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface DryRunResult {
  wouldDo: string;
  /** Anything the user cannot undo, named explicitly. */
  irreversible: string[];
  affectedCount?: number;
}

export interface Connector {
  id: string;
  displayName: string;
  description: string;
  status: ConnectorStatus;
  /** Present only when status is 'unavailable'. */
  missing?: Prerequisite;
  capabilities: Capability[];
  operations: Operation[];
}

// ---------------------------------------------------------------------------
// The capability graph, built from the connectors actually registered.
// ---------------------------------------------------------------------------

export function buildCapabilityGraph(connectors: Connector[]): Map<CapabilityId, Capability> {
  const graph = new Map<CapabilityId, Capability>();
  for (const c of connectors) {
    for (const cap of c.capabilities) {
      if (graph.has(cap.id)) {
        throw new Error(`duplicate capability id "${cap.id}" from connector "${c.id}"`);
      }
      graph.set(cap.id, cap);
    }
  }
  return graph;
}

export function assertOperationAvailable(
  connector: Connector,
  operationId: string
): Operation {
  if (connector.status === 'unavailable') {
    throw new Error(
      `connector "${connector.id}" is unavailable: ${connector.missing?.description ?? 'unknown reason'}`
    );
  }
  const op = connector.operations.find((o) => o.id === operationId);
  if (!op) throw new Error(`connector "${connector.id}" has no operation "${operationId}"`);
  return op;
}

// ---------------------------------------------------------------------------
// Reference connector: local filesystem.
// ---------------------------------------------------------------------------

const FS_CAPABILITIES: Capability[] = [
  {
    id: 'fs.read',
    name: 'fs.read',
    description: 'Read the contents of a file on this machine',
    effect: 'read',
    destructive: false,
    pricing: 'free',
    compensation: 'full',
    connector: 'local-filesystem',
  },
  {
    id: 'fs.write',
    name: 'fs.write',
    description: 'Create or overwrite a file on this machine',
    effect: 'write',
    // Overwrite discards the prior contents and we keep no backup by default,
    // so this is treated as uncompensable. That is what forces an explicit
    // approval on every write, which is the intended behaviour.
    destructive: true,
    pricing: 'free',
    compensation: 'none',
    connector: 'local-filesystem',
  },
];

/**
 * Sandbox root. Resolved per call so tests can point it at a temp directory via
 * OMNI_SANDBOX; a hardcoded path would let a test suite write into the
 * repository, which is exactly the kind of thing that passes CI and breaks a
 * developer's working tree.
 */
function sandboxRoot(): string {
  return process.env.OMNI_SANDBOX ?? join(process.cwd(), '.omni-sandbox');
}

class FilesystemConnector implements Connector {
  id = 'local-filesystem';
  displayName = 'Local filesystem';
  description =
    'Read and write files in a sandbox directory on this machine. No network, no credential.';
  status: ConnectorStatus = 'available';
  capabilities = FS_CAPABILITIES;

  /**
   * Confine every path to the sandbox root. Without this, a plan could name an
   * arbitrary path and the plan preview would be describing something the user
   * never saw. Traversal is rejected rather than normalised, so a rejected
   * path is visible in the journal instead of silently resolving elsewhere.
   */
  private resolveInsideSandbox(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (relPath.includes('..') || relPath.startsWith('/')) {
      throw new Error(`path "${relPath}" escapes the sandbox; only relative paths are allowed`);
    }
    return join(sandboxRoot(), relPath);
  }

  /**
   * Operations are defined as a field initialiser, so `this` inside the
   * object literal is the Operation, not the connector. We close over the
   * connector explicitly instead.
   */
  operations: Operation[] = (() => {
    const conn = this;
    const resolve = (relPath: string) => conn.resolveInsideSandbox(relPath);

    return [
      {
        id: 'fs.read',
        capability: 'fs.read',
        description: 'Read a file from the local sandbox',
        supportsDryRun: true,
        async dryRun(inputs) {
          const path = String(inputs.path);
          resolve(path); // validate before we claim anything
          return { wouldDo: `read ${path}`, irreversible: [] };
        },
        async execute(inputs) {
          const { readFile } = await import('node:fs/promises');
          const content = await readFile(resolve(String(inputs.path)), 'utf8');
          return { path: String(inputs.path), bytes: content.length, content };
        },
      },
      {
        id: 'fs.write',
        capability: 'fs.write',
        description: 'Write a file into the local sandbox',
        supportsDryRun: true,
        async dryRun(inputs) {
          const path = String(inputs.path);
          resolve(path);
          const content = String(inputs.content ?? '');
          return {
            wouldDo: `write ${content.length} bytes to ${path}`,
            // Named explicitly, because a silent overwrite is exactly the
            // thing a user approves without reading.
            irreversible: [`prior contents of ${path} are discarded with no backup`],
          };
        },
        async execute(inputs) {
          const { writeFile, mkdir } = await import('node:fs/promises');
          const { dirname } = await import('node:path');
          const full = resolve(String(inputs.path));
          await mkdir(dirname(full), { recursive: true });
          const content = String(inputs.content ?? '');
          await writeFile(full, content, 'utf8');
          return { path: String(inputs.path), bytes: content.length };
        },
      },
    ] as Operation[];
  })();
}

export const localFilesystemConnector = new FilesystemConnector();

/** Registry of every connector the system knows about. */
export function registry(): Connector[] {
  return [localFilesystemConnector];
}

export function capabilityGraph(): Map<CapabilityId, Capability> {
  return buildCapabilityGraph(registry());
}

export const PRICING_MODES: PricingMode[] = ['free', 'self-hosted', 'byo', 'paid', 'unknown'];

import { randomUUID } from "node:crypto";
import type { Agent, AgentInput } from "./agent.js";

/** Thrown when an insert/update would collide with another agent's email. */
export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`an agent with email "${email}" already exists`);
    this.name = "DuplicateEmailError";
  }
}

// ponytail: in-memory Map per the brief. Swap for a real DB behind this
// same interface if persistence is ever needed - callers don't change.
const agents = new Map<string, Agent>();

// Revision per agent, kept beside the data rather than inside it so the
// Agent JSON shape stays exactly what the brief specified. It is server
// owned: no request body can set it, and it is only ever exposed as an ETag.
const revisions = new Map<string, number>();

/** Outcome of a conditional write: why it failed, or the new state on success. */
export type ConditionalResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not-found" | "precondition-failed" };

/**
 * Whether an If-Match header satisfied the current revision. Built by the
 * route layer from the parsed header so the store stays free of HTTP syntax,
 * and evaluated inside the store so no other write can land in between.
 */
export type RevisionCheck = (currentRevision: number) => boolean;

function emailTaken(email: string, excludingId?: string): boolean {
  const normalized = email.toLowerCase();
  for (const agent of agents.values()) {
    if (agent.id !== excludingId && agent.email.toLowerCase() === normalized) {
      return true;
    }
  }
  return false;
}

export function listAgents(): Agent[] {
  return [...agents.values()];
}

export function getAgent(id: string): Agent | undefined {
  return agents.get(id);
}

/**
 * Current revision of an existing agent, for building its ETag.
 * Undefined exactly when the agent does not exist.
 */
export function getRevision(id: string): number | undefined {
  return revisions.get(id);
}

export function createAgent(input: AgentInput): Agent {
  if (emailTaken(input.email)) throw new DuplicateEmailError(input.email);
  const now = new Date().toISOString();
  const agent: Agent = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
  agents.set(agent.id, agent);
  revisions.set(agent.id, 1);
  return agent;
}

/**
 * Full replace of an existing agent's writable fields (PUT semantics), applied
 * only if `isCurrent` accepts the revision found at that moment.
 *
 * The check and the write share one synchronous block with no await between
 * them, so a concurrent request cannot slip in after the comparison and before
 * the mutation. On any failure - stale revision or duplicate email - both the
 * agent and its revision are left untouched.
 */
export function updateAgent(
  id: string,
  input: AgentInput,
  isCurrent: RevisionCheck,
): ConditionalResult<Agent> {
  const existing = agents.get(id);
  const revision = revisions.get(id);
  if (!existing || revision === undefined) return { ok: false, reason: "not-found" };
  if (!isCurrent(revision)) return { ok: false, reason: "precondition-failed" };
  if (emailTaken(input.email, id)) throw new DuplicateEmailError(input.email);

  const updated: Agent = { ...existing, ...input, updatedAt: new Date().toISOString() };
  agents.set(id, updated);
  // Advanced once per successful PUT, even when the fields are identical: the
  // revision counts accepted writes, so a client that replayed a no-op still
  // has to reload before its next conditional write.
  revisions.set(id, revision + 1);
  return { ok: true, value: updated };
}

/** Deletes an existing agent, only if `isCurrent` accepts its current revision. */
export function deleteAgent(id: string, isCurrent: RevisionCheck): ConditionalResult<void> {
  const revision = revisions.get(id);
  if (revision === undefined) return { ok: false, reason: "not-found" };
  if (!isCurrent(revision)) return { ok: false, reason: "precondition-failed" };

  agents.delete(id);
  revisions.delete(id);
  return { ok: true, value: undefined };
}

/** Test-only: reset store between test cases. */
export function _resetStore(): void {
  agents.clear();
  revisions.clear();
}

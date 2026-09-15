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

export function createAgent(input: AgentInput): Agent {
  if (emailTaken(input.email)) throw new DuplicateEmailError(input.email);
  const now = new Date().toISOString();
  const agent: Agent = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
  agents.set(agent.id, agent);
  return agent;
}

/** Full replace of an existing agent's writable fields (PUT semantics). */
export function updateAgent(id: string, input: AgentInput): Agent | undefined {
  const existing = agents.get(id);
  if (!existing) return undefined;
  if (emailTaken(input.email, id)) throw new DuplicateEmailError(input.email);
  const updated: Agent = { ...existing, ...input, updatedAt: new Date().toISOString() };
  agents.set(id, updated);
  return updated;
}

export function deleteAgent(id: string): boolean {
  return agents.delete(id);
}

/** Test-only: reset store between test cases. */
export function _resetStore(): void {
  agents.clear();
}

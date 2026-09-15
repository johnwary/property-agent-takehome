import type { AgentInput } from "./agent.js";

// Mirrors the CHECK constraints in docs/schema.sql - one set of rules, agreed
// on paper, enforced here since the API has no DB to enforce them for it.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MOBILE_E164 = /^\+[1-9]\d{7,14}$/;

export class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "ValidationError";
  }
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** Throws ValidationError listing every violation, or returns a trimmed, typed input. */
export function parseAgentInput(body: unknown): AgentInput {
  const issues: string[] = [];
  const b = (body ?? {}) as Record<string, unknown>;

  if (isBlank(b.firstName)) issues.push("firstName is required");
  if (isBlank(b.lastName)) issues.push("lastName is required");
  if (isBlank(b.email)) issues.push("email is required");
  else if (!EMAIL_SHAPE.test((b.email as string).trim())) issues.push("email is not a valid address");
  if (isBlank(b.mobileNumber)) issues.push("mobileNumber is required");
  else if (!MOBILE_E164.test((b.mobileNumber as string).trim())) {
    issues.push("mobileNumber must be E.164, e.g. +61412345678");
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    firstName: (b.firstName as string).trim(),
    lastName: (b.lastName as string).trim(),
    email: (b.email as string).trim(),
    mobileNumber: (b.mobileNumber as string).trim(),
  };
}

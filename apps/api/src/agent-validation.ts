import type { AgentInput } from "./agent.js";

// Mirrors the CHECK constraints in docs/schema.sql - one set of rules, agreed
// on paper, enforced here since the API has no DB to enforce them for it.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MOBILE_E164 = /^\+[1-9]\d{7,14}$/;

export interface FieldIssue {
  field: keyof AgentInput;
  message: string;
}

export class ValidationError extends Error {
  constructor(public readonly issues: FieldIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
    this.name = "ValidationError";
  }
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** Throws ValidationError listing every violation, or returns a trimmed, typed input. */
export function parseAgentInput(body: unknown): AgentInput {
  const issues: FieldIssue[] = [];
  const b = (body ?? {}) as Record<string, unknown>;

  if (isBlank(b.firstName)) issues.push({ field: "firstName", message: "is required" });
  if (isBlank(b.lastName)) issues.push({ field: "lastName", message: "is required" });
  if (isBlank(b.email)) issues.push({ field: "email", message: "is required" });
  else if (!EMAIL_SHAPE.test((b.email as string).trim())) {
    issues.push({ field: "email", message: "is not a valid address" });
  }
  if (isBlank(b.mobileNumber)) issues.push({ field: "mobileNumber", message: "is required" });
  else if (!MOBILE_E164.test((b.mobileNumber as string).trim())) {
    issues.push({ field: "mobileNumber", message: "must be E.164, e.g. +61412345678" });
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    firstName: (b.firstName as string).trim(),
    lastName: (b.lastName as string).trim(),
    email: (b.email as string).trim(),
    mobileNumber: (b.mobileNumber as string).trim(),
  };
}

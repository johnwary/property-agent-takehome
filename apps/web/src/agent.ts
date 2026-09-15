// Mirrors apps/api/src/agent.ts's wire shape. Not shared via a package
// reference - the API brings in Express and server-only deps the client
// doesn't need, so this is a small deliberate duplication of a JSON shape,
// not a dependency.
export interface Agent {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mobileNumber: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = Pick<Agent, "firstName" | "lastName" | "email" | "mobileNumber">;

export interface FieldIssue {
  field: keyof AgentInput;
  message: string;
}

export interface ApiErrorBody {
  error: string;
  issues?: FieldIssue[];
}

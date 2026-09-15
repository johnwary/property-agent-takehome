export interface Agent {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mobileNumber: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may write. id/createdAt/updatedAt are server-assigned. */
export type AgentInput = Pick<Agent, "firstName" | "lastName" | "email" | "mobileNumber">;

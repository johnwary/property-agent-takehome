import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { _resetStore } from "./agent-store.js";
import type { Agent } from "./agent.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => _resetStore());

const validAgent = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  mobileNumber: "+61412345678",
};

// Loose shape covering both a successful Agent response and an error body
// ({error, issues?}) - this file only reads whichever fields each test needs.
type AgentResponse = Partial<Agent> & { error?: string; issues?: string[] };

async function post(body: unknown): Promise<{ status: number; body: AgentResponse }> {
  const res = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as AgentResponse };
}

describe("agent CRUD", () => {
  it("creates an agent with server-assigned id and timestamps", async () => {
    const { status, body } = await post(validAgent);
    expect(status).toBe(201);
    expect(body).toMatchObject(validAgent);
    expect(body.id).toEqual(expect.any(String));
    expect(body.createdAt).toEqual(body.updatedAt);
  });

  it("lists all agents", async () => {
    await post(validAgent);
    await post({ ...validAgent, email: "second@example.com" });
    const res = await fetch(`${baseUrl}/agents`);
    const listed = (await res.json()) as AgentResponse[];
    expect(listed).toHaveLength(2);
  });

  it("gets a single agent by id", async () => {
    const { body: created } = await post(validAgent);
    const res = await fetch(`${baseUrl}/agents/${created.id}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as AgentResponse;
    expect(fetched.id).toBe(created.id);
  });

  it("404s on an unknown id", async () => {
    const res = await fetch(`${baseUrl}/agents/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("updates an agent and bumps updatedAt without changing createdAt", async () => {
    const { body: created } = await post(validAgent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await fetch(`${baseUrl}/agents/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validAgent, lastName: "King" }),
    });
    const updated = (await res.json()) as AgentResponse;
    expect(res.status).toBe(200);
    expect(updated.lastName).toBe("King");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it("deletes an agent, then 404s on repeat delete", async () => {
    const { body: created } = await post(validAgent);
    const first = await fetch(`${baseUrl}/agents/${created.id}`, { method: "DELETE" });
    expect(first.status).toBe(204);
    const second = await fetch(`${baseUrl}/agents/${created.id}`, { method: "DELETE" });
    expect(second.status).toBe(404);
  });

  it("rejects a create with missing/invalid fields, listing every issue", async () => {
    const { status, body } = await post({ firstName: "", email: "not-an-email", mobileNumber: "0412 345 678" });
    expect(status).toBe(400);
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("firstName"),
        expect.stringContaining("lastName"),
        expect.stringContaining("email"),
        expect.stringContaining("mobileNumber"),
      ]),
    );
  });

  it("rejects a duplicate email, case-insensitively, with 409", async () => {
    await post(validAgent);
    const { status, body } = await post({ ...validAgent, email: "ADA@EXAMPLE.COM" });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/);
  });

  it("allows an update to keep its own email unchanged", async () => {
    const { body: created } = await post(validAgent);
    const res = await fetch(`${baseUrl}/agents/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validAgent),
    });
    expect(res.status).toBe(200);
  });
});

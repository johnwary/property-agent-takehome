import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { _resetStore } from "./agent-store.js";
import type { Agent } from "./agent.js";
import type { FieldIssue } from "./agent-validation.js";

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
type AgentResponse = Partial<Agent> & { error?: string; issues?: FieldIssue[] };

async function post(body: unknown): Promise<{ status: number; body: AgentResponse; etag: string | null }> {
  const res = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as AgentResponse, etag: res.headers.get("etag") };
}

async function get(id: string): Promise<{ status: number; body: AgentResponse; etag: string | null }> {
  const res = await fetch(`${baseUrl}/agents/${id}`);
  return { status: res.status, body: (await res.json()) as AgentResponse, etag: res.headers.get("etag") };
}

/** PUT with an explicit If-Match, or none at all when `ifMatch` is undefined. */
async function put(
  id: string,
  body: unknown,
  ifMatch?: string,
): Promise<{ status: number; body: AgentResponse; etag: string | null }> {
  const res = await fetch(`${baseUrl}/agents/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(ifMatch === undefined ? {} : { "if-match": ifMatch }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as AgentResponse, etag: res.headers.get("etag") };
}

async function del(id: string, ifMatch?: string): Promise<number> {
  const res = await fetch(`${baseUrl}/agents/${id}`, {
    method: "DELETE",
    headers: ifMatch === undefined ? {} : { "if-match": ifMatch },
  });
  return res.status;
}

/** Creates an agent and returns the id and ETag a client would have loaded. */
async function createAgent(body: unknown = validAgent): Promise<{ id: string; etag: string }> {
  const { body: created, etag } = await post(body);
  if (!created.id || etag === null) throw new Error("create did not return an id and ETag");
  return { id: created.id, etag };
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
    const { body: created, etag } = await post(validAgent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { status, body: updated } = await put(created.id as string, { ...validAgent, lastName: "King" }, etag as string);
    expect(status).toBe(200);
    expect(updated.lastName).toBe("King");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it("deletes an agent, then 404s on repeat delete", async () => {
    const { id, etag } = await createAgent();
    expect(await del(id, etag)).toBe(204);
    // The agent is gone, so there is no revision left to match: 404 wins over
    // any precondition, and a wildcard cannot resurrect it either.
    expect(await del(id, etag)).toBe(404);
    expect(await del(id, "*")).toBe(404);
  });

  it("rejects a create with missing/invalid fields, one issue per field", async () => {
    const { status, body } = await post({ firstName: "", email: "not-an-email", mobileNumber: "0412 345 678" });
    expect(status).toBe(400);
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "firstName" }),
        expect.objectContaining({ field: "lastName" }),
        expect.objectContaining({ field: "email" }),
        expect.objectContaining({ field: "mobileNumber" }),
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
    const { id, etag } = await createAgent();
    const { status } = await put(id, validAgent, etag);
    expect(status).toBe(200);
  });

  it("400s on malformed JSON instead of 500", async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as AgentResponse;
    expect(body.error).toBeTruthy();
  });
});

describe("optimistic concurrency (ETag / If-Match)", () => {
  it("returns the same strong ETag from POST and GET, with no revision in the JSON", async () => {
    const { body: created, etag: postETag } = await post(validAgent);
    const { etag: getETag, body: fetched } = await get(created.id as string);

    expect(postETag).toBe('"1"');
    expect(getETag).toBe(postETag);
    // Revision is exposed only as an ETag; the Agent shape is unchanged.
    expect(Object.keys(fetched).sort()).toEqual(
      ["createdAt", "email", "firstName", "id", "lastName", "mobileNumber", "updatedAt"],
    );
    expect(JSON.stringify(fetched)).not.toMatch(/revision|version|_rev/i);
  });

  it("puts no ETag on error responses", async () => {
    const { id } = await createAgent();
    const stale = '"999"';

    // A body-hash ETag here would validate the error text, not the agent, and
    // a client could mistake it for a tag to send back as If-Match.
    for (const res of [
      await fetch(`${baseUrl}/agents/${id}`, { method: "DELETE" }), // 428
      await fetch(`${baseUrl}/agents/${id}`, { method: "DELETE", headers: { "if-match": "1" } }), // 400
      await fetch(`${baseUrl}/agents/${id}`, { method: "DELETE", headers: { "if-match": stale } }), // 412
      await fetch(`${baseUrl}/agents/nope`), // 404
    ]) {
      expect(res.status, "expected an error status").toBeGreaterThanOrEqual(400);
      expect(res.headers.get("etag"), `ETag on ${res.status}`).toBeNull();
      await res.text();
    }

    // The agent itself still carries its real validator.
    expect((await get(id)).etag).toBe('"1"');
  });

  it("keeps revision out of list responses too", async () => {
    await post(validAgent);
    const res = await fetch(`${baseUrl}/agents`);
    const listed = (await res.json()) as AgentResponse[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("revision");
  });

  it("applies a PUT whose If-Match matches, advancing the ETag and keeping createdAt", async () => {
    const { id, etag } = await createAgent();
    const { status, body: updated, etag: next } = await put(id, { ...validAgent, lastName: "King" }, etag);

    expect(status).toBe(200);
    expect(updated.lastName).toBe("King");
    expect(next).toBe('"2"');
    expect(await get(id).then((r) => r.etag)).toBe('"2"');
  });

  it("advances the revision even when a PUT changes nothing", async () => {
    const { id, etag } = await createAgent();
    const { status, etag: next } = await put(id, validAgent, etag);

    expect(status).toBe(200);
    // A no-op PUT is still an accepted write, so the token the client holds
    // is spent: replaying it must not succeed a second time.
    expect(next).toBe('"2"');
    expect((await put(id, validAgent, etag)).status).toBe(412);
  });

  it("rejects a stale PUT with 412, leaving fields and revision untouched", async () => {
    const { id, etag: stale } = await createAgent();
    const { etag: current } = await put(id, { ...validAgent, lastName: "King" }, stale);

    const { status, body } = await put(id, { ...validAgent, mobileNumber: "+61499999999" }, stale);
    expect(status).toBe(412);
    expect(body.error).toMatch(/If-Match did not match/i);

    const after = await get(id);
    expect(after.body.lastName).toBe("King");
    expect(after.body.mobileNumber).toBe(validAgent.mobileNumber);
    expect(after.etag).toBe(current);
  });

  it("rejects a stale DELETE with 412 and preserves the agent", async () => {
    const { id, etag: stale } = await createAgent();
    await put(id, { ...validAgent, lastName: "King" }, stale);

    expect(await del(id, stale)).toBe(412);
    const after = await get(id);
    expect(after.status).toBe(200);
    expect(after.body.lastName).toBe("King");
    expect(after.etag).toBe('"2"');
  });

  it("requires If-Match on PUT and DELETE, answering 428", async () => {
    const { id } = await createAgent();

    const putRes = await put(id, validAgent);
    expect(putRes.status).toBe(428);
    expect(putRes.body.error).toMatch(/If-Match/);
    expect(await del(id)).toBe(428);

    // 428 means "retry conditionally", so nothing was applied.
    expect((await get(id)).etag).toBe('"1"');
  });

  it("400s a malformed If-Match on PUT and DELETE", async () => {
    const { id } = await createAgent();
    // Unquoted, empty, unterminated, wildcard mixed into a list, and a bare
    // comma are all invalid syntax rather than tags that fail to match.
    // Note '" 1"': a space is not valid etagc (RFC 9110 8.8.3 lists %x21 and
    // %x23-7E, excluding SP), so it is bad syntax rather than a failed match.
    for (const header of ["1", "", "   ", '"1', "W/1", '"1", *', ",", '"1",', "garbage", '"1" "2"', '" 1"', '"a b"']) {
      expect((await put(id, validAgent, header)).status, `PUT If-Match: ${header}`).toBe(400);
      expect(await del(id, header), `DELETE If-Match: ${header}`).toBe(400);
    }
    expect((await get(id)).etag).toBe('"1"');
  });

  it("never strongly matches a weak tag", async () => {
    const { id } = await createAgent();
    // W/"1" is valid syntax, so this is 412 (a failed comparison), not 400.
    expect((await put(id, validAgent, 'W/"1"')).status).toBe(412);
    expect(await del(id, 'W/"1"')).toBe(412);
    expect((await get(id)).etag).toBe('"1"');
  });

  it("treats tags as opaque strings, not numbers to parse", async () => {
    const { id } = await createAgent();
    // Valid tags that simply are not this agent's ETag. "01" and "" matter
    // most: as strings they are not "1", however they compare as numbers.
    for (const header of ['"abc"', '""', '"0"', '"01"', '"2"', '"1.0"', '"+1"']) {
      expect((await put(id, validAgent, header)).status, `If-Match: ${header}`).toBe(412);
    }
    expect((await get(id)).etag).toBe('"1"');
  });

  it("accepts a tag list if any strong member matches", async () => {
    const { id } = await createAgent();
    // Includes a quoted tag containing a comma, which naive splitting breaks.
    const { status, etag } = await put(id, { ...validAgent, lastName: "King" }, '"abc", W/"1" ,  "a,b" , "1"');
    expect(status).toBe(200);
    expect(etag).toBe('"2"');
  });

  it("412s a tag list whose only matching member is weak", async () => {
    const { id } = await createAgent();
    expect((await put(id, validAgent, '"abc", W/"1", "2"')).status).toBe(412);
  });

  it("applies a wildcard If-Match to whatever revision exists", async () => {
    const { id, etag } = await createAgent();
    await put(id, { ...validAgent, lastName: "King" }, etag);

    // Wildcard checks existence only, so it ignores that "1" is long gone.
    const { status, etag: next } = await put(id, { ...validAgent, lastName: "Byron" }, "*");
    expect(status).toBe(200);
    expect(next).toBe('"3"');
    expect(await del(id, " * ")).toBe(204);
  });

  it("404s an unknown id on conditional PUT and DELETE", async () => {
    for (const header of ["*", '"1"']) {
      expect((await put("does-not-exist", validAgent, header)).status).toBe(404);
      expect(await del("does-not-exist", header)).toBe(404);
    }
  });

  describe("error precedence", () => {
    it("reports an invalid body before an absent or bad If-Match", async () => {
      const { id } = await createAgent();
      const invalid = { ...validAgent, email: "not-an-email" };

      // Ordinary request checks run first (RFC 9110 13.2), so a request that
      // is invalid on its own terms is 400 whatever its If-Match says.
      const missing = await put(id, invalid);
      expect(missing.status).toBe(400);
      expect(missing.body.issues).toEqual([expect.objectContaining({ field: "email" })]);

      expect((await put(id, invalid, "1")).status).toBe(400);
      expect((await put(id, invalid, '"nope"')).status).toBe(400);
      expect((await get(id)).etag).toBe('"1"');
    });

    it("reports a malformed If-Match before a stale one", async () => {
      const { id } = await createAgent();
      // Syntax is checked before comparison: a header that isn't a valid
      // entity-tag list can't be compared at all.
      expect((await put(id, validAgent, "1")).status).toBe(400);
      expect((await put(id, validAgent, '"nope"')).status).toBe(412);
    });

    it("reports an unknown id before a failed precondition", async () => {
      expect((await put("does-not-exist", validAgent, '"999"')).status).toBe(404);
      // But a malformed header still beats the 404, since it is rejected
      // before the store is consulted.
      expect((await put("does-not-exist", validAgent, "999")).status).toBe(400);
      expect((await put("does-not-exist", validAgent)).status).toBe(428);
    });

    it("reports a failed precondition before a duplicate email", async () => {
      const { id, etag: stale } = await createAgent();
      await post({ ...validAgent, email: "second@example.com" });
      await put(id, { ...validAgent, lastName: "King" }, stale);

      // A stale write is rejected without ever testing the email, so the
      // client is told to reload rather than to fix a conflict it can't see.
      const { status } = await put(id, { ...validAgent, email: "second@example.com" }, stale);
      expect(status).toBe(412);
    });
  });

  it("leaves data and revision unchanged when a duplicate email is rejected", async () => {
    const { id, etag } = await createAgent();
    await post({ ...validAgent, email: "second@example.com" });

    const { status } = await put(id, { ...validAgent, email: "SECOND@example.com" }, etag);
    expect(status).toBe(409);

    const after = await get(id);
    expect(after.body.email).toBe(validAgent.email);
    // Revision did not move, so the ETag the client already holds still works.
    expect(after.etag).toBe('"1"');
    expect((await put(id, { ...validAgent, lastName: "King" }, etag)).status).toBe(200);
  });

  it("ignores client-supplied revision metadata", async () => {
    const { id, etag } = await createAgent();
    const forged = { ...validAgent, lastName: "King", revision: 99, version: 99, _rev: 99, etag: '"99"' };

    const { status, body, etag: next } = await put(id, forged, etag);
    expect(status).toBe(200);
    expect(next).toBe('"2"');
    // Unknown body fields are dropped by validation, not stored.
    expect(body).not.toHaveProperty("revision");
    expect(body).not.toHaveProperty("_rev");

    // The forged value did not become the server's revision: "99" must fail
    // and the real next revision must succeed.
    expect((await put(id, validAgent, '"99"')).status).toBe(412);
    expect((await put(id, validAgent, '"2"')).status).toBe(200);
  });

  it("prevents the lost update the feature exists to stop", async () => {
    const { id, etag: loadedByBoth } = await createAgent();

    // Editor A saves first and wins.
    const a = await put(id, { ...validAgent, lastName: "King" }, loadedByBoth);
    expect(a.status).toBe(200);

    // Editor B saves from the same stale copy and is refused.
    const b = await put(id, { ...validAgent, mobileNumber: "+61499999999" }, loadedByBoth);
    expect(b.status).toBe(412);

    // Editor A's edit survived; Editor B can reload and reapply.
    const reloaded = await get(id);
    expect(reloaded.body.lastName).toBe("King");
    const retry = await put(id, { ...validAgent, lastName: "King", mobileNumber: "+61499999999" }, reloaded.etag as string);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ lastName: "King", mobileNumber: "+61499999999" });
  });
});

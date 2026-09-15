import { Router, type Request, type Response } from "express";
import {
  createAgent,
  deleteAgent,
  DuplicateEmailError,
  getAgent,
  getRevision,
  listAgents,
  updateAgent,
  type RevisionCheck,
} from "./agent-store.js";
import { parseAgentInput, ValidationError } from "./agent-validation.js";
import { matchesStrongly, parseIfMatch, type IfMatch } from "./if-match.js";

export const agentRouter = Router();

agentRouter.get("/", (_req: Request, res: Response) => {
  // No collection ETag: there is no conditional write against the list, and a
  // revision spanning every agent would make unrelated edits conflict. A
  // client that wants to edit an agent takes the ETag from its own
  // representation (POST or GET /agents/:id), never from the list.
  res.json(listAgents());
});

agentRouter.get("/:id", (req: Request, res: Response) => {
  const id = requireIdParam(req);
  const agent = getAgent(id);
  if (!agent) return res.status(404).json({ error: "agent not found" });
  setETag(res, id);
  res.json(agent);
});

agentRouter.post("/", (req: Request, res: Response) => {
  try {
    const input = parseAgentInput(req.body);
    const agent = createAgent(input);
    setETag(res, agent.id);
    res.status(201).json(agent);
  } catch (err) {
    handleWriteError(err, res);
  }
});

// PUT: full replace of an existing agent, guarded by If-Match. The header is
// required, not optional: an unconditional PUT is exactly the lost update this
// endpoint exists to prevent, so there is no way to ask for one.
agentRouter.put("/:id", (req: Request, res: Response) => {
  try {
    // Ordinary request checks first, preconditions after, per RFC 9110 13.2:
    // a request that isn't valid on its own terms can't be applied whatever
    // its If-Match says, and 400 is the more useful answer to a client
    // sending both a bad body and a bad header.
    const input = parseAgentInput(req.body);

    const precondition = readPrecondition(req, res);
    if (!precondition) return;

    const result = updateAgent(requireIdParam(req), input, precondition);
    if (!result.ok) return respondToFailedPrecondition(result.reason, res);

    setETag(res, result.value.id);
    res.json(result.value);
  } catch (err) {
    handleWriteError(err, res);
  }
});

agentRouter.delete("/:id", (req: Request, res: Response) => {
  const precondition = readPrecondition(req, res);
  if (!precondition) return;

  const result = deleteAgent(requireIdParam(req), precondition);
  if (!result.ok) return respondToFailedPrecondition(result.reason, res);

  res.status(204).send();
});

/**
 * Turns the If-Match header into a revision check for the store, or answers
 * the request itself and returns undefined when the header is unusable.
 *
 * A missing header is 428 rather than 412: the client did not fail a check, it
 * omitted one, and 428 tells it to retry conditionally (RFC 6585 section 3).
 */
function readPrecondition(req: Request, res: Response): RevisionCheck | undefined {
  const parsed = parseIfMatch(req.header("if-match"));

  if (parsed.kind === "absent") {
    res.status(428).json({ error: "If-Match header is required; GET the agent to obtain its ETag" });
    return undefined;
  }
  if (parsed.kind === "malformed") {
    res.status(400).json({ error: 'If-Match must be "*" or a list of quoted entity-tags, e.g. If-Match: "1"' });
    return undefined;
  }

  return toRevisionCheck(parsed);
}

/**
 * Wildcard matches any existing agent, so it only asserts existence and skips
 * revision checking entirely. It suits a client that means "whatever is there
 * now" (a cleanup script, say); an editing client must send the specific ETag
 * it loaded, or it is back to overwriting edits it never saw.
 */
function toRevisionCheck(parsed: IfMatch): RevisionCheck {
  if (parsed.kind === "wildcard") return () => true;
  return (revision) => matchesStrongly(parsed, String(revision));
}

function respondToFailedPrecondition(reason: "not-found" | "precondition-failed", res: Response): void {
  if (reason === "not-found") {
    res.status(404).json({ error: "agent not found" });
    return;
  }
  // Covers both causes: a tag that was current and has since been superseded,
  // and one that could never match strongly (a weak tag). Either way the fix
  // is the same - GET the agent, take its ETag, reapply the change.
  res.status(412).json({
    error: "If-Match did not match the agent's current ETag; reload it and reapply your changes",
  });
}

/**
 * Sets a strong ETag from the agent's server-owned revision. This is the only
 * place an ETag is issued: app.ts disables Express's body-hash default, which
 * would give two agents holding equal field values the same validator, and
 * would change whenever the body shape changed rather than when the agent did.
 */
function setETag(res: Response, id: string): void {
  const revision = getRevision(id);
  if (revision !== undefined) res.set("ETag", `"${revision}"`);
}

// noUncheckedIndexedAccess types every req.params.* access as possibly
// undefined, even though Express only invokes a "/:id" route when the
// segment matched. Narrow it once here instead of asserting at each call site.
function requireIdParam(req: Request): string {
  const { id } = req.params;
  if (!id) throw new Error("route matched without an :id param");
  return id;
}

function handleWriteError(err: unknown, res: Response): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: "validation failed", issues: err.issues });
  } else if (err instanceof DuplicateEmailError) {
    res.status(409).json({ error: err.message });
  } else {
    throw err;
  }
}

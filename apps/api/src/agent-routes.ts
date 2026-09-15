import { Router, type Request, type Response } from "express";
import { createAgent, deleteAgent, DuplicateEmailError, getAgent, listAgents, updateAgent } from "./agent-store.js";
import { parseAgentInput, ValidationError } from "./agent-validation.js";

export const agentRouter = Router();

agentRouter.get("/", (_req: Request, res: Response) => {
  res.json(listAgents());
});

agentRouter.get("/:id", (req: Request, res: Response) => {
  const agent = getAgent(requireIdParam(req));
  if (!agent) return res.status(404).json({ error: "agent not found" });
  res.json(agent);
});

agentRouter.post("/", (req: Request, res: Response) => {
  try {
    const input = parseAgentInput(req.body);
    const agent = createAgent(input);
    res.status(201).json(agent);
  } catch (err) {
    handleWriteError(err, res);
  }
});

// PUT: full upsert-by-id semantics per the brief ("upserting a single Agent").
// Same route id must exist for update; the web client provides an id it read
// back from a prior create/list, so this stays a straightforward "update or 404".
agentRouter.put("/:id", (req: Request, res: Response) => {
  try {
    const input = parseAgentInput(req.body);
    const agent = updateAgent(requireIdParam(req), input);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    res.json(agent);
  } catch (err) {
    handleWriteError(err, res);
  }
});

agentRouter.delete("/:id", (req: Request, res: Response) => {
  const deleted = deleteAgent(requireIdParam(req));
  if (!deleted) return res.status(404).json({ error: "agent not found" });
  res.status(204).send();
});

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

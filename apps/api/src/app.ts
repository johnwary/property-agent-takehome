import express, { type NextFunction, type Request, type Response } from "express";
import { agentRouter } from "./agent-routes.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/agents", agentRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  // Last-resort handler: anything a route didn't already turn into a typed
  // response. Express detects this as an error handler by its 4-arg arity,
  // so all 4 params are required.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // express.json() throws a body-parser SyntaxError on malformed JSON,
    // with .status/.statusCode already set to 400 - that's a client
    // mistake, not a server fault, and every route shares this one parser,
    // so this is the one place that can tell the two apart for all of them.
    if (isClientBodyError(err)) {
      return res.status(400).json({ error: "malformed JSON body" });
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

function isClientBodyError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: unknown }).status === 400
  );
}

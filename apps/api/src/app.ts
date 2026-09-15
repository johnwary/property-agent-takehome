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
  // response (e.g. malformed JSON body from express.json()). Express detects
  // this as an error handler by its 4-arg arity, so all 4 params are required.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

# Property Agent - Fullstack Take-home

TypeScript monorepo: REST API for property agent CRUD, plus a Vue client.

## Structure

| Path | Purpose |
| --- | --- |
| `apps/api` | REST API, in-memory store |
| `apps/web` | Vue 3 client |
| `docs` | Relational data model |

## Requirements

Node >= 20, pnpm >= 9.

## Getting started

```bash
pnpm install
pnpm dev   # runs apps/api on :3001 and apps/web on :5173 together
```

Then open http://localhost:5173 for the form, or see
[`apps/api/README.md`](apps/api/README.md) for the curl requests the brief
asks for (list, get-one, delete). [`apps/web/README.md`](apps/web/README.md)
covers the client. [`docs/README.md`](docs/README.md) covers the data model.

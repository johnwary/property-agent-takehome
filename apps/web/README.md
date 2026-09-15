# Web

Vue 3 client. One page: a form to create or update an Agent.

```bash
pnpm --filter @property-agent/api dev   # http://localhost:3001
pnpm --filter @property-agent/web dev   # http://localhost:5173
```

Vite proxies `/agents` to the API in dev (see `vite.config.ts`), so the form
calls same-origin relative paths and there's no CORS setup on the API.

## Why only create/update

Per the brief, listing, viewing a single agent, and deleting are shown as
curl/Postman requests in [`apps/api/README.md`](../api/README.md) - this
form doesn't call those endpoints. To update an existing agent, paste its
`id` (from a `GET /agents` or the response of a prior create) into the
"Agent id" field; leaving it blank creates a new one.

## Error handling: FE vs BE

Inputs use HTML5 `required` so an empty submit doesn't round-trip. Beyond
that, the form does no client-side validation - it submits and renders
whatever the API decides. Two reasons:

1. The validation rules (non-blank names, email shape, E.164 mobile,
   unique email) already live in one place - `apps/api/src/agent-validation.ts`,
   mirroring `docs/schema.sql`. Duplicating them client-side means two
   places that must agree on what "valid" means.
2. The API returns `{ error, issues: [{ field, message }] }` on `400`
   (see `apps/api/README.md`), so the form can map each error straight to
   its input without guessing from a string. A `409` (duplicate email) has
   no single field to blame, so it renders as a form-level message instead.

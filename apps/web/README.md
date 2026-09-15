# Web

Vue 3 client. One page: a form to create or update an Agent.

```bash
pnpm --filter @property-agent/api dev   # http://localhost:3001
pnpm --filter @property-agent/web dev   # http://localhost:5173
```

Vite proxies `/agents` to the API in dev (see `vite.config.ts`), so the form
calls same-origin relative paths and there's no CORS setup on the API.

## Why only create/update

Per the brief, listing and deleting are shown as curl/Postman requests in
[`apps/api/README.md`](../api/README.md) - this form has no UI for either. To
update an existing agent, paste its `id` (from a `GET /agents` or the
response of a prior create) into the "Agent id" field; leaving it blank
creates a new one.

The form does call `GET /agents/:id` itself, but only as a mechanism, never
as a feature a person drives directly - see "Optimistic concurrency" below.

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

## Optimistic concurrency

`PUT` requires an `If-Match` header carrying the agent's current `ETag` (see
[`apps/api/README.md`](../api/README.md#optimistic-concurrency)) - the form
implements the client side of that contract:

- **Acquiring the tag.** An agent the form just created or updated has its
  `ETag` cached in memory, keyed by id, from that response's header. Editing
  an id pasted in by hand - one the form never loaded itself - has nothing
  cached yet, so the form does one `GET /agents/:id` first to learn the
  current tag, then `PUT`s with it. A missing agent surfaces the same "agent
  not found" either way.
- **Refreshing it.** Every successful save replaces the cached tag with the
  one on that response, not the one that was just spent - otherwise a second
  save in the same sitting would fail as if it were already stale.
- **On `412`.** Someone else's write landed first. The form does **not**
  discard what the user typed and does **not** silently refetch-and-resubmit
  over it - either would recreate the exact lost update this feature exists
  to prevent. Instead it shows the conflict, leaves the form fields alone,
  and offers a "Reload current version" button that fetches and displays the
  real current record (and refreshes the cached tag) so the user can compare
  it against their own edit and decide what to keep before saving again.

Tried in a real browser: two edits of the same agent, one via curl and one
via the form, in the order the form's save would lose if this weren't here.
The form's retry after "Reload current version" succeeds; nothing is
overwritten silently along the way.

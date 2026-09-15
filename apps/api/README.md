# API

REST API for the Property Agent entity. In-memory store, no database.

```bash
pnpm --filter @property-agent/api dev   # http://localhost:3001
```

Per the brief, only create/update have a web form (`apps/web`). List, get-one,
and delete are shown here as curl requests.

## Agent

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | server-assigned (UUID) |
| `firstName` | string | required, non-blank |
| `lastName` | string | required, non-blank |
| `email` | string | required, unique (case-insensitive) |
| `mobileNumber` | string | required, E.164, e.g. `+61412345678` |
| `createdAt` | string | server-assigned, ISO 8601 |
| `updatedAt` | string | server-assigned, ISO 8601 |

## Endpoints

### `POST /agents` - create

Used by the web form.

```bash
curl -s -X POST http://localhost:3001/agents \
  -H 'content-type: application/json' \
  -d '{
    "firstName": "Ada",
    "lastName": "Lovelace",
    "email": "ada@example.com",
    "mobileNumber": "+61412345678"
  }'
```

`201` with the created agent, `400` with `{ error, issues: [{field, message}] }`
on invalid input, `409` if the email is already taken.

### `PUT /agents/:id` - update

Used by the web form. Full replace of the writable fields; `id` is in the URL.

```bash
curl -s -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' \
  -d '{
    "firstName": "Ada",
    "lastName": "King",
    "email": "ada@example.com",
    "mobileNumber": "+61412345678"
  }'
```

`200` with the updated agent, `404` if `id` doesn't exist, `400`/`409` as above.

### `GET /agents` - list all

```bash
curl -s http://localhost:3001/agents
```

`200` with a JSON array (empty array if none exist).

### `GET /agents/:id` - get one

```bash
curl -s http://localhost:3001/agents/<id>
```

`200` with the agent, `404` if `id` doesn't exist.

### `DELETE /agents/:id` - delete

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:3001/agents/<id>
```

`204` on success, `404` if `id` doesn't exist.

## Error handling

All errors are JSON: `{ error: string, issues?: [{field, message}] }`.

| Status | Cause |
| --- | --- |
| `400` | validation failed, or the request body is malformed JSON |
| `404` | no agent with that `id` |
| `409` | email already used by another agent |
| `500` | unexpected server error |

Validation mirrors the CHECK constraints in [`docs/schema.sql`](../../docs/schema.sql) -
the same rules agreed on paper are enforced here, since there's no database to
enforce them for the API.

## Tests

```bash
pnpm --filter @property-agent/api test
```

Drives real HTTP requests against the app on an ephemeral port - no handler
calls, no mocks.

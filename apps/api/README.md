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

`201` with the created agent and an `ETag` (always `"1"`), `400` with
`{ error, issues: [{field, message}] }` on invalid input, `409` if the email is
already taken.

### `PUT /agents/:id` - update

Full replace of the writable fields; `id` is in the URL. **Requires `If-Match`**
with the ETag you loaded - see [Optimistic concurrency](#optimistic-concurrency).

```bash
curl -s -i -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' \
  -H 'if-match: "1"' \
  -d '{
    "firstName": "Ada",
    "lastName": "King",
    "email": "ada@example.com",
    "mobileNumber": "+61412345678"
  }'
```

`200` with the updated agent and a new `ETag`, `404` if `id` doesn't exist,
`400`/`409` as above, and `412`/`428` per the table below.

### `GET /agents` - list all

```bash
curl -s http://localhost:3001/agents
```

`200` with a JSON array (empty array if none exist). No `ETag`: a write token
belongs to one agent, so clients take it from `POST` or `GET /agents/:id`.

### `GET /agents/:id` - get one

```bash
curl -s -i http://localhost:3001/agents/<id>
```

`200` with the agent and its `ETag`, `404` if `id` doesn't exist. This is where
an editing client gets the ETag it must send back when saving.

### `DELETE /agents/:id` - delete

Also requires `If-Match`, so a delete can't race an edit it never saw.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X DELETE http://localhost:3001/agents/<id> \
  -H 'if-match: "1"'
```

`204` on success, `404` if `id` doesn't exist, `412`/`428` per the table below.

## Optimistic concurrency

Two people open the same agent, one saves, then the other saves from a copy
that no longer reflects reality. Without a check the second save silently
overwrites the first. Every agent therefore carries a server-owned revision,
exposed as a strong `ETag`, and `PUT`/`DELETE` must say which revision they
believe they are changing.

```bash
# 1. Create, and keep the ETag.
curl -s -i -X POST http://localhost:3001/agents \
  -H 'content-type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","mobileNumber":"+61412345678"}'
# HTTP/1.1 201 Created
# ETag: "1"

# 2. Or read it back later.
curl -s -i http://localhost:3001/agents/<id>    # ETag: "1"

# 3. Save with the ETag you loaded. The revision advances.
curl -s -i -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' -H 'if-match: "1"' \
  -d '{"firstName":"Ada","lastName":"King","email":"ada@example.com","mobileNumber":"+61412345678"}'
# HTTP/1.1 200 OK
# ETag: "2"

# 4. A second client still holding "1" is refused instead of overwriting.
curl -s -i -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' -H 'if-match: "1"' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","mobileNumber":"+61499999999"}'
# HTTP/1.1 412 Precondition Failed
# {"error":"If-Match did not match the agent's current ETag; reload it and reapply your changes"}

# 5. Delete needs the current ETag too.
curl -s -i -X DELETE http://localhost:3001/agents/<id> -H 'if-match: "2"'   # 204
```

The failure responses (each uses a real, valid body - these are If-Match
failures, not body-validation ones):

```bash
BODY='{"firstName":"Ada","lastName":"King","email":"ada@example.com","mobileNumber":"+61412345678"}'

# Missing header: the client didn't fail a check, it omitted one.
curl -s -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' -d "$BODY"
# 428 {"error":"If-Match header is required; GET the agent to obtain its ETag"}

# Unquoted, so not a valid entity-tag - bad syntax, not a failed match.
curl -s -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' -H 'if-match: 1' -d "$BODY"
# 400 {"error":"If-Match must be \"*\" or a list of quoted entity-tags, e.g. If-Match: \"1\""}

# Valid syntax, wrong tag.
curl -s -X PUT http://localhost:3001/agents/<id> \
  -H 'content-type: application/json' -H 'if-match: "99"' -d "$BODY"
# 412
```

### Header rules

`If-Match` is read per
[RFC 9110 section 13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1).

| Header | Result |
| --- | --- |
| absent (header not sent) | `428` |
| `""` (header sent, empty) | `400` - not the same as absent, see below |
| `1`, `"1`, `W/1`, `" 1"`, `"1" "2"` | `400` - not a valid entity-tag list |
| `"1"` when the agent is at revision 1 | applied |
| `"99"`, `"abc"`, `""` (a quoted empty tag - not the same as an empty header) | `412` - valid tags, none of them current |
| `W/"1"` | `412` - weak tags never match strongly |
| `"abc", "a,b", "1"` | applied if any strong member matches |
| `"1",`, `,"1"`, `"1",,"2"` | applied - empty list elements are skipped, not malformed |
| `*` | applied if the agent exists |
| `"1", *` | `400` - `*` is an alternative to a list, not a member |

Details worth knowing:

- **Strong comparison only.** A weak tag (`W/"1"`) is valid syntax but can
  never match, so it gets `412`. The `W/` prefix is not stripped.
- **Tags are opaque.** `"abc"` is a perfectly valid tag that simply isn't
  current. This server happens to put an integer inside the quotes; clients
  should echo back the bytes they received and not construct tags themselves.
  `"01"` and `"1"` are different tags even though the numbers are equal.
- **Lists are parsed, not split on commas.** A quoted tag may contain a comma,
  so `"a,b"` is one tag. Optional whitespace around members is accepted.
- **`*` checks existence only** and bypasses the revision check entirely. It
  suits "delete whatever is there now" scripts. An ordinary editing client must
  send the specific ETag it loaded, or it is back to overwriting unseen edits.
- **A no-op `PUT` still advances the revision**, because it is still an
  accepted write. A client cannot replay the same `If-Match` twice.
- **Revision is never in the JSON.** The `Agent` shape is unchanged, and a
  `revision` field in a request body is ignored - clients cannot forge it.
- **Failed writes change nothing.** A `412` or `409` leaves both the fields and
  the revision as they were, so the ETag a client already holds stays valid.
- **Absent and empty are different, and both are reachable.** No `If-Match`
  header at all is `428`. An explicit empty value - `curl -H 'If-Match;'`
  sends one - reaches the server as `""` and is `400`, the same as any other
  unparseable value. Node's `req.header()` only returns `undefined` when the
  header was never sent; it does not treat an empty value as absent, and
  neither does this server.

### Client contract

`If-Match` on `PUT`/`DELETE` is required, so this is a breaking change for any
client that saved unconditionally. A client must now:

1. Keep the `ETag` from the `POST` or `GET /agents/:id` that loaded the agent.
2. Send it as `If-Match` when saving or deleting.
3. Replace its stored ETag with the one on the `200` response.
4. Treat `412` as "someone else changed this", not as a validation error.

**`apps/web` implements this contract.** See
[`apps/web/README.md`](../web/README.md#optimistic-concurrency) for how the
form acquires, sends, and refreshes the `ETag`, and what it does on `412`.

## Error handling

All errors are JSON: `{ error: string, issues?: [{field, message}] }`.

| Status | Cause |
| --- | --- |
| `400` | validation failed, malformed JSON body, or malformed `If-Match` |
| `404` | no agent with that `id` |
| `409` | email already used by another agent |
| `412` | `If-Match` didn't match the agent's current ETag (stale or weak tag) |
| `428` | `If-Match` header not sent at all on `PUT`/`DELETE` |
| `500` | unexpected server error |

Precedence when more than one thing is wrong, following
[RFC 9110 section 13.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1)
("a server MUST ignore preconditions if the same request without them would
not have been a 2xx or a 412" - so anything that would fail on its own terms
is decided before `If-Match` is even evaluated):

1. `400` malformed JSON body
2. `400` validation failed - an invalid body is rejected whatever `If-Match` says
3. `428` absent `If-Match`, or `400` if present but malformed (including an
   explicit empty value, e.g. `curl -H 'If-Match;'`) - either way the header
   is dealt with before the store is consulted, since a header that isn't
   valid syntax can't be compared at all
4. `404` unknown `id`
5. `409` duplicate email - an unconditional PUT with this email would already
   be `409`, so per 13.2.1 the precondition is never evaluated for it
6. `412` failed precondition

Validation mirrors the CHECK constraints in [`docs/schema.sql`](../../docs/schema.sql) -
the same rules agreed on paper are enforced here, since there's no database to
enforce them for the API.

## Tests

```bash
pnpm --filter @property-agent/api test
```

Drives real HTTP requests against the app on an ephemeral port - no handler
calls, no mocks. Conditional requests are covered end to end, including ETag
issuing, stale writes, header syntax, weak tags, lists, wildcard, and error
precedence.

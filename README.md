# Property Agent - Fullstack Take-home

TypeScript monorepo: REST API for property agent CRUD, plus a Vue client.

## Structure

| Path | Purpose |
| --- | --- |
| `apps/api` | REST API, in-memory store |
| `apps/web` | Vue 3 client |
| `docs` | Relational data model |

## Relational data model

Brief 2a. Five tables, rendered below so it is visible without opening a file.
[`docs/schema.sql`](docs/schema.sql) is the authoritative definition;
[`docs/verify.sql`](docs/verify.sql) proves it behaves as documented, and
[`docs/README.md`](docs/README.md) explains every decision.

Domain: a **property agent** manages multiple **rental properties**. Each
property is leased to a single **family**, which has one or more **tenants**.
An agent writes **notes and reminders** against a property to drive actions
such as maintenance or pest control.

```mermaid
erDiagram
    AGENT ||--o{ PROPERTY : "manages"
    AGENT ||--o{ NOTE : "writes"
    FAMILY ||--|{ TENANT : "consists of"
    FAMILY |o--o| PROPERTY : "occupies"
    PROPERTY |o--o{ NOTE : "is subject of"

    AGENT {
        uuid id PK
        varchar first_name "NOT NULL"
        varchar last_name "NOT NULL"
        citext email UK "NOT NULL, case-insensitive"
        varchar mobile_number "NOT NULL, E.164"
        timestamptz created_at "NOT NULL"
        timestamptz updated_at "NOT NULL"
    }

    PROPERTY {
        uuid id PK
        uuid agent_id FK "NOT NULL"
        uuid family_id FK "NULL while vacant"
        varchar address_line1 "NOT NULL"
        varchar address_line2
        varchar suburb "NOT NULL"
        varchar state "NOT NULL"
        varchar postcode "NOT NULL"
        char country_code "NOT NULL, default AU"
        timestamptz created_at "NOT NULL"
        timestamptz updated_at "NOT NULL"
    }

    FAMILY {
        uuid id PK
        varchar name "NOT NULL"
        timestamptz created_at "NOT NULL"
        timestamptz updated_at "NOT NULL"
    }

    TENANT {
        uuid id PK
        uuid family_id FK "NOT NULL"
        varchar first_name "NOT NULL"
        varchar last_name "NOT NULL"
        citext email UK "NULL, unique when present"
        varchar mobile_number
        boolean is_primary "NOT NULL, default false"
        timestamptz created_at "NOT NULL"
        timestamptz updated_at "NOT NULL"
    }

    NOTE {
        uuid id PK
        uuid agent_id FK "NOT NULL, author"
        uuid property_id FK "NULL = general note"
        enum category "NOT NULL, default general"
        text body "NOT NULL, non-empty"
        timestamptz due_at "NOT NULL => is a reminder"
        timestamptz completed_at "NULL until done"
        timestamptz created_at "NOT NULL"
        timestamptz updated_at "NOT NULL"
    }
```

### Relationships

| From | To | Cardinality | Rule |
| --- | --- | --- | --- |
| `agent` | `property` | 1 : 0..N | A property is managed by exactly one agent; an agent may manage none or many. Deleting an agent who still holds properties is refused (`ON DELETE RESTRICT`) rather than cascading a portfolio away. |
| `family` | `property` | 0..1 : 0..1 | A leased property references exactly one family, and a family occupies at most one current property (`UNIQUE (property.family_id)`). A vacant property has `family_id IS NULL`. |
| `family` | `tenant` | 1 : 0..N enforced, 1..N intended | A tenant belongs to exactly one family. The schema cannot require a minimum child count - see the note below. |
| `agent` | `note` | 1 : 0..N | Every note has exactly one authoring agent. |
| `property` | `note` | 0..1 : 0..N | A note may target a property, or be a general agent note (`property_id IS NULL`). |

A reminder is not its own table: it is a note with a `due_at`, outstanding
while `completed_at IS NULL`. Two tables would duplicate four columns to
express one nullable difference, and force a UNION to answer "show me
everything on this property".

### What the schema does and does not guarantee

The requirement is *"each property has 1 or more tenants belonging to a single
family."* Those are two claims, and structure enforces only one.

- **Guaranteed - a single family.** A property holds one nullable `family_id`,
  so there is no column that could hold a second family. The rule is
  impossible to violate rather than merely checked.
- **Not guaranteed - at least one tenant.** An empty `family` row is legal and
  `property.family_id` may be NULL. A minimum child count belongs at the
  application's transaction boundary: create a family together with its first
  tenant, refuse to remove the last tenant of an occupied property. A deferred
  constraint or trigger would make ordinary inserts awkward for no real gain at
  this size.

Known limitation: there is no `lease` table, so `property.family_id` records
who lives there *now* with no tenancy history. The fix is documented in
[`docs/README.md`](docs/README.md).

## Requirements

Node >= 20, pnpm >= 9.

## Getting started

```bash
pnpm install
pnpm dev   # runs apps/api on :3001 and apps/web on :5173 together
```

Then open http://localhost:5173 for the form.

| Read next | For |
| --- | --- |
| [`apps/api/README.md`](apps/api/README.md) | Endpoints, the curl requests the brief asks for (list, get-one, delete), error responses, and the ETag/If-Match contract |
| [`apps/web/README.md`](apps/web/README.md) | The Vue client, FE vs BE error handling, and the client side of optimistic concurrency |
| [`docs/README.md`](docs/README.md) | The data model above in full: every constraint, how to execute the schema, and what it deliberately leaves out |

## Checks

```bash
pnpm typecheck
pnpm test        # 33 tests, over real HTTP
pnpm build
```

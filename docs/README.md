# Relational data model

Domain: a **property agent** manages multiple **rental properties**. Each
property is leased to a single **family**, which has one or more **tenants**.
An agent writes **notes and reminders** against a property to drive actions
such as maintenance or pest control.

Source of truth for this diagram is [`data-model.dbml`](./data-model.dbml),
renderable at [dbdiagram.io](https://dbdiagram.io).

## Diagram

```mermaid
erDiagram
    AGENT ||--o{ PROPERTY : "manages"
    AGENT ||--o{ NOTE : "writes"
    FAMILY ||--o{ TENANT : "consists of"
    FAMILY ||--o| PROPERTY : "leases"
    PROPERTY ||--o{ NOTE : "is subject of"

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

## Relationships

| From | To | Cardinality | Rule |
| --- | --- | --- | --- |
| `agent` | `property` | 1 : 0..N | A property is managed by exactly one agent; an agent may manage none or many. |
| `family` | `property` | 0..1 : 0..1 | A leased property references exactly one family. Vacant property has `family_id IS NULL`. |
| `family` | `tenant` | 1 : 1..N | A tenant belongs to exactly one family. A family is expected to have at least one tenant. |
| `agent` | `note` | 1 : 0..N | Every note has exactly one authoring agent. |
| `property` | `note` | 0..1 : 0..N | A note may target a property, or be a general agent note. |

The requirement *"each property has 1 or more tenants belonging to a single
family"* is satisfied structurally: tenants attach to a **family**, and a
property references **one** family. There is no path by which a property can
reach two families, so no check constraint or trigger is needed.

## Constraints

### Keys and uniqueness

| Table | Constraint | Type |
| --- | --- | --- |
| all | `id` | PRIMARY KEY (uuid) |
| `agent` | `email` | UNIQUE, case-insensitive (`citext`) |
| `tenant` | `email` | UNIQUE where NOT NULL |
| `tenant` | `(family_id) WHERE is_primary` | UNIQUE partial - at most one primary contact per family |

### Referential integrity

| Child | Parent | On delete |
| --- | --- | --- |
| `property.agent_id` | `agent.id` | `RESTRICT` - an agent holding properties cannot be deleted; reassign first |
| `property.family_id` | `family.id` | `SET NULL` - the property survives the tenancy ending |
| `tenant.family_id` | `family.id` | `CASCADE` - a family's tenants have no meaning without it |
| `note.agent_id` | `agent.id` | `RESTRICT` - preserve authorship |
| `note.property_id` | `property.id` | `CASCADE` - property-specific notes die with the property |

`RESTRICT` on `property.agent_id` is deliberate. Silently orphaning or
cascading away a portfolio when an agent record is removed is data loss;
forcing an explicit reassignment is the safer default.

### Check constraints

| Table | Constraint |
| --- | --- |
| `agent` | `char_length(trim(first_name)) > 0`, same for `last_name` |
| `agent` | `email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'` |
| `agent` | `mobile_number ~ '^\+[1-9]\d{7,14}$'` (E.164) |
| `agent` | `updated_at >= created_at` |
| `note` | `char_length(trim(body)) > 0` |
| `note` | `completed_at IS NULL OR due_at IS NOT NULL` - only a reminder can be completed |
| `note` | `completed_at IS NULL OR completed_at >= created_at` |
| `property` | `char_length(trim(address_line1)) > 0` |

## Notes vs reminders

Modelled as **one table**. A reminder is a note that has a `due_at`; it is
outstanding while `completed_at IS NULL`. Splitting them into two tables would
duplicate `agent_id`, `property_id`, `category` and `body` to express one
nullable column of difference, and would force a UNION to answer "show me
everything on this property".

The agent's reminder queue is a partial index:

```sql
CREATE INDEX agent_reminder_queue ON note (agent_id, due_at)
  WHERE due_at IS NOT NULL AND completed_at IS NULL;
```

## Known limitations

Deliberate simplifications, given the scope and time box:

1. **No tenancy history.** `property.family_id` records who lives there *now*.
   A property re-let to a new family loses the previous tenancy. Modelling it
   properly means a `lease` table (`property_id`, `family_id`, `starts_on`,
   `ends_on`, `rent_amount`) with an exclusion constraint preventing
   overlapping active leases for one property. That is the correct model for a
   real letting business and the first change I would make.

2. **No agent assignment history.** `property.agent_id` is a simple FK, so a
   property that changes agent loses the record of who managed it before. The
   fix mirrors the above: a `property_agent_assignment` table with a date range.

3. **"At least one tenant per family" is not enforced by the schema.** A
   `family` row can be inserted before its tenants exist. Enforcing a minimum
   child count requires a deferred constraint or a trigger, both of which make
   ordinary inserts awkward. It belongs in the application's transaction
   boundary: create the family and its first tenant together, or not at all.

4. **No soft delete.** Deleting is permanent. For a system of record holding
   tenancy data, a `deleted_at` column and filtered reads would be the
   production choice.

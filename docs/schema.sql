-- Property Agent domain - authoritative schema definition.
--
-- The application in apps/api stores data in memory, as the brief requires.
-- This file exists so the documented data model is executable rather than
-- merely drawn: docs/verify.sql runs assertions against it.
--
-- Target: PostgreSQL 14+.
--   psql -v ON_ERROR_STOP=1 -f docs/schema.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS note, tenant, property, family, agent CASCADE;
DROP TYPE IF EXISTS note_category;

CREATE TYPE note_category AS ENUM (
  'general', 'maintenance', 'pest_control', 'inspection', 'compliance'
);

-- ---------------------------------------------------------------------------
-- agent: the only entity exposed by the REST API in this exercise.
-- ---------------------------------------------------------------------------
CREATE TABLE agent (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    varchar(80) NOT NULL,
  last_name     varchar(80) NOT NULL,
  email         citext      NOT NULL UNIQUE,
  mobile_number varchar(20) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_first_name_not_blank CHECK (char_length(btrim(first_name)) > 0),
  CONSTRAINT agent_last_name_not_blank  CHECK (char_length(btrim(last_name)) > 0),
  CONSTRAINT agent_email_shape          CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT agent_mobile_e164          CHECK (mobile_number ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT agent_updated_after_created CHECK (updated_at >= created_at)
);

COMMENT ON TABLE agent IS 'A property agent managing rental properties.';
COMMENT ON COLUMN agent.email IS 'citext: uniqueness is case-insensitive.';

-- ---------------------------------------------------------------------------
-- family: the leaseholding household.
--
-- Modelled as an entity so that "all tenants of a property belong to a single
-- family" holds structurally: tenants attach to a family, and a property
-- references at most one family.
--
-- Scope assumption (beyond the brief): a family represents the household
-- occupying ONE current rental property. Enforced by UNIQUE (property.family_id).
-- Tenancy history is out of scope; see docs/README.md "Known limitations".
-- ---------------------------------------------------------------------------
CREATE TABLE family (
  id         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       varchar(120) NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT family_name_not_blank CHECK (char_length(btrim(name)) > 0)
);

-- ---------------------------------------------------------------------------
-- property: a rental property, managed by exactly one agent.
-- ---------------------------------------------------------------------------
CREATE TABLE property (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid         NOT NULL,
  family_id     uuid,
  address_line1 varchar(160) NOT NULL,
  address_line2 varchar(160),
  suburb        varchar(80)  NOT NULL,
  state         varchar(40)  NOT NULL,
  postcode      varchar(12)  NOT NULL,
  country_code  char(2)      NOT NULL DEFAULT 'AU',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  -- RESTRICT: an agent holding properties cannot be deleted. Cascading would
  -- destroy a portfolio; SET NULL would orphan it. Reassignment must be explicit.
  CONSTRAINT property_agent_fk FOREIGN KEY (agent_id)
    REFERENCES agent (id) ON DELETE RESTRICT,

  -- SET NULL: the property outlives the tenancy ending.
  CONSTRAINT property_family_fk FOREIGN KEY (family_id)
    REFERENCES family (id) ON DELETE SET NULL,

  -- One current property per family (see family table comment).
  CONSTRAINT property_family_unique UNIQUE (family_id),

  CONSTRAINT property_address_not_blank CHECK (char_length(btrim(address_line1)) > 0)
);

CREATE INDEX property_agent_idx ON property (agent_id);

COMMENT ON COLUMN property.family_id IS
  'NULL while vacant. UNIQUE: a family occupies at most one current property.';

-- ---------------------------------------------------------------------------
-- tenant: a person on the lease, belonging to exactly one family.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid        NOT NULL,
  first_name    varchar(80) NOT NULL,
  last_name     varchar(80) NOT NULL,
  email         citext      UNIQUE,
  mobile_number varchar(20),
  is_primary    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- CASCADE: tenants have no meaning without their family.
  CONSTRAINT tenant_family_fk FOREIGN KEY (family_id)
    REFERENCES family (id) ON DELETE CASCADE,

  CONSTRAINT tenant_first_name_not_blank CHECK (char_length(btrim(first_name)) > 0),
  CONSTRAINT tenant_last_name_not_blank  CHECK (char_length(btrim(last_name)) > 0)
);

CREATE INDEX tenant_family_idx ON tenant (family_id);

-- At most one primary contact per family.
--
-- This must be a partial unique INDEX, not a UNIQUE constraint: PostgreSQL has
-- no WHERE clause on table constraints. A composite UNIQUE (family_id,
-- is_primary) would be valid SQL but WRONG - it would cap a family at two
-- tenants (one true, one false), contradicting "1 or more tenants".
CREATE UNIQUE INDEX one_primary_tenant_per_family
  ON tenant (family_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- note: notes and reminders share one table.
-- A reminder is a note that has a due_at; it is outstanding until completed_at.
-- ---------------------------------------------------------------------------
CREATE TABLE note (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid          NOT NULL,
  property_id  uuid,
  category     note_category NOT NULL DEFAULT 'general',
  body         text          NOT NULL,
  due_at       timestamptz,
  completed_at timestamptz,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),

  -- RESTRICT: preserve authorship.
  CONSTRAINT note_agent_fk FOREIGN KEY (agent_id)
    REFERENCES agent (id) ON DELETE RESTRICT,

  -- CASCADE: property-specific notes die with the property.
  CONSTRAINT note_property_fk FOREIGN KEY (property_id)
    REFERENCES property (id) ON DELETE CASCADE,

  CONSTRAINT note_body_not_blank CHECK (char_length(btrim(body)) > 0),

  -- Only a reminder can be completed.
  CONSTRAINT note_completed_requires_due
    CHECK (completed_at IS NULL OR due_at IS NOT NULL),

  -- A note cannot be completed before it existed.
  CONSTRAINT note_completed_after_created
    CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX note_agent_idx ON note (agent_id);
CREATE INDEX note_property_idx ON note (property_id);

-- The agent's outstanding reminder queue.
CREATE INDEX agent_reminder_queue ON note (agent_id, due_at)
  WHERE due_at IS NOT NULL AND completed_at IS NULL;

COMMENT ON COLUMN note.property_id IS 'NULL = a general note, not property-specific.';
COMMENT ON COLUMN note.due_at IS 'Set => this note is a reminder.';

COMMIT;

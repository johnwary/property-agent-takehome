-- Executable assertions for the documented data model.
--
-- Every rule stated in docs/README.md that the schema claims to enforce is
-- exercised here: the ones that must succeed, and the ones that must fail.
--
--   psql -v ON_ERROR_STOP=1 -f docs/schema.sql -f docs/verify.sql
--
-- ON_ERROR_STOP=1 makes a failed assertion exit non-zero. This file's own
-- fixtures run inside a transaction that is rolled back, so THIS file leaves
-- no row data behind. schema.sql, run first, is not so gentle - it drops and
-- recreates every table and commits that. Only ever point this pair at the
-- disposable container in docs/README.md "Verifying the model".

\set ON_ERROR_STOP on
\timing off

BEGIN;

-- Assert that a statement violates a specific constraint. Fails loudly if the
-- statement unexpectedly succeeds, or fails for some unrelated reason.
CREATE OR REPLACE FUNCTION assert_rejects(stmt text, expected_constraint text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  actual text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS actual = CONSTRAINT_NAME;
    IF actual IS DISTINCT FROM expected_constraint THEN
      RAISE EXCEPTION 'FAIL: expected constraint "%", got "%" for: %',
        expected_constraint, COALESCE(actual, '<none>'), stmt;
    END IF;
    RAISE NOTICE 'ok   rejected by % : %', expected_constraint, left(stmt, 60);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: expected "%" to be rejected by %, but it succeeded',
    stmt, expected_constraint;
END;
$$;

CREATE OR REPLACE FUNCTION assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RAISE NOTICE 'ok   %', label;
END;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO agent (id, first_name, last_name, email, mobile_number) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Ada', 'Lovelace',
   'ada@example.com', '+61412345678');

INSERT INTO family (id, name) VALUES
  ('22222222-2222-2222-2222-222222222222', 'The Nguyen family'),
  ('33333333-3333-3333-3333-333333333333', 'The Smith family');

INSERT INTO property (id, agent_id, family_id, address_line1, suburb, state, postcode) VALUES
  ('44444444-4444-4444-4444-444444444444',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '1 Collins St', 'Melbourne', 'VIC', '3000');

-- ---------------------------------------------------------------------------
-- 1. A family may contain many tenants. ("1 or more tenants")
-- ---------------------------------------------------------------------------
INSERT INTO tenant (family_id, first_name, last_name, is_primary) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Minh',  'Nguyen', true),
  ('22222222-2222-2222-2222-222222222222', 'Lan',   'Nguyen', false),
  ('22222222-2222-2222-2222-222222222222', 'Thu',   'Nguyen', false),
  ('22222222-2222-2222-2222-222222222222', 'Bao',   'Nguyen', false);

SELECT assert(
  (SELECT count(*) FROM tenant
    WHERE family_id = '22222222-2222-2222-2222-222222222222') = 4,
  'a family holds four tenants');

-- ---------------------------------------------------------------------------
-- 2. At most one primary tenant per family.
-- ---------------------------------------------------------------------------
SELECT assert_rejects($$
  INSERT INTO tenant (family_id, first_name, last_name, is_primary)
  VALUES ('22222222-2222-2222-2222-222222222222', 'Kim', 'Nguyen', true)
$$, 'one_primary_tenant_per_family');

-- ---------------------------------------------------------------------------
-- 3. A family occupies at most one current property.
-- ---------------------------------------------------------------------------
SELECT assert_rejects($$
  INSERT INTO property (agent_id, family_id, address_line1, suburb, state, postcode)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          '2 Bourke St', 'Melbourne', 'VIC', '3000')
$$, 'property_family_unique');

-- A vacant property is permitted, and several may be vacant at once:
-- UNIQUE treats NULLs as distinct.
INSERT INTO property (agent_id, address_line1, suburb, state, postcode) VALUES
  ('11111111-1111-1111-1111-111111111111', '3 Swanston St', 'Melbourne', 'VIC', '3000'),
  ('11111111-1111-1111-1111-111111111111', '4 Elizabeth St', 'Melbourne', 'VIC', '3000');

SELECT assert(
  (SELECT count(*) FROM property WHERE family_id IS NULL) = 2,
  'multiple properties may be vacant simultaneously');

-- ---------------------------------------------------------------------------
-- 4. Referential actions behave as documented.
-- ---------------------------------------------------------------------------

-- RESTRICT: an agent holding properties cannot be deleted.
SELECT assert_rejects($$
  DELETE FROM agent WHERE id = '11111111-1111-1111-1111-111111111111'
$$, 'property_agent_fk');

INSERT INTO note (id, agent_id, property_id, category, body, due_at) VALUES
  ('55555555-5555-5555-5555-555555555555',
   '11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444',
   'pest_control', 'Quarterly pest inspection due.', now() + interval '30 days');

-- RESTRICT: an agent who authored notes cannot be deleted. A second agent
-- with no properties isolates this from the property_agent_fk check above -
-- agent 111 owns both properties and notes, so deleting it would be
-- rejected by whichever FK psql checks first, proving nothing about notes.
INSERT INTO agent (id, first_name, last_name, email, mobile_number) VALUES
  ('77777777-7777-7777-7777-777777777777', 'Grace', 'Hopper',
   'grace@example.com', '+61412345679');

INSERT INTO note (id, agent_id, body) VALUES
  ('88888888-8888-8888-8888-888888888888',
   '77777777-7777-7777-7777-777777777777', 'General note, no property.');

SELECT assert_rejects($$
  DELETE FROM agent WHERE id = '77777777-7777-7777-7777-777777777777'
$$, 'note_agent_fk');

-- CASCADE: property-specific notes die with the property.
DELETE FROM property WHERE id = '44444444-4444-4444-4444-444444444444';
SELECT assert(
  (SELECT count(*) FROM note
    WHERE id = '55555555-5555-5555-5555-555555555555') = 0,
  'deleting a property cascades to its notes');

-- SET NULL is unreachable here: deleting a family whose property was just
-- removed leaves nothing to null out, so re-establish the link first.
INSERT INTO property (id, agent_id, family_id, address_line1, suburb, state, postcode) VALUES
  ('66666666-6666-6666-6666-666666666666',
   '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333',
   '5 Lonsdale St', 'Melbourne', 'VIC', '3000');

-- Give this family tenants too, so the cascade below has rows to remove -
-- a family with none would make that assertion pass vacuously.
INSERT INTO tenant (family_id, first_name, last_name, is_primary) VALUES
  ('33333333-3333-3333-3333-333333333333', 'Jo',   'Smith', true),
  ('33333333-3333-3333-3333-333333333333', 'Alex', 'Smith', false);

SELECT assert(
  (SELECT count(*) FROM tenant
    WHERE family_id = '33333333-3333-3333-3333-333333333333') = 2,
  'the Smith family holds two tenants before deletion');

DELETE FROM family WHERE id = '33333333-3333-3333-3333-333333333333';

-- The property row must still exist (not cascaded away) with its family
-- link nulled. A scalar subquery on a missing row also returns NULL, so a
-- bare "IS NULL" check on family_id alone cannot tell "nulled" from "gone" -
-- assert the row's existence and its family_id separately.
SELECT assert(
  (SELECT count(*) FROM property
    WHERE id = '66666666-6666-6666-6666-666666666666') = 1,
  'the property row survives its family being deleted');

SELECT assert(
  (SELECT family_id FROM property
    WHERE id = '66666666-6666-6666-6666-666666666666') IS NULL,
  'deleting a family nulls the surviving property''s family_id');

-- CASCADE: a family's tenants go with it.
SELECT assert(
  (SELECT count(*) FROM tenant
    WHERE family_id = '33333333-3333-3333-3333-333333333333') = 0,
  'deleting a family cascades to its tenants');

-- ---------------------------------------------------------------------------
-- 5. Check constraints.
-- ---------------------------------------------------------------------------

-- Only a reminder (one with a due_at) can be completed.
SELECT assert_rejects($$
  INSERT INTO note (agent_id, body, completed_at)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Done, but never due.', now())
$$, 'note_completed_requires_due');

-- A note cannot be completed before it existed.
SELECT assert_rejects($$
  INSERT INTO note (agent_id, body, due_at, completed_at, created_at)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Completed in the past.',
          now(), now() - interval '2 days', now() - interval '1 day')
$$, 'note_completed_after_created');

-- A reminder completed after it was created is fine.
INSERT INTO note (agent_id, body, due_at, completed_at, created_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'Completed on time.',
        now(), now(), now() - interval '1 day');

SELECT assert(
  (SELECT count(*) FROM note WHERE body = 'Completed on time.') = 1,
  'a reminder may be completed after it was created');

SELECT assert_rejects($$
  INSERT INTO note (agent_id, body)
  VALUES ('11111111-1111-1111-1111-111111111111', '   ')
$$, 'note_body_not_blank');

SELECT assert_rejects($$
  INSERT INTO agent (first_name, last_name, email, mobile_number)
  VALUES ('No', 'AtSign', 'not-an-email', '+61412345670')
$$, 'agent_email_shape');

SELECT assert_rejects($$
  INSERT INTO agent (first_name, last_name, email, mobile_number)
  VALUES ('Bad', 'Mobile', 'bad.mobile@example.com', '0412 345 678')
$$, 'agent_mobile_e164');

SELECT assert_rejects($$
  INSERT INTO agent (first_name, last_name, email, mobile_number)
  VALUES ('  ', 'Blank', 'blank.first@example.com', '+61412345671')
$$, 'agent_first_name_not_blank');

SELECT assert_rejects($$
  INSERT INTO agent (first_name, last_name, email, mobile_number)
  VALUES ('Blank', '  ', 'blank.last@example.com', '+61412345673')
$$, 'agent_last_name_not_blank');

SELECT assert_rejects($$
  INSERT INTO agent (id, first_name, last_name, email, mobile_number, updated_at)
  VALUES (gen_random_uuid(), 'Time', 'Traveller', 'time.traveller@example.com',
          '+61412345674', now() - interval '1 day')
$$, 'agent_updated_after_created');

SELECT assert_rejects($$
  INSERT INTO family (name) VALUES ('   ')
$$, 'family_name_not_blank');

SELECT assert_rejects($$
  INSERT INTO property (agent_id, address_line1, suburb, state, postcode)
  VALUES ('11111111-1111-1111-1111-111111111111', '  ', 'Melbourne', 'VIC', '3000')
$$, 'property_address_not_blank');

SELECT assert_rejects($$
  INSERT INTO tenant (family_id, first_name, last_name)
  VALUES ('22222222-2222-2222-2222-222222222222', '  ', 'Nguyen')
$$, 'tenant_first_name_not_blank');

SELECT assert_rejects($$
  INSERT INTO tenant (family_id, first_name, last_name)
  VALUES ('22222222-2222-2222-2222-222222222222', 'Blank', '  ')
$$, 'tenant_last_name_not_blank');

-- Agent email uniqueness is case-insensitive (citext).
SELECT assert_rejects($$
  INSERT INTO agent (first_name, last_name, email, mobile_number)
  VALUES ('Ada', 'Duplicate', 'ADA@EXAMPLE.COM', '+61412345672')
$$, 'agent_email_key');

-- ---------------------------------------------------------------------------
-- Leave no trace.
-- ---------------------------------------------------------------------------
ROLLBACK;

\echo ''
\echo 'All data model assertions passed.'

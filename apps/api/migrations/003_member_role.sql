-- SENTRA-3: memberships gain the `member` role. Existing rows are all `admin`, so no backfill.
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin', 'member'));

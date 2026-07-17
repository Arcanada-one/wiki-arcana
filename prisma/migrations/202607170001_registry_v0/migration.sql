CREATE TYPE "isolation_mode" AS ENUM ('linked', 'compartmented');
CREATE TYPE "subject_type" AS ENUM ('user', 'role');
CREATE TYPE "grant_effect" AS ENUM ('allow', 'deny');
CREATE TYPE "capability" AS ENUM ('read', 'write', 'admin');

CREATE TABLE "access_levels" (
  "slug" text PRIMARY KEY,
  "ordinal" integer NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "description" text NOT NULL
);

CREATE TABLE "knowledge_spaces" (
  "id" uuid PRIMARY KEY,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "parent_id" uuid REFERENCES "knowledge_spaces"("id") ON DELETE RESTRICT,
  "required_level" text NOT NULL REFERENCES "access_levels"("slug") ON DELETE RESTRICT,
  "isolation_mode" "isolation_mode" NOT NULL DEFAULT 'linked',
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_spaces_no_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

CREATE TABLE "space_closure" (
  "ancestor_id" uuid NOT NULL REFERENCES "knowledge_spaces"("id") ON DELETE CASCADE,
  "descendant_id" uuid NOT NULL REFERENCES "knowledge_spaces"("id") ON DELETE CASCADE,
  "depth" integer NOT NULL CHECK ("depth" >= 0),
  PRIMARY KEY ("ancestor_id", "descendant_id")
);

CREATE TABLE "space_grants" (
  "id" uuid PRIMARY KEY,
  "space_id" uuid NOT NULL REFERENCES "knowledge_spaces"("id") ON DELETE CASCADE,
  "subject_type" "subject_type" NOT NULL,
  "subject_id" text NOT NULL CHECK (length("subject_id") > 0),
  "effect" "grant_effect" NOT NULL,
  "capability" "capability" NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE ("space_id", "subject_type", "subject_id", "effect", "capability")
);

CREATE TABLE "effective_permissions" (
  "space_id" uuid NOT NULL REFERENCES "knowledge_spaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "capability" "capability" NOT NULL,
  PRIMARY KEY ("space_id", "subject_id", "capability")
);

CREATE INDEX "space_closure_descendant_idx" ON "space_closure"("descendant_id", "ancestor_id");
CREATE INDEX "space_grants_subject_idx" ON "space_grants"("subject_id", "capability", "effect");
CREATE INDEX "effective_permissions_subject_idx" ON "effective_permissions"("subject_id", "capability", "space_id");

CREATE FUNCTION "rebuild_space_closure"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE walk AS (
      SELECT id AS origin, parent_id, ARRAY[id] AS path, false AS cycle FROM knowledge_spaces
      UNION ALL
      SELECT walk.origin, parent.parent_id, walk.path || parent.id, parent.id = ANY(walk.path)
      FROM walk JOIN knowledge_spaces parent ON parent.id = walk.parent_id
      WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle LIMIT 1
  ) THEN
    RAISE EXCEPTION 'knowledge space hierarchy contains a cycle';
  END IF;

  DELETE FROM space_closure;
  INSERT INTO space_closure (ancestor_id, descendant_id, depth)
  WITH RECURSIVE closure(ancestor_id, descendant_id, depth) AS (
    SELECT id, id, 0 FROM knowledge_spaces
    UNION ALL
    SELECT parent.parent_id, closure.descendant_id, closure.depth + 1
    FROM closure JOIN knowledge_spaces parent ON parent.id = closure.ancestor_id
    WHERE parent.parent_id IS NOT NULL
  ) SELECT * FROM closure;
END;
$$;

CREATE FUNCTION "recompute_effective_permissions"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM effective_permissions;
  INSERT INTO effective_permissions (space_id, subject_id, capability)
  SELECT target.descendant_id, granted.subject_id, granted.capability
  FROM space_grants granted
  JOIN space_closure target ON target.ancestor_id = granted.space_id
  WHERE granted.effect = 'allow'
    AND NOT EXISTS (
      SELECT 1 FROM space_grants denied
      JOIN space_closure denied_scope ON denied_scope.ancestor_id = denied.space_id
      WHERE denied_scope.descendant_id = target.descendant_id
        AND denied.subject_id = granted.subject_id
        AND denied.capability = granted.capability
        AND denied.effect = 'deny'
    )
  GROUP BY target.descendant_id, granted.subject_id, granted.capability;
END;
$$;

CREATE FUNCTION "spaces_after_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rebuild_space_closure();
  PERFORM recompute_effective_permissions();
  RETURN NULL;
END;
$$;

CREATE FUNCTION "grants_after_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_effective_permissions();
  RETURN NULL;
END;
$$;

CREATE TRIGGER "knowledge_spaces_recompute" AFTER INSERT OR UPDATE OF parent_id OR DELETE ON "knowledge_spaces"
FOR EACH STATEMENT EXECUTE FUNCTION "spaces_after_mutation"();
CREATE TRIGGER "space_grants_recompute" AFTER INSERT OR UPDATE OR DELETE ON "space_grants"
FOR EACH STATEMENT EXECUTE FUNCTION "grants_after_mutation"();

INSERT INTO "access_levels" ("slug", "ordinal", "display_name", "description") VALUES
  ('public', 0, 'Public', 'Open knowledge spaces'),
  ('archivist', 10, 'Archivist', 'Curated operational knowledge'),
  ('council', 20, 'Council', 'Council-restricted knowledge'),
  ('holocron', 30, 'Hidden Holocron', 'Highest-clearance compartment');

INSERT INTO "knowledge_spaces" ("id", "slug", "name", "description", "required_level", "isolation_mode")
VALUES ('01981c60-0000-7000-8000-000000000001', 'arcanada', 'Arcanada', 'Root knowledge space', 'public', 'linked');

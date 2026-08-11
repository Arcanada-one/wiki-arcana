CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "age";

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'wiki_arcana_runtime'
      AND rolcanlogin
  ) THEN
    RAISE EXCEPTION 'pre-provisioned LOGIN role wiki_arcana_runtime is required';
  END IF;
END
$migration$;

ALTER ROLE wiki_arcana_runtime
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- Keep application relations and trigger functions in public. AGE is still
-- available explicitly through ag_catalog and the runtime role gets its own
-- AGE-first search_path below after all migration DDL is complete.
SET search_path = public, ag_catalog, "$user";

SELECT ag_catalog.create_graph('wiki_arcana')
WHERE NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'wiki_arcana');
SELECT ag_catalog.create_vlabel('wiki_arcana', 'KnowledgeNode');
SELECT ag_catalog.create_elabel('wiki_arcana', 'KNOWLEDGE_EDGE');

CREATE TABLE "knowledge_nodes" (
  "id" uuid PRIMARY KEY,
  "space_id" uuid NOT NULL REFERENCES "knowledge_spaces"("id") ON DELETE RESTRICT,
  "properties" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE ("space_id", "id")
);

CREATE TABLE "knowledge_edges" (
  "id" uuid PRIMARY KEY,
  "space_id" uuid NOT NULL REFERENCES "knowledge_spaces"("id") ON DELETE RESTRICT,
  "source_node_id" uuid NOT NULL,
  "target_node_id" uuid NOT NULL,
  "edge_type" text NOT NULL CHECK (length("edge_type") BETWEEN 1 AND 128),
  "properties" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY ("space_id", "source_node_id") REFERENCES "knowledge_nodes"("space_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("target_node_id") REFERENCES "knowledge_nodes"("id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_edges_distinct_nodes" CHECK ("source_node_id" <> "target_node_id"),
  UNIQUE ("space_id", "source_node_id", "target_node_id", "edge_type")
);

CREATE TABLE "knowledge_vectors" (
  "node_id" uuid PRIMARY KEY,
  "space_id" uuid NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY ("space_id", "node_id") REFERENCES "knowledge_nodes"("space_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "knowledge_nodes_space_idx" ON "knowledge_nodes" ("space_id", "id");
CREATE INDEX "knowledge_edges_source_idx" ON "knowledge_edges" ("space_id", "source_node_id");
CREATE INDEX "knowledge_edges_target_idx" ON "knowledge_edges" ("space_id", "target_node_id");
CREATE INDEX "knowledge_vectors_space_idx" ON "knowledge_vectors" ("space_id", "node_id");
CREATE INDEX "knowledge_vectors_embedding_hnsw_idx"
  ON "knowledge_vectors" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE FUNCTION "validate_knowledge_edge_spaces"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_space_id uuid;
  target_space_id uuid;
  source_isolation_mode text;
BEGIN
  SELECT source.space_id, source_space.isolation_mode::text
  INTO source_space_id, source_isolation_mode
  FROM public.knowledge_nodes AS source
  JOIN public.knowledge_spaces AS source_space ON source_space.id = source.space_id
  WHERE source.id = NEW.source_node_id;

  IF source_space_id IS NULL OR source_space_id <> NEW.space_id THEN
    RAISE EXCEPTION 'edge source must belong to the edge space';
  END IF;

  SELECT target.space_id
  INTO target_space_id
  FROM public.knowledge_nodes AS target
  WHERE target.id = NEW.target_node_id;

  IF target_space_id IS NULL THEN
    RAISE EXCEPTION 'edge target node does not exist';
  END IF;

  IF target_space_id <> source_space_id AND source_isolation_mode <> 'linked' THEN
    RAISE EXCEPTION 'cross-space edge target requires a linked source space';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_edges_validate_spaces"
BEFORE INSERT OR UPDATE ON "knowledge_edges"
FOR EACH ROW EXECUTE FUNCTION "validate_knowledge_edge_spaces"();

CREATE FUNCTION "lock_space_grant_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  lock_space_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.space_id::text, 0));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(OLD.space_id::text, 0));
    RETURN OLD;
  END IF;

  IF OLD.space_id <> NEW.space_id THEN
    FOR lock_space_id IN
      SELECT candidate.space_id
      FROM (VALUES (OLD.space_id), (NEW.space_id)) AS candidate(space_id)
      ORDER BY candidate.space_id
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lock_space_id::text, 0));
    END LOOP;
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.space_id::text, 0));
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "space_grants_lock_mutation"
BEFORE INSERT OR UPDATE OR DELETE ON "space_grants"
FOR EACH ROW EXECUTE FUNCTION "lock_space_grant_mutation"();

REVOKE EXECUTE ON FUNCTION "validate_knowledge_edge_spaces"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lock_space_grant_mutation"() FROM PUBLIC;

DO $settings$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET session_preload_libraries = %L',
    current_database(),
    'age'
  );
  EXECUTE format(
    'ALTER ROLE wiki_arcana_runtime IN DATABASE %I SET search_path TO ag_catalog, "$user", public',
    current_database()
  );
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wiki_arcana_runtime', current_database());
END
$settings$;

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;

GRANT USAGE ON SCHEMA public, ag_catalog, wiki_arcana TO wiki_arcana_runtime;
GRANT SELECT ON "knowledge_spaces", "access_levels", "space_grants", "effective_permissions", "space_closure"
  TO wiki_arcana_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_nodes", "knowledge_edges", "knowledge_vectors"
  TO wiki_arcana_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wiki_arcana
  TO wiki_arcana_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA wiki_arcana TO wiki_arcana_runtime;
GRANT EXECUTE ON FUNCTION ag_catalog.cypher(name, cstring, agtype)
  TO wiki_arcana_runtime;

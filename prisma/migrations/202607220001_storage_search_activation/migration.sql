CREATE TABLE "knowledge_vector_projections" (
  "node_id" uuid PRIMARY KEY,
  "space_id" uuid NOT NULL,
  "embedding" halfvec(1024) NOT NULL,
  FOREIGN KEY ("node_id") REFERENCES "knowledge_vectors"("node_id") ON DELETE RESTRICT
);

ALTER TABLE "knowledge_vector_projections"
  ALTER COLUMN "embedding" SET STORAGE PLAIN;

CREATE FUNCTION "sync_knowledge_vector_projection"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.knowledge_vector_projections (node_id, space_id, embedding)
  VALUES (NEW.node_id, NEW.space_id, NEW.embedding::halfvec(1024))
  ON CONFLICT (node_id) DO UPDATE
  SET space_id = EXCLUDED.space_id, embedding = EXCLUDED.embedding;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "delete_knowledge_vector_projection"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.knowledge_vector_projections WHERE node_id = OLD.node_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON "knowledge_vector_projections" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "sync_knowledge_vector_projection"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "delete_knowledge_vector_projection"() FROM PUBLIC;

CREATE TRIGGER "knowledge_vectors_sync_projection"
AFTER INSERT OR UPDATE OF "space_id", "embedding" ON "knowledge_vectors"
FOR EACH ROW EXECUTE FUNCTION "sync_knowledge_vector_projection"();

CREATE TRIGGER "knowledge_vectors_delete_projection"
BEFORE DELETE ON "knowledge_vectors"
FOR EACH ROW EXECUTE FUNCTION "delete_knowledge_vector_projection"();

INSERT INTO "knowledge_vector_projections" ("node_id", "space_id", "embedding")
SELECT "node_id", "space_id", "embedding"::halfvec(1024)
FROM "knowledge_vectors"
ON CONFLICT ("node_id") DO UPDATE
SET "space_id" = EXCLUDED."space_id", "embedding" = EXCLUDED."embedding";

CREATE INDEX "knowledge_vector_projections_space_idx"
  ON "knowledge_vector_projections" ("space_id");
CREATE INDEX "knowledge_vector_projections_ivfflat_idx"
  ON "knowledge_vector_projections"
  USING ivfflat ("embedding" halfvec_cosine_ops)
  WITH (lists = 100);
CREATE INDEX "knowledge_edges_source_node_idx"
  ON "knowledge_edges" ("source_node_id");

GRANT SELECT ON "knowledge_vector_projections" TO wiki_arcana_runtime;

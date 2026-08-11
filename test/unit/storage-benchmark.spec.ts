import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, readFile, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeAgtype } from '../../src/storage/adapters/age/agtype.decoder.js';
import { VECTOR_SEARCH_SETTINGS } from '../../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import type { AccessContext } from '../../src/storage/ports/access-context.js';
import {
  BENCHMARK_CONTRACT,
  BENCHMARK_AGE_SEARCH_PATH_SQL,
  BENCHMARK_EFFECTIVE_SETTINGS,
  DEFAULT_DATASET_CONFIG,
  ANN_SEARCH_SETTINGS,
  EXACT_GROUND_TRUTH_SETTINGS,
  EMPTY_RESULT_HASH,
  PROJECTION_REINDEX_SQL,
  SEED_BATCH_ROWS,
  assertAgeSeedLookupIndexAbsent,
  assertAuthoritativeGate,
  assertSecretFilePermissions,
  authoritativeCommandArgv,
  buildPreparedManifest,
  benchmarkTransaction,
  canonicalSha256,
  canonicalJson,
  checkEveryDecoyAcl,
  gateBApprovalPacketTemplate,
  cycleWarmupCases,
  createDatasetLayout,
  createAclCorrectnessProbes,
  createQueryManifest,
  deterministicUuid,
  expectedDatasetProof,
  generateNormalizedVector,
  hashVectorRows,
  hashFloat32Vector,
  interleaveWarmupCases,
  iterateEdges,
  iterateNodes,
  normalizeExplainPlanEvidence,
  parseCgroupMemorySample,
  parseBenchmarkArguments,
  runTransactionCases,
  runDecoyProductChecks,
  retryTransient,
  summarizeAgtypeCorpus,
  summarizeDecoyAclChecks,
  summarizeTransactionCases,
  seedDataset,
  seedQueryBudget,
  storageMigrationHash,
  timingMetric,
  assertWallClockWithinLimit,
  validateDatabaseServerIdentity,
  validateDatabaseUrlBindings,
  validateDockerTargetInspection,
  validateDockerHostInfo,
  validateExactGroundTruthPlans,
  validateHnswPlans,
  validateGitCheckoutBinding,
  validateTimedAnnHits,
  validateTimedGraphHits,
  withBenchmarkAgeClient,
  withAgeSeedLookupIndex,
  validatePreAclCandidateCounts,
  validatePreparedBundle,
  type DatasetConfig,
} from '../../scripts/benchmark-storage.js';

const smallConfig: DatasetConfig = {
  ...DEFAULT_DATASET_CONFIG,
  targetSpaceSizes: [60, 60, 60, 60],
  deniedSpaceCount: 3,
  deniedSpaceSize: 60,
  vectorDimension: 16,
  decoyReplacementsPerTarget: 2,
  traversalDistributions: [
    [2, 1, 1, 1],
    [1, 2, 1, 1],
    [1, 1, 2, 1],
    [1, 1, 1, 2],
  ],
  annQueriesPerBucket: 5,
  unauthorizedGraphQueries: 4,
  unauthorizedVectorQueries: 6,
};

const datasetProof = {
  counts: { spaces: 7, grants: 4, effectivePermissions: 4, relationalNodes: 420, relationalEdges: 1_260, vectors: 420, ageNodes: 420, ageEdges: 1_260 },
  hashes: { spaces: '1', grants: '2', effectivePermissions: '3', relationalNodes: '4', relationalEdges: '5', vectors: '6', ageNodes: '7', ageEdges: '8' },
};

function sequentialPlans(queryIds: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(queryIds.map((id) => [id, [{ Plan: {
    'Node Type': 'Seq Scan', 'Relation Name': 'knowledge_vectors',
  } }]]));
}

describe('WIKI-0002 deterministic benchmark generator', () => {
  it('binds every shipped storage migration into the benchmark digest', async () => {
    const paths = [
      join(import.meta.dirname, '../../prisma/migrations/202607200001_storage_engines/migration.sql'),
      join(import.meta.dirname, '../../prisma/migrations/202607220001_storage_search_activation/migration.sql'),
    ];
    const bytes = await Promise.all(paths.map((path) => readFile(path)));
    const expected = createHash('sha256').update(Buffer.concat(bytes)).digest('hex');
    await expect(storageMigrationHash()).resolves.toBe(expected);
  });

  it('surfaces the underlying entrypoint error instead of replacing it with a generic failure', () => {
    const result = spawnSync('pnpm', [
      'exec', 'tsx', join(import.meta.dirname, '../../scripts/benchmark-storage.ts'), '--mode', 'INVALID',
    ], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid benchmark mode');
  });

  it('wires all Phase-4 commands directly to the owned scripts', async () => {
    const packageJson = JSON.parse(await readFile(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      'storage:prepare': expect.stringContaining('benchmark-storage.ts --mode PREPARE'),
      'storage:seed': expect.stringContaining('benchmark-storage.ts --mode SEED'),
      'storage:benchmark': expect.stringContaining('benchmark-storage.ts --mode AUTHORITATIVE'),
      'storage:verdict': expect.stringContaining('verify-storage-benchmark.ts'),
    });
  });

  it('schema-qualifies every AGE parameter cast and result type on shipped SQL surfaces', async () => {
    const paths = [
      join(import.meta.dirname, '../../scripts/benchmark-storage.ts'),
      join(import.meta.dirname, '../../src/storage/adapters/age/age-graph.adapter.ts'),
    ];
    for (const path of paths) {
      const source = await readFile(path, 'utf8');
      expect(source).toContain('ag_catalog.agtype');
      expect(source).not.toMatch(/::agtype\b/);
      expect(source).not.toMatch(/\b(?:node_id|space_id|node|edge|count|value)\s+agtype\b/);
    }
    const benchmark = await readFile(paths[0]!, 'utf8');
    expect(benchmark).toContain('$1::ag_catalog.agtype) AS (count ag_catalog.agtype)');
  });

  it('accepts one pnpm standalone separator without weakening strict CLI pairing', () => {
    const required = [
      '--artifacts-dir', '/tmp/wiki-artifacts',
      '--database-container', 'wiki-storage-benchmark',
      '--database-volume', 'wiki_benchmark_data',
      '--database-bind', '127.0.0.1:55433',
      '--admin-url-file', '/tmp/admin-url',
      '--runtime-url-file', '/tmp/runtime-url',
      '--commit', 'a'.repeat(40),
      '--image-digest', `sha256:${'b'.repeat(64)}`,
      '--migration-hash', 'c'.repeat(64),
      '--gate-b-evidence', '/tmp/gate.json',
      '--gate-b-token-file', '/tmp/gate.key',
    ];
    const prepared = parseBenchmarkArguments(['--mode', 'PREPARE', '--', ...required]);
    expect(prepared).toMatchObject({
      mode: 'PREPARE', artifactsDir: '/tmp/wiki-artifacts', databaseContainer: 'wiki-storage-benchmark',
    });
    expect(parseBenchmarkArguments(['--', '--mode', 'AUTHORITATIVE', ...required])).toMatchObject({
      mode: 'AUTHORITATIVE', gateEvidence: '/tmp/gate.json', gateTokenFile: '/tmp/gate.key',
    });
    const canonicalCommand = authoritativeCommandArgv({ ...prepared, mode: 'AUTHORITATIVE' }, prepared.artifactsDir);
    expect(canonicalCommand.slice(0, 3)).toEqual(['pnpm', 'storage:benchmark', '--']);
    expect(canonicalCommand.filter((argument) => argument === '--mode')).toHaveLength(0);
    const expandedRuntimeArgv = ['--mode', 'AUTHORITATIVE', ...canonicalCommand.slice(2)];
    expect(parseBenchmarkArguments(expandedRuntimeArgv))
      .toMatchObject({ mode: 'AUTHORITATIVE', artifactsDir: prepared.artifactsDir });
    expect(() => parseBenchmarkArguments(['--', '--', '--mode', 'PREPARE', ...required])).toThrow(/at most one/i);
    expect(() => parseBenchmarkArguments(['--mode', '--', ...required])).toThrow(/key value/i);
    expect(() => parseBenchmarkArguments(['--mode', 'PREPARE', '--mode', 'SEED', ...required])).toThrow(/duplicate/i);
  });

  it('freezes the authoritative scale, topology, vector, query, and threshold contract', () => {
    expect(BENCHMARK_CONTRACT).toMatchObject({
      seed: 20_260_720n,
      nodeCount: 100_000,
      edgeCount: 300_000,
      targetSpaceSizes: [50_000, 10_000, 1_000, 100],
      deniedSpaceCount: 389,
      deniedSpaceSize: 100,
      vectorDimension: 1_024,
      decoyEdges: 100,
      hnsw: { m: 16, efConstruction: 128, efSearch: 1, maxScanTuples: 20_000, scanMemMultiplier: 2 },
      timed: { warmSeconds: 30, passes: 3, concurrency: 8, p95Ms: 500, p99Ms: 1_500 },
      timeouts: { groundTruthMs: 60_000, timedQueryMs: 1_500, reindexMs: 1_200_000, wallClockMs: 7_200_000 },
      ann: { meanRecall: 0.95, minimumRecall: 0.8, fillRate: 0.99, unauthorizedHits: 0 },
      transactionCycles: 100,
      agtypeValues: 10_000,
      hnswBuildMaxMs: 1_200_000,
      databaseMaxBytes: 5 * 1_024 ** 3,
      rssMaxBytes: 8 * 1_024 ** 3,
    });
  });

  it('matches golden UUID and float32 vector outputs from the frozen SHA-256 counter expansion', () => {
    expect(deterministicUuid('ids', 0n)).toBe('d604aa2c-cf84-4910-8d8f-fd56fe548217');
    expect(deterministicUuid('ids', 1_000_000n)).toBe('903e673d-df4c-4202-82d1-ca658c1e59e2');

    const vector = generateNormalizedVector(0, 1_024);
    expect(vector.slice(0, 8)).toEqual([
      -0.0007106090779416263,
      0.04089118912816048,
      0.0016626762226223946,
      0.007235154043883085,
      0.03527025133371353,
      0.003956214990466833,
      0.04730195924639702,
      -0.03723244369029999,
    ]);
    expect(hashFloat32Vector(vector)).toBe('c0725906d94e5c2eb4a1bd2d43b5f0fe43884281b817ba43da221f47f6575b91');
  });

  it('matches a golden canonical manifest digest independent of object key insertion order', () => {
    const manifest = {
      version: 'wiki-storage-benchmark/v1',
      seed: '20260720',
      counts: { nodes: 100_000, edges: 300_000 },
    };
    expect(canonicalSha256(manifest)).toBe('46b5b6ee100ddd6191ba134ec7ac44ce4b032a114b0c964c4f3e58bbff69321f');
    expect(canonicalSha256({ counts: manifest.counts, seed: manifest.seed, version: manifest.version }))
      .toBe(canonicalSha256(manifest));
  });

  it('normalizes only run-varying EXPLAIN evidence before plan and manifest hashing', () => {
    const first = [{
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'knowledge_vectors',
        'Actual Startup Time': 0.01,
        'Actual Total Time': 4.2,
        'Actual Rows': 10,
        'Shared Hit Blocks': 99,
        'Total Cost': 123.45,
        'Workers Launched': 2,
        'Disk Usage': 64,
      },
      'Planning Time': 0.3,
      'Execution Time': 4.5,
    }];
    const second = [{
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'knowledge_vectors',
        'Actual Startup Time': 0.03,
        'Actual Total Time': 7.8,
        'Actual Rows': 10,
        'Shared Hit Blocks': 0,
        'Total Cost': 124.1,
        'Workers Launched': 0,
        'Disk Usage': 128,
      },
      'Planning Time': 0.8,
      'Execution Time': 8.1,
    }];
    expect(canonicalSha256(normalizeExplainPlanEvidence(first)))
      .toBe(canonicalSha256(normalizeExplainPlanEvidence(second)));
    const differentRelation = structuredClone(second);
    differentRelation[0]!.Plan['Relation Name'] = 'other_vectors';
    expect(canonicalSha256(normalizeExplainPlanEvidence(first)))
      .not.toBe(canonicalSha256(normalizeExplainPlanEvidence(differentRelation)));
  });

  it('builds and validates a cryptographically bound canonical manifest including empty unauthorized hashes', () => {
    const layout = createDatasetLayout(smallConfig);
    const queries = createQueryManifest(layout);
    const allQueries = [...queries.traversal, ...queries.ann, ...queries.unauthorizedGraph, ...queries.unauthorizedVector];
    const truth = allQueries.map((query) => ({ queryId: query.id, resultIds: [], resultHash: EMPTY_RESULT_HASH }));
    const plans = sequentialPlans(allQueries.map((query) => query.id));
    const bindings = { commit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`, migrationHash: 'c'.repeat(64) };
    const manifest = buildPreparedManifest(layout, queries, truth, bindings, plans, datasetProof);

    expect(Object.keys(manifest)).toEqual([
      'version', 'seed', 'generator', 'counts', 'topology', 'vectorDimension', 'spaceGrants', 'aclScenarios', 'queryIds',
      'exactResultHashes', 'queryManifestSha256', 'groundTruthSha256', 'groundTruthPlansSha256',
      'datasetProof', 'bindings', 'manifestSha256',
    ]);
    expect(manifest).toMatchObject({
      version: 'wiki-storage-benchmark/v1',
      seed: '20260720',
      generator: 'node24-sha256-counter-box-muller-float32-v1',
      counts: { spaces: 7, nodes: 420, edges: 1_260, vectors: 420 },
      topology: { jumps: [1, 7, 37], decoyReplacementsPerTarget: 2, decoyEdges: 8 },
      vectorDimension: 16,
      bindings,
      queryManifestSha256: canonicalSha256(queries),
      groundTruthSha256: canonicalSha256(truth),
      groundTruthPlansSha256: canonicalSha256(normalizeExplainPlanEvidence(plans)),
      datasetProof,
    });
    expect(manifest.exactResultHashes).toHaveLength(50);
    expect(manifest.spaceGrants).toEqual(layout.grants.map((grant) => ({ ...grant, capability: 'read' })));
    expect(manifest.aclScenarios).toEqual(allQueries.map((query) => ({
      queryId: query.id, scenarioId: query.aclScenarioId, contextSha256: query.contextSha256,
    })));
    expect(manifest.queryIds).toEqual({
      traversal: queries.traversal.map((query) => query.id), ann: queries.ann.map((query) => query.id),
      unauthorizedGraph: queries.unauthorizedGraph.map((query) => query.id),
      unauthorizedVector: queries.unauthorizedVector.map((query) => query.id),
    });
    expect(manifest.exactResultHashes).toEqual(truth.map((record) => ({ queryId: record.queryId, resultHash: record.resultHash })));
    expect(manifest.exactResultHashes.slice(-10).every((entry) => entry.resultHash === EMPTY_RESULT_HASH)).toBe(true);
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validatePreparedBundle(manifest, queries, truth, plans, datasetProof, bindings)).not.toThrow();
  });

  it('rejects sidecar duplication, omission, tampering, and CLI relabeling', () => {
    const layout = createDatasetLayout(smallConfig);
    const queries = createQueryManifest(layout);
    const allQueries = [...queries.traversal, ...queries.ann, ...queries.unauthorizedGraph, ...queries.unauthorizedVector];
    const truth = allQueries.map((query) => ({ queryId: query.id, resultIds: [], resultHash: EMPTY_RESULT_HASH }));
    const plans = sequentialPlans(allQueries.map((query) => query.id));
    const bindings = { commit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`, migrationHash: 'c'.repeat(64) };
    const manifest = buildPreparedManifest(layout, queries, truth, bindings, plans, datasetProof);
    const duplicated = { ...queries, traversal: [...queries.traversal, queries.traversal[0]!] };

    expect(() => validatePreparedBundle(manifest, duplicated, truth, plans, datasetProof, bindings)).toThrow(/quer/i);
    expect(() => validatePreparedBundle(manifest, queries, truth.slice(1), plans, datasetProof, bindings)).toThrow(/ground|result/i);
    expect(() => validatePreparedBundle(manifest, queries, [{ ...truth[0]!, resultHash: 'd'.repeat(64) }, ...truth.slice(1)], plans, datasetProof, bindings)).toThrow(/ground|result/i);
    expect(() => validatePreparedBundle(manifest, queries, truth, plans, datasetProof, { ...bindings, commit: 'e'.repeat(40) })).toThrow(/commit/i);
    expect(() => validatePreparedBundle(manifest, queries, truth, plans, {
      ...datasetProof, hashes: { ...datasetProof.hashes, ageEdges: 'tampered' },
    }, bindings)).toThrow(/dataset proof/i);
    const missingPlan = { ...plans };
    delete missingPlan[allQueries[0]!.id];
    expect(() => validateExactGroundTruthPlans(missingPlan, queries)).toThrow(/every query/i);
    const hnswPlans = { ...plans, [queries.ann[0]!.id]: [{ Plan: { 'Index Name': 'knowledge_vectors_embedding_hnsw_idx' } }] };
    expect(() => validateExactGroundTruthPlans(hnswPlans, queries)).toThrow(/sequential|HNSW/i);
    const unauthorizedId = queries.unauthorizedGraph[0]!.id;
    const leakedTruth = truth.map((record) => record.queryId === unauthorizedId
      ? { ...record, resultIds: ['denied'], resultHash: canonicalSha256(['denied']) } : record);
    expect(() => validatePreparedBundle(buildPreparedManifest(layout, queries, leakedTruth, bindings, plans, datasetProof), queries, leakedTruth, plans, datasetProof, bindings))
      .toThrow(/unauthorized/i);

    const easierQueries = { ...queries, traversal: queries.traversal.slice(1) };
    const easierTruth = truth.filter((record) => record.queryId !== queries.traversal[0]!.id);
    const easierPlans = sequentialPlans(easierTruth.map((record) => record.queryId));
    const easierManifest = buildPreparedManifest(layout, easierQueries, easierTruth, bindings, easierPlans, datasetProof);
    expect(() => validatePreparedBundle(easierManifest, easierQueries, easierTruth, easierPlans, datasetProof, bindings, layout)).toThrow(/workload|query/i);
  });

  it('generates exact full-scale counts without allocating the vector corpus', () => {
    const layout = createDatasetLayout(DEFAULT_DATASET_CONFIG);
    expect(layout.spaces).toHaveLength(393);
    expect(layout.spaces.filter((space) => space.target)).toHaveLength(4);
    expect(layout.nodeCount).toBe(100_000);
    expect([...iterateNodes(layout)].length).toBe(100_000);

    let edgeCount = 0;
    let decoyCount = 0;
    for (const edge of iterateEdges(layout)) {
      edgeCount += 1;
      if (edge.decoy) decoyCount += 1;
    }
    expect(edgeCount).toBe(300_000);
    expect(decoyCount).toBe(100);
  });

  it('defines the full global table universe including only the registry baselines', () => {
    const layout = createDatasetLayout(smallConfig);
    const proof = expectedDatasetProof(layout, 'vector-hash');
    expect(proof.counts).toMatchObject({
      spaces: layout.spaces.length + 1,
      accessLevels: 4,
      closure: layout.spaces.length + 1,
      grants: layout.grants.length,
      relationalNodes: layout.nodeCount,
      relationalEdges: layout.edgeCount,
      vectors: layout.nodeCount,
    });
    expect(Object.keys(proof.hashes).sort()).toEqual(Object.keys(proof.counts).sort());
  });

  it('generates the exact full-scale query distribution and frozen planner settings', () => {
    const queries = createQueryManifest(createDatasetLayout(DEFAULT_DATASET_CONFIG));
    expect(queries.traversal).toHaveLength(200);
    expect(queries.ann).toHaveLength(400);
    expect(queries.unauthorizedGraph).toHaveLength(20);
    expect(queries.unauthorizedVector).toHaveLength(50);
    expect([1, 2, 3, 4].map((depth) => [0, 1, 2, 3].map((bucket) =>
      queries.traversal.filter((query) => query.depth === depth && query.bucket === bucket).length)))
      .toEqual(DEFAULT_DATASET_CONFIG.traversalDistributions);
    expect([0, 1, 2, 3].map((bucket) => queries.ann.filter((query) => query.bucket === bucket).length))
      .toEqual([100, 100, 100, 100]);
    expect(EXACT_GROUND_TRUTH_SETTINGS).toEqual([
      'SET LOCAL search_path TO ag_catalog, "$user", public',
      'SET LOCAL statement_timeout = 60000',
      'SET LOCAL enable_indexscan = off',
      'SET LOCAL enable_indexonlyscan = off',
      'SET LOCAL enable_bitmapscan = off',
    ]);
    expect(ANN_SEARCH_SETTINGS).toEqual([
      'SET LOCAL jit = off',
      'SET LOCAL enable_sort = off',
      'SET LOCAL hnsw.ef_search = 1',
      'SET LOCAL ivfflat.probes = 100',
      "SET LOCAL hnsw.iterative_scan = 'strict_order'",
      'SET LOCAL hnsw.max_scan_tuples = 20000',
      'SET LOCAL hnsw.scan_mem_multiplier = 2',
    ]);
    expect(ANN_SEARCH_SETTINGS).toBe(VECTOR_SEARCH_SETTINGS);
    expect(BENCHMARK_EFFECTIVE_SETTINGS.annSearch).toMatchObject({
      jit: 'off', enableSort: 'off', efSearch: '1', ivfflatProbes: '100',
    });
  });

  it('sets the AGE-first search path transaction-locally before admin Cypher SQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await benchmarkTransaction({ query } as never, async () => {
      await query("SELECT * FROM ag_catalog.cypher('wiki_arcana', $$RETURN 1$$) AS (value ag_catalog.agtype)");
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      BENCHMARK_AGE_SEARCH_PATH_SQL,
      "SELECT * FROM ag_catalog.cypher('wiki_arcana', $$RETURN 1$$) AS (value ag_catalog.agtype)",
      'COMMIT',
    ]);
    expect(BENCHMARK_AGE_SEARCH_PATH_SQL).toBe('SET LOCAL search_path TO ag_catalog, "$user", public');
  });

  it('counts canonical seed batches, transactions, and query calls without claiming a time bound', () => {
    expect(SEED_BATCH_ROWS).toEqual({ nodes: 2_500, edges: 2_500, vectors: 1_000 });
    expect(seedQueryBudget(DEFAULT_DATASET_CONFIG)).toEqual({
      nodes: 40,
      edges: 120,
      vectors: 100,
      batchTransactions: 261,
      indexLifecycleStatements: 6,
      queryCalls: 1_214,
    });
    expect(SEED_BATCH_ROWS.edges * 6).toBeLessThan(32_768);
  });

  it('binds the optimized batches and transient index helper to the real seed path', async () => {
    const layout = createDatasetLayout(smallConfig);
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT to_regclass') ? [{ exists: false }] : [],
      rowCount: 0,
    }));
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await seedDataset(pool as never, layout, process.hrtime.bigint());

    const sql = query.mock.calls.map(([statement]) => statement);
    expect(sql.filter((statement) => statement.startsWith('INSERT INTO knowledge_nodes'))).toHaveLength(1);
    expect(sql.filter((statement) => statement.startsWith('INSERT INTO knowledge_edges'))).toHaveLength(1);
    expect(sql.filter((statement) => statement.startsWith('INSERT INTO knowledge_vectors'))).toHaveLength(1);
    expect(sql.filter((statement) => statement.startsWith('CREATE INDEX "wiki_benchmark_seed'))).toHaveLength(1);
    expect(sql.filter((statement) => statement.startsWith('DROP INDEX IF EXISTS wiki_arcana."wiki_benchmark_seed'))).toHaveLength(2);
    expect(sql.filter((statement) => statement === PROJECTION_REINDEX_SQL)).toHaveLength(1);
    expect(sql.filter((statement) => statement === 'BEGIN')).toHaveLength(4);
    expect(release).toHaveBeenCalledOnce();
  });

  it('always removes the setup-only AGE lookup index before measurement', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT to_regclass') ? [{ exists: false }] : [],
      rowCount: 0,
    }));
    await withAgeSeedLookupIndex({ query } as never, async () => {
      await query('SELECT seed_edges()');
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'DROP INDEX IF EXISTS wiki_arcana."wiki_benchmark_seed_node_properties_gin_idx"',
      "SELECT to_regclass('wiki_arcana.wiki_benchmark_seed_node_properties_gin_idx') IS NOT NULL AS \"exists\"",
      'CREATE INDEX "wiki_benchmark_seed_node_properties_gin_idx" ON wiki_arcana."KnowledgeNode" USING gin (properties)',
      'SELECT seed_edges()',
      'DROP INDEX IF EXISTS wiki_arcana."wiki_benchmark_seed_node_properties_gin_idx"',
      "SELECT to_regclass('wiki_arcana.wiki_benchmark_seed_node_properties_gin_idx') IS NOT NULL AS \"exists\"",
    ]);

    query.mockClear();
    await expect(withAgeSeedLookupIndex({ query } as never, async () => {
      throw new Error('seed failure');
    })).rejects.toThrow('seed failure');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'DROP INDEX IF EXISTS wiki_arcana."wiki_benchmark_seed_node_properties_gin_idx"',
      "SELECT to_regclass('wiki_arcana.wiki_benchmark_seed_node_properties_gin_idx') IS NOT NULL AS \"exists\"",
      'CREATE INDEX "wiki_benchmark_seed_node_properties_gin_idx" ON wiki_arcana."KnowledgeNode" USING gin (properties)',
      'DROP INDEX IF EXISTS wiki_arcana."wiki_benchmark_seed_node_properties_gin_idx"',
      "SELECT to_regclass('wiki_arcana.wiki_benchmark_seed_node_properties_gin_idx') IS NOT NULL AS \"exists\"",
    ]);
  });

  it('fails closed when the setup-only AGE index is present', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }], rowCount: 1 });
    await expect(assertAgeSeedLookupIndexAbsent({ query } as never)).rejects.toThrow(
      'setup-only AGE lookup index must be absent before measurement',
    );
  });

  it('cleans up after CREATE failure and preserves both seed and cleanup failures', async () => {
    let drops = 0;
    const createFailureQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('DROP INDEX')) drops += 1;
      if (sql.startsWith('CREATE INDEX')) throw new Error('create failure');
      return { rows: sql.startsWith('SELECT to_regclass') ? [{ exists: false }] : [], rowCount: 0 };
    });
    await expect(withAgeSeedLookupIndex({ query: createFailureQuery } as never, async () => undefined))
      .rejects.toThrow('create failure');
    expect(drops).toBe(2);

    drops = 0;
    const cleanupFailureQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('DROP INDEX') && ++drops === 2) throw new Error('cleanup failure');
      return { rows: sql.startsWith('SELECT to_regclass') ? [{ exists: false }] : [], rowCount: 0 };
    });
    let failure: unknown;
    try {
      await withAgeSeedLookupIndex({ query: cleanupFailureQuery } as never, async () => {
        throw new Error('seed failure');
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(['seed failure', 'cleanup failure']);
  });

  it('keeps a checked-out AGE client local through rollback and always releases it', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const release = vi.fn();
    const client = { query, release };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    await expect(withBenchmarkAgeClient(pool as never, async (checkedOut) => {
      await checkedOut.query("SELECT * FROM ag_catalog.cypher('wiki_arcana', $$RETURN 1$$) AS (value ag_catalog.agtype)");
      throw new Error('corpus failure');
    })).rejects.toThrow('corpus failure');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      BENCHMARK_AGE_SEARCH_PATH_SQL,
      "SELECT * FROM ag_catalog.cypher('wiki_arcana', $$RETURN 1$$) AS (value ag_catalog.agtype)",
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('qualifies the transaction cleanup identifier instead of reusing the node id property name', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT INTO knowledge_nodes')) throw new Error('probe failure');
      return { rows: [], rowCount: 0 };
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(runTransactionCases(pool as never, createDatasetLayout(smallConfig))).rejects.toThrow('probe failure');
    const cleanupSql = query.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('DETACH DELETE node'));
    expect(cleanupSql).toHaveLength(2);
    expect(cleanupSql.every((sql) => sql.includes(
      'UNWIND $ids AS probe_id MATCH (node:KnowledgeNode {id: probe_id}) DETACH DELETE node RETURN count(node)',
    ))).toBe(true);
    expect(cleanupSql.every((sql) => !sql.includes(
      'UNWIND $ids AS id MATCH (node:KnowledgeNode {id: id}) DETACH DELETE node RETURN count(node)',
    ))).toBe(true);
  });

  it('releases the transaction probe client even when final cleanup throws', async () => {
    let cleanupCalls = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('DETACH DELETE node')) {
        cleanupCalls += 1;
        if (cleanupCalls === 2) throw new Error('cleanup failure');
      }
      if (sql.startsWith('INSERT INTO knowledge_nodes')) throw new Error('probe failure');
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(runTransactionCases(pool as never, createDatasetLayout(smallConfig))).rejects.toThrow('cleanup failure');
    expect(cleanupCalls).toBe(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves +1/+7/+37 topology except for the exact per-target denied decoys on a small seam', () => {
    const layout = createDatasetLayout(smallConfig);
    const nodes = [...iterateNodes(layout)];
    const nodeSpace = new Map(nodes.map((node) => [node.id, node.spaceId]));
    const edges = [...iterateEdges(layout)];

    expect(nodes).toHaveLength(420);
    expect(edges).toHaveLength(1_260);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(edges.filter((edge) => edge.decoy)).toHaveLength(8);
    for (const target of layout.spaces.filter((space) => space.target)) {
      expect(edges.filter((edge) => edge.spaceId === target.id && edge.decoy)).toHaveLength(2);
    }
    for (const edge of edges) {
      expect(nodeSpace.get(edge.sourceNodeId)).toBe(edge.spaceId);
      if (edge.decoy) expect(nodeSpace.get(edge.targetNodeId)).not.toBe(edge.spaceId);
      else expect(nodeSpace.get(edge.targetNodeId)).toBe(edge.spaceId);
      expect(edge.decoy ? edge.jump === 37 : [1, 7, 37].includes(edge.jump)).toBe(true);
      if (!edge.decoy) {
        const source = nodes.find((node) => node.id === edge.sourceNodeId)!;
        const target = nodes.find((node) => node.id === edge.targetNodeId)!;
        expect(target.localIndex).toBe((source.localIndex + edge.jump) % 60);
      }
    }
  });

  it('runs every full-scale decoy check through the product graph adapter with query-specific ACL context', async () => {
    const layout = createDatasetLayout(DEFAULT_DATASET_CONFIG);
    const traverse = vi.fn(async (_context: AccessContext, _specification: { startNodeId: string; maxDepth: number }) => [{
      id: '00000000-0000-4000-8000-000000000099',
      spaceId: layout.spaces.find((space) => space.target)!.id,
    }]);
    const checks = await runDecoyProductChecks({ traverse }, layout);
    expect(checks).toHaveLength(100);
    expect(traverse).toHaveBeenCalledTimes(100);
    expect(traverse.mock.calls.every(([, specification]) => specification.maxDepth === 1)).toBe(true);
    expect(checks.every((check) => check.context.level === 0
      && check.context.spaceGrants.allow.length === 1
      && check.context.spaceGrants.deny.length === 1
      && check.context.spaceGrants.allow[0]!.spaceId !== check.context.spaceGrants.deny[0]!.spaceId)).toBe(true);
    expect(new Set(checks.map((check) => check.context.spaceGrants.deny[0]!.spaceId)).size).toBeGreaterThan(1);
  });

  it('does not reserve the only runtime-pool client while running all product decoy checks', async () => {
    const layout = createDatasetLayout(DEFAULT_DATASET_CONFIG);
    let held = false;
    const connect = vi.fn(async () => {
      if (held) throw new Error('max=1 pool would deadlock on re-entrant connect');
      held = true;
      return {
        query: vi.fn(async (statement: string, values?: readonly unknown[]) => {
          if (statement.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [] }] };
          if (statement.includes(' AS id FROM ')) return { rows: [{ id: values?.[0] }] };
          return { rows: [] };
        }),
        release: vi.fn(() => {
          held = false;
        }),
      };
    });
    const traverse = vi.fn(async (_context: AccessContext, specification: { startNodeId: string }) => {
      const client = await connect();
      client.release();
      return [{ id: specification.startNodeId, spaceId: layout.spaces[0]!.id }];
    });

    const result = await checkEveryDecoyAcl(
      { connect } as never, { traverse } as never, layout, process.hrtime.bigint(),
    );

    expect(traverse).toHaveBeenCalledTimes(100);
    expect(result).toMatchObject({ checked: 100, productCalls: 100, allowedRoots: 100, deniedOutputs: 0 });
  });

  it('builds the frozen traversal buckets and unique ANN sources while excluding every ANN source', () => {
    const layout = createDatasetLayout(smallConfig);
    const queries = createQueryManifest(layout);

    expect(queries.traversal).toHaveLength(20);
    expect(queries.traversal.map((query) => query.depth).sort()).toEqual([
      1, 1, 1, 1, 1,
      2, 2, 2, 2, 2,
      3, 3, 3, 3, 3,
      4, 4, 4, 4, 4,
    ]);
    expect(queries.traversal.filter((query) => query.depth === 1).map((query) => query.bucket))
      .toEqual([0, 0, 1, 2, 3]);
    expect(queries.ann).toHaveLength(20);
    expect(new Set(queries.ann.map((query) => query.sourceNodeId)).size).toBe(20);
    expect(queries.ann.every((query) => query.excludeNodeId === query.sourceNodeId)).toBe(true);
    expect(queries.ann.every((query) => query.k === 10 && query.noiseSigma === 0.01)).toBe(true);
    expect(queries.unauthorizedGraph).toHaveLength(4);
    expect(queries.unauthorizedVector).toHaveLength(6);
    expect(queries.ann.every((query) => query.aclScenarioId === 'explicit_allow'
      && query.context.level === 0
      && query.context.spaceGrants.allow.some((grant) => grant.spaceId === query.spaceId)
      && query.context.spaceGrants.deny.length === layout.decoyDeniedSpaceIds.length)).toBe(true);
    expect(createAclCorrectnessProbes(layout).map((probe) => [probe.scenarioId, probe.expectedAuthorized])).toEqual([
      ['clearance_only', true], ['allow_below_rank', true], ['deny_override', false],
      ['neither', false], ['wrong_space', false],
    ]);
    const crossSpace = createAclCorrectnessProbes(layout).find((probe) => probe.scenarioId === 'wrong_space')!;
    expect(crossSpace.context.spaceGrants.allow[0]?.spaceId).not.toBe(crossSpace.spaceId);
    expect(queries.ann.every((query) => query.contextSha256 === canonicalSha256(query.context))).toBe(true);
    expect(new Set([...queries.unauthorizedGraph, ...queries.unauthorizedVector]
      .map((query) => query.aclScenarioId))).toEqual(new Set(['deny_override', 'neither', 'wrong_space']));
    expect(new Set([
      ...queries.traversal,
      ...queries.ann,
      ...queries.unauthorizedGraph,
      ...queries.unauthorizedVector,
    ].map((query) => query.id)).size).toBe(50);
  });

  it('requires matching Gate-B evidence and a secret token file before AUTHORITATIVE mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiki-0002-gate-'));
    const evidencePath = join(directory, 'gate.json');
    const tokenPath = join(directory, 'token');
    const token = 'unit-test-authorization-token-32-bytes-minimum';
    const gateBindings = {
      manifestSha256: 'a'.repeat(64), commit: 'b'.repeat(40), imageDigest: `sha256:${'c'.repeat(64)}`,
      migrationHash: 'd'.repeat(64), containerId: 'container-id', volume: 'benchmark-data', bind: '127.0.0.1:55433',
    };
    const commandArgv = ['pnpm', 'storage:benchmark', '--', '--mode', 'AUTHORITATIVE'];
    await writeFile(tokenPath, token, { mode: 0o600 });
    const packet = gateBApprovalPacketTemplate(gateBindings, commandArgv);
    const payload = packet.payload;
    expect(packet.hmacGeneration).toContain('After operator Gate-B approval only');
    expect(packet.hmacGeneration).toContain('separate mode-0600 key file');
    expect(packet.canonicalPayload).toBe(canonicalJson(payload));
    expect(packet.evidenceTemplate).toMatchObject({ gate: 'B', authorized: true, payload });
    expect(payload.command.sha256).toBe(canonicalSha256(commandArgv));
    const evidence = {
      gate: 'B',
      authorized: true,
      payload,
      hmacSha256: createHmac('sha256', token).update(canonicalJson(payload)).digest('hex'),
    };
    await writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o600 });

    await expect(assertAuthoritativeGate(undefined, undefined, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await expect(assertAuthoritativeGate(evidencePath, undefined, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await expect(assertAuthoritativeGate(evidencePath, tokenPath,
      { ...gateBindings, commit: 'e'.repeat(40) }, commandArgv)).rejects.toThrow(/Gate-B/i);
    await writeFile(evidencePath, JSON.stringify({ ...evidence, payload: {
      ...payload, bindings: { ...payload.bindings, commit: 'e'.repeat(40) },
    } }));
    await expect(assertAuthoritativeGate(evidencePath, tokenPath, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await writeFile(evidencePath, JSON.stringify(evidence));
    await chmod(evidencePath, 0o640);
    await expect(assertAuthoritativeGate(evidencePath, tokenPath, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await chmod(evidencePath, 0o600);
    await writeFile(tokenPath, 'short', { mode: 0o600 });
    await expect(assertAuthoritativeGate(evidencePath, tokenPath, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await writeFile(tokenPath, token, { mode: 0o600 });
    await writeFile(evidencePath, JSON.stringify({ ...evidence, hmacSha256: evidence.hmacSha256.toUpperCase() }));
    await expect(assertAuthoritativeGate(evidencePath, tokenPath, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(assertAuthoritativeGate(evidencePath, tokenPath, gateBindings, commandArgv)).resolves.toMatchObject({ gate: 'B', authorized: true });
    await expect(assertAuthoritativeGate(evidencePath, tokenPath, gateBindings, commandArgv)).rejects.toThrow(/Gate-B/i);
    await expect(readFile(`${evidencePath}.consumed`, 'utf8')).resolves.toContain(canonicalSha256(payload));
    expect((await stat(`${evidencePath}.consumed`)).mode & 0o777).toBe(0o600);
  });

  it('rejects database URL secret files readable by group or others', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiki-0002-secret-'));
    const secretPath = join(directory, 'database-url');
    await writeFile(secretPath, 'postgresql://redacted', { mode: 0o600 });
    await expect(assertSecretFilePermissions(secretPath)).resolves.toBeUndefined();
    await chmod(secretPath, 0o640);
    await expect(assertSecretFilePermissions(secretPath)).rejects.toThrow(/0600/i);
  });

  it('binds execution to an exact clean Git checkout', () => {
    const commit = 'a'.repeat(40);
    expect(validateGitCheckoutBinding(commit, { head: commit, statusPorcelain: '' })).toEqual({
      head: commit, statusPorcelain: '',
    });
    expect(() => validateGitCheckoutBinding(commit, { head: 'b'.repeat(40), statusPorcelain: '' })).toThrow(/HEAD/i);
    expect(() => validateGitCheckoutBinding(commit, { head: commit, statusPorcelain: ' M scripts/benchmark-storage.ts\n' }))
      .toThrow(/dirty|untracked/i);
    expect(() => validateGitCheckoutBinding(commit, { head: commit, statusPorcelain: '?? untracked.txt\n' }))
      .toThrow(/dirty|untracked/i);
  });

  it('uses unique cgroup v2 anon+shmem accounting and validates fixed container topology', () => {
    expect(parseCgroupMemorySample('anon 6205440\nfile 20299776\nshmem 19714048\n', '31981568\n'))
      .toEqual({ rssApproximationBytes: 25_919_488, memoryCurrentBytes: 31_981_568 });
    expect(() => parseCgroupMemorySample('anon 1\nfile 2\n', '3\n')).toThrow(/shmem/i);
    expect(() => parseCgroupMemorySample('anon 1\nshmem nope\n', '3\n')).toThrow(/malformed|numeric/i);
    expect(validateDockerHostInfo({
      NCPU: 16, MemTotal: 32 * 1_024 ** 3, Architecture: 'x86_64', OperatingSystem: 'Linux',
      Name: 'database-host', ServerVersion: '28.0.0',
    })).toMatchObject({ cpuCount: 16, totalMemoryBytes: 32 * 1_024 ** 3, name: 'database-host' });
    const inspection = [{
      Id: 'container-id',
      Image: `sha256:${'b'.repeat(64)}`,
      HostConfig: { Memory: 8 * 1_024 ** 3 },
      Mounts: [{ Type: 'volume', Name: 'wiki_benchmark_data', Destination: '/var/lib/postgresql' }],
      NetworkSettings: {
        Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55433' }] },
        Networks: { benchmark: { IPAddress: '172.28.0.2' } },
      },
    }];
    expect(validateDockerTargetInspection(inspection, {
      container: 'wiki-storage-benchmark', volume: 'wiki_benchmark_data',
      imageDigest: `sha256:${'b'.repeat(64)}`, bind: '127.0.0.1:55433', memoryBytes: 8 * 1_024 ** 3,
    })).toMatchObject({ containerId: 'container-id', volume: 'wiki_benchmark_data', bind: '127.0.0.1:55433' });
    expect(() => validateDockerTargetInspection(inspection, {
      container: 'wiki-storage-benchmark', volume: 'wrong', imageDigest: `sha256:${'b'.repeat(64)}`,
      bind: '127.0.0.1:55433', memoryBytes: 8 * 1_024 ** 3,
    })).toThrow(/volume/i);
    expect(() => validateDockerTargetInspection([{ ...inspection[0], Mounts: [
      { Type: 'volume', Name: 'wiki_benchmark_data', Destination: '/var/lib/postgresql/data' },
    ] }], {
      container: 'wiki-storage-benchmark', volume: 'wiki_benchmark_data',
      imageDigest: `sha256:${'b'.repeat(64)}`, bind: '127.0.0.1:55433', memoryBytes: 8 * 1_024 ** 3,
    })).toThrow(/destination/i);
  });

  it('retries transient evidence reads but still fails after the bounded attempt count', async () => {
    const wait = vi.fn(async () => undefined);
    const succeeds = vi.fn()
      .mockRejectedValueOnce(new Error('transport timeout'))
      .mockResolvedValueOnce('sample');
    await expect(retryTransient(succeeds, 3, wait)).resolves.toBe('sample');
    expect(succeeds).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);

    const fails = vi.fn().mockRejectedValue(new Error('still unavailable'));
    await expect(retryTransient(fails, 3, wait)).rejects.toThrow(/still unavailable/i);
    expect(fails).toHaveBeenCalledTimes(3);
  });

  it('binds both database URLs and live PostgreSQL server identity to the inspected container', () => {
    const target = {
      containerId: 'container-id', imageDigest: `sha256:${'b'.repeat(64)}`,
      volume: 'wiki_benchmark_data', volumeDestination: '/var/lib/postgresql',
      bind: '127.0.0.1:55433', memoryBytes: 8 * 1_024 ** 3,
    };
    expect(validateDatabaseUrlBindings(
      'postgresql://admin:secret@127.0.0.1:55433/wiki',
      'postgresql://runtime:secret@127.0.0.1:55433/wiki',
    )).toEqual({ database: 'wiki', adminUser: 'admin' });
    expect(() => validateDatabaseUrlBindings(
      'postgresql://admin:secret@127.0.0.1:60000/wiki',
      'postgresql://runtime:secret@127.0.0.1:60000/wiki',
    )).not.toThrow();
    expect(() => validateDatabaseUrlBindings(
      'postgresql://admin:secret@127.0.0.1:60000/wiki',
      'postgresql://runtime:secret@127.0.0.1:60001/wiki',
    )).toThrow(/endpoint/i);
    expect(() => validateDatabaseUrlBindings(
      'postgresql://admin:secret@10.0.0.2:55433/wiki',
      'postgresql://runtime:secret@10.0.0.2:55433/wiki',
    )).toThrow(/loopback/i);

    const identity = {
      systemIdentifier: '7612345678901234567', database: 'wiki',
      serverAddress: '172.28.0.2', serverPort: 5432,
      dataDirectory: '/var/lib/postgresql/18/docker',
    };
    const runtimeIdentity = {
      database: identity.database, serverAddress: identity.serverAddress, serverPort: identity.serverPort,
    };
    expect(validateDatabaseServerIdentity(identity, runtimeIdentity, '7612345678901234567', target, 'wiki')).toEqual(identity);
    expect(() => validateDatabaseServerIdentity(
      identity, runtimeIdentity, '7699999999999999999', target, 'wiki',
    )).toThrow(/identity/i);
    const outsideVolume = { ...identity, dataDirectory: '/tmp/postgresql' };
    expect(() => validateDatabaseServerIdentity(
      outsideVolume, runtimeIdentity, '7612345678901234567', target, 'wiki',
    )).toThrow(/data.directory/i);
  });

  it('counts only execution failures as ANN errors while graph exactness remains fail-closed', () => {
    const approximate = [{ queryId: 'q1', pass: 1, durationMs: 1, hits: ['approximate-neighbor'] }];
    const exact = new Map([['q1', ['exact-neighbor']]]);
    expect(timingMetric(approximate).errorCount).toBe(0);
    expect(timingMetric(approximate, exact).errorCount).toBe(1);
    expect(timingMetric([{ ...approximate[0]!, error: 'query failed' }]).errorCount).toBe(1);
    expect(timingMetric([
      approximate[0]!, { ...approximate[0]!, pass: 2, durationMs: 2 }, { ...approximate[0]!, pass: 3, durationMs: 3 },
    ]).passMetrics).toEqual([
      { pass: 1, sampleCount: 1, errorCount: 0, p95Ms: 1, p99Ms: 1 },
      { pass: 2, sampleCount: 1, errorCount: 0, p95Ms: 2, p99Ms: 2 },
      { pass: 3, sampleCount: 1, errorCount: 0, p95Ms: 3, p99Ms: 3 },
    ]);
  });

  it('normalizes and rejects malformed results inside the timed query boundary', () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const excluded = '00000000-0000-4000-8000-000000000003';
    expect(validateTimedGraphHits(['b', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(() => validateTimedGraphHits(['a', 'a'], ['a'])).toThrow(/duplicate/i);
    expect(() => validateTimedGraphHits(['a'], ['b'])).toThrow(/ground truth/i);
    expect(validateTimedAnnHits([
      { id: first, spaceId: 'space-a', score: 0.8 }, { id: second, spaceId: 'space-a', score: 0.5 },
    ], 'space-a', excluded, 10)).toEqual([first, second]);
    expect(() => validateTimedAnnHits([
      { id: first, spaceId: 'space-a', score: 0.5 }, { id: first, spaceId: 'space-a', score: 0.4 },
    ], 'space-a', excluded, 10)).toThrow(/duplicate/i);
    expect(() => validateTimedAnnHits([{ id: first, spaceId: 'space-b', score: 0.5 }], 'space-a', excluded, 10)).toThrow(/unauthorized/i);
    expect(() => validateTimedAnnHits([{ id: first, spaceId: 'space-a', score: Number.NaN }], 'space-a', excluded, 10)).toThrow(/malformed/i);
    expect(() => validateTimedAnnHits([{ id: excluded, spaceId: 'space-a', score: 0.5 }], 'space-a', excluded, 10)).toThrow(/malformed/i);
    expect(() => validateTimedAnnHits([
      { id: first, spaceId: 'space-a', score: 0.4 }, { id: second, spaceId: 'space-a', score: 0.5 },
    ], 'space-a', excluded, 10)).toThrow(/descending/i);
    expect(() => validateTimedAnnHits([{ id: 'not-a-uuid', spaceId: 'space-a', score: 0.5 }], 'space-a', excluded, 10)).toThrow(/malformed/i);
  });

  it('fails closed when a benchmark phase exceeds the registered wall-clock timeout', () => {
    expect(() => assertWallClockWithinLimit(0n, 7_200_000_000_000n)).not.toThrow();
    expect(() => assertWallClockWithinLimit(0n, 7_200_000_000_001n)).toThrow(/wall-clock/i);
  });

  it('hashes deterministic float32 vector contents so one corrupted embedding changes the seed hash', () => {
    const rows = [
      { nodeId: 'a', vector: [Math.fround(0.25), Math.fround(-0.5)] },
      { nodeId: 'b', vector: [Math.fround(0.75), Math.fround(1)] },
    ];
    expect(hashVectorRows(rows)).toBe(hashVectorRows(rows.map((row) => ({ ...row, vector: [...row.vector] }))));
    expect(hashVectorRows(rows)).not.toBe(hashVectorRows([
      rows[0]!, { nodeId: 'b', vector: [Math.fround(0.75), Math.fround(0.99)] },
    ]));
  });

  it('cycles every registered warm-up case instead of pinning the first case', async () => {
    const seen: string[] = [];
    let clock = 0;
    await cycleWarmupCases(['a', 'b', 'c'], 30, async (id) => { seen.push(id); clock += 10_000; }, () => clock);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('warms interleaved buckets at registered concurrency', async () => {
    const cases = [0, 0, 1, 1, 2, 2].map((bucket, ordinal) => ({ bucket, ordinal }));
    expect(interleaveWarmupCases(cases, (item) => item.bucket).map((item) => item.bucket))
      .toEqual([0, 1, 2, 0, 1, 2]);
    const seen: number[] = [];
    let clock = 0;
    await cycleWarmupCases(cases, 0, async (item) => { seen.push(item.ordinal); clock += 1; }, () => clock, 3);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('summarizes the exact transaction, agtype, HNSW, pre-ACL, and decoy gates', () => {
    const transactions = Array.from({ length: 100 }, (_, index) => ({
      outcome: index % 2 === 0 ? 'commit' as const : 'rollback' as const,
      relationalPresent: index % 2 === 0,
      agePresent: index % 2 === 0,
      vectorPresent: index % 2 === 0,
    }));
    expect(summarizeTransactionCases(transactions)).toEqual({ commits: 50, rollbacks: 50, atomic: true, orphanCount: 0 });

    const agtypes = ['null', 'bool', 'int64', 'float', 'string', 'list', 'map', 'vertex', 'edge', 'path'] as const;
    const corpus = agtypes.flatMap((category) => [0, 1].map((ordinal) => {
      const encoded = agtypeFixture(category, ordinal);
      const decoded = decodeAgtype(encoded);
      const expected = category === 'vertex'
        ? { label: 'KnowledgeNode', properties: {} }
        : category === 'edge'
          ? { label: 'KNOWLEDGE_EDGE', properties: {} }
          : category === 'path'
            ? [
                { label: 'KnowledgeNode', properties: {} },
                { label: 'KNOWLEDGE_EDGE', properties: {} },
                { label: 'KnowledgeNode', properties: {} },
              ]
            : decoded;
      return { category, ordinal, encoded, expected };
    }));
    expect(summarizeAgtypeCorpus(corpus, 2)).toMatchObject({ parseErrors: 0, undefinedValues: 0, precisionLosses: 0 });
    const mislabeled = corpus.map((row) => row.category === 'string' ? { ...row, encoded: '42' } : row);
    expect(summarizeAgtypeCorpus(mislabeled, 2).parseErrors).toBeGreaterThan(0);
    const wrongVertex = corpus.map((row) => row.category === 'vertex'
      ? { ...row, encoded: '{"id":1,"label":"KnowledgeNode","properties":{"id":"wrong"}}::vertex' } : row);
    expect(summarizeAgtypeCorpus(wrongVertex, 2).semanticErrors).toBeGreaterThan(0);

    expect(validateHnswPlans([{ queryId: 'q1', plan: [{ Plan: {
      'Node Type': 'Index Scan', 'Relation Name': 'knowledge_vectors',
      'Index Name': 'knowledge_vectors_embedding_hnsw_idx',
    } }] }], ['q1']))
      .toEqual({ planCount: 1, invalidPlanCount: 0 });
    expect(validateHnswPlans([{ queryId: 'q1', plan: [{ Plan: {
      'Node Type': 'Seq Scan', 'Relation Name': 'knowledge_vectors',
      'Filter': "knowledge_vectors_embedding_hnsw_idx = 'misleading text'",
    } }] }], ['q1']).invalidPlanCount).toBe(1);
    expect(validatePreAclCandidateCounts([{ queryId: 'q1', bucket: 0, actual: 59 }], [{ id: 'q1', bucket: 0 }], [60, 60, 60, 60]))
      .toEqual({ queryCount: 1, mismatchCount: 0 });
    expect(validatePreAclCandidateCounts([{ queryId: 'q1', bucket: 0, actual: 60 }], [{ id: 'q1', bucket: 0 }], [60, 60, 60, 60]))
      .toEqual({ queryCount: 1, mismatchCount: 1 });
    expect(summarizeDecoyAclChecks(Array.from({ length: 8 }, () => ({ allowedRoot: true, deniedOutputs: 0 })), 8))
      .toEqual({ checked: 8, allowedRoots: 8, deniedOutputs: 0 });
  });
});

function agtypeFixture(category: string, ordinal: number): string {
  const fixtures: Record<string, string> = {
    null: 'null', bool: ordinal === 0 ? 'true' : 'false',
    int64: ordinal === 0 ? '9223372036854775807' : '-9223372036854775808',
    float: String(ordinal + 1.5), string: '"escaped\\n\\"value"',
    list: `[${ordinal + 1},true,null]`, map: `{"value":${ordinal + 1}}`,
    vertex: '{"id":1,"label":"KnowledgeNode","properties":{}}::vertex',
    edge: '{"id":2,"label":"KNOWLEDGE_EDGE","start_id":1,"end_id":3,"properties":{}}::edge',
    path: '[{"id":1,"label":"KnowledgeNode","properties":{}}::vertex,{"id":2,"label":"KNOWLEDGE_EDGE","start_id":1,"end_id":3,"properties":{}}::edge,{"id":3,"label":"KnowledgeNode","properties":{}}::vertex]::path',
  };
  return fixtures[category]!;
}

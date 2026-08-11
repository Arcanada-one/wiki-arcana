import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BENCHMARK_EFFECTIVE_SETTINGS } from '../../scripts/benchmark-storage.js';
import {
  EvidenceValidationError,
  renderVerdictMarkdown,
  validateBenchmarkEvidence,
  type AuthoritativeEvidence,
  type ExpectedBindings,
} from '../../scripts/verify-storage-benchmark.js';

const bindings: ExpectedBindings = {
  manifestSha256: 'a'.repeat(64),
  commit: 'b'.repeat(40),
  imageDigest: `sha256:${'c'.repeat(64)}`,
  migrationHash: 'd'.repeat(64),
  target: {
    containerId: 'container-id', volume: 'wiki_benchmark_data',
    bind: '127.0.0.1:55433', memoryBytes: 8 * 1_024 ** 3,
  },
};

let rawArtifactBytes = Buffer.alloc(0);

function passingEvidence(): AuthoritativeEvidence {
  const evidence: AuthoritativeEvidence = {
    schemaVersion: 'wiki-storage-benchmark-evidence/v1',
    mode: 'AUTHORITATIVE',
    status: 'COMPLETED',
    bindings,
    skippedMetrics: [],
    rawArtifactSha256: '0'.repeat(64),
    metrics: {
      graph: {
        warmSeconds: 30, passes: 3, concurrency: 8, sampleCount: 600, errorCount: 0, p95Ms: 499, p99Ms: 499,
        passMetrics: [1, 2, 3].map((pass) => ({ pass, sampleCount: 200, errorCount: 0, p95Ms: 499, p99Ms: 499 })),
      },
      ann: {
        warmSeconds: 30,
        passes: 3,
        concurrency: 8,
        sampleCount: 1_200,
        errorCount: 0,
        p95Ms: 499,
        p99Ms: 499,
        passMetrics: [1, 2, 3].map((pass) => ({ pass, sampleCount: 400, errorCount: 0, p95Ms: 499, p99Ms: 499 })),
        buckets: [0, 1, 2, 3].map((bucket) => ({
          bucket,
          meanRecall: 1,
          minimumRecall: 1,
          fillRate: 1,
        })),
      },
      unauthorizedGraphHits: 0,
      unauthorizedVectorHits: 0,
      authorizedAnnLeakage: 0,
      environment: {
        databaseHost: {
          cpuCount: 16, totalMemoryBytes: 32 * 1_024 ** 3, architecture: 'x86_64',
          operatingSystem: 'Linux', name: 'docker-host', serverVersion: '28.0.0',
        },
        client: { cpuModel: 'test-cpu', cpuCount: 8, totalMemoryBytes: 16 * 1_024 ** 3 },
        container: { memoryBytes: 8 * 1_024 ** 3 },
        storage: {
          pg_version: '18.0', age_version: '1.7.0', vector_version: '0.8.1',
          indexdef: 'CREATE INDEX knowledge_vectors_embedding_hnsw_idx USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=128)',
        },
        effectiveSettings: {
          ...BENCHMARK_EFFECTIVE_SETTINGS,
          exactGroundTruth: { ...BENCHMARK_EFFECTIVE_SETTINGS.exactGroundTruth },
          annSearch: { ...BENCHMARK_EFFECTIVE_SETTINGS.annSearch },
        },
      },
      transactions: { commits: 50, rollbacks: 50, atomic: true, orphanCount: 0 },
      agtype: {
        categories: { null: 1_000, bool: 1_000, int64: 1_000, float: 1_000, string: 1_000,
          list: 1_000, map: 1_000, vertex: 1_000, edge: 1_000, path: 1_000 },
        parseErrors: 0, semanticErrors: 0, undefinedValues: 0, precisionLosses: 0,
      },
      aclCorrectness: {
        checked: 5, passed: 5,
        scenarios: ['clearance_only', 'allow_below_rank', 'deny_override', 'neither', 'wrong_space'],
      },
      hnsw: { buildMs: 1_200_000, planCount: 400, invalidPlanCount: 0 },
      preAclCandidates: { queryCount: 400, mismatchCount: 0 },
      decoyAcl: { checked: 100, productCalls: 100, allowedRoots: 100, deniedOutputs: 0 },
      memory: { metric: 'cgroup_v2_anon_plus_shmem', sampleCount: 1,
        peakBytes: 8 * 1_024 ** 3, peakMemoryCurrentBytes: 8 * 1_024 ** 3 },
      databaseBytes: 5 * 1_024 ** 3,
    },
  };
  const graphQueries = Array.from({ length: 200 }, (_, query) => ({ id: `g${query}` }));
  const annQueries = Array.from({ length: 400 }, (_, query) => ({
    id: `a${query}`, bucket: Math.floor(query / 100), spaceId: `space-${Math.floor(query / 100)}`,
  }));
  const hits = (bucket: number) => Array.from({ length: 10 }, (_, index) => `hit-${bucket}-${index}`);
  const graphSamples = graphQueries.flatMap((query) => [1, 2, 3].map((pass) => ({
    queryId: query.id, pass, durationMs: 499, hits: [],
  })));
  const annSamples = annQueries.flatMap((query) => [1, 2, 3].map((pass) => ({
    queryId: query.id, pass, durationMs: 499, hits: hits(query.bucket),
  })));
  rawArtifactBytes = Buffer.from(JSON.stringify({
    graphSamples, annSamples,
    hnswPlans: annQueries.map((query) => ({ queryId: query.id, plan: [{ Plan: {
      'Node Type': 'Index Scan', 'Relation Name': 'knowledge_vectors',
      'Index Name': 'knowledge_vectors_embedding_hnsw_idx',
    } }] })),
    preAclCandidates: annQueries.map((query) => ({
      queryId: query.id, bucket: query.bucket, actual: [50_000, 10_000, 1_000, 100][query.bucket]! - 1,
    })),
    memorySamples: [{ rssApproximationBytes: 8 * 1_024 ** 3, memoryCurrentBytes: 8 * 1_024 ** 3 }],
    queries: { traversal: graphQueries, ann: annQueries, unauthorizedGraph: [], unauthorizedVector: [] },
    truth: [...graphQueries.map((query) => ({ queryId: query.id, resultIds: [] })),
      ...annQueries.map((query) => ({ queryId: query.id, resultIds: hits(query.bucket) }))],
    annHitSpaces: [0, 1, 2, 3].flatMap((bucket) => hits(bucket).map((nodeId) => ({ nodeId, spaceId: `space-${bucket}` }))),
    bucketSizes: [50_000, 10_000, 1_000, 100],
    observations: {
      hnswBuildMs: evidence.metrics.hnsw.buildMs,
      transactions: evidence.metrics.transactions, agtype: evidence.metrics.agtype,
      aclCorrectness: evidence.metrics.aclCorrectness, decoyAcl: evidence.metrics.decoyAcl,
      unauthorizedGraphHits: evidence.metrics.unauthorizedGraphHits,
      unauthorizedVectorHits: evidence.metrics.unauthorizedVectorHits,
      databaseBytes: evidence.metrics.databaseBytes, environment: evidence.metrics.environment,
    },
  }));
  evidence.rawArtifactSha256 = createHash('sha256').update(rawArtifactBytes).digest('hex');
  return evidence;
}

describe('storage fail-closed benchmark verdict', () => {
  it('accepts a complete authoritative fixture exactly on every frozen threshold', () => {
    const verdict = validateBenchmarkEvidence(passingEvidence(), bindings, rawArtifactBytes);
    expect(verdict).toMatchObject({ status: 'PASS', pass: true, reasons: [] });
    expect(renderVerdictMarkdown(verdict)).toContain('Authoritative verdict: PASS');
  });

  it('requires the bound raw artifact and fails digest or coverage tampering', () => {
    const evidence = passingEvidence();
    expect(() => validateBenchmarkEvidence(evidence, bindings)).toThrow(/raw artifact/i);
    expect(validateBenchmarkEvidence(evidence, bindings, Buffer.concat([rawArtifactBytes, Buffer.from('\n')])).reasons)
      .toContain('raw artifact digest binding mismatch');
    const incomplete = Buffer.from(JSON.stringify({
      graphSamples: [], annSamples: [], hnswPlans: [], preAclCandidates: [], memorySamples: [],
    }));
    evidence.rawArtifactSha256 = createHash('sha256').update(incomplete).digest('hex');
    expect(() => validateBenchmarkEvidence(evidence, bindings, incomplete)).toThrow(EvidenceValidationError);
  });

  it('rejects summary tampering with fixed raw and raw metric tampering with an updated digest', () => {
    const summaryTampered = passingEvidence();
    summaryTampered.metrics.graph.p95Ms = 498;
    expect(validateBenchmarkEvidence(summaryTampered, bindings, rawArtifactBytes).reasons.join('\n')).toMatch(/graph timing.*reconcile/i);

    const rawTamperedEvidence = passingEvidence();
    const raw = JSON.parse(rawArtifactBytes.toString('utf8')) as { graphSamples: { durationMs: number }[] };
    raw.graphSamples.forEach((sample) => { sample.durationMs = 500; });
    const rawTampered = Buffer.from(JSON.stringify(raw));
    rawTamperedEvidence.rawArtifactSha256 = createHash('sha256').update(rawTampered).digest('hex');
    expect(validateBenchmarkEvidence(rawTamperedEvidence, bindings, rawTampered).reasons.join('\n')).toMatch(/graph timing.*reconcile/i);
  });

  it('reconciles the bound HNSW index definition and rejects summary tampering', () => {
    const evidence = passingEvidence();
    expect(validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes)).toMatchObject({ pass: true });
    evidence.metrics.environment.storage.indexdef = `${evidence.metrics.environment.storage.indexdef} altered`;
    expect(validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes).reasons.join('\n')).toMatch(/environment.*reconcile/i);
  });

  it('distinguishes PREPARED evidence from PASS', () => {
    const verdict = validateBenchmarkEvidence({
      schemaVersion: 'wiki-storage-benchmark-evidence/v1',
      mode: 'PREPARE',
      status: 'PREPARED',
      bindings,
      skippedMetrics: ['authoritative timed benchmark not authorized'],
      setup: { setupDurationMs: 123_456 },
    }, bindings);

    expect(verdict).toMatchObject({ status: 'PREPARED', pass: false });
    expect(renderVerdictMarkdown(verdict)).toContain('Prepared only; this is not a benchmark PASS');
  });

  it.each([
    ['missing metrics', { ...passingEvidence(), metrics: undefined }],
    ['null latency', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, graph: { ...passingEvidence().metrics.graph, p95Ms: null } } }],
    ['NaN latency', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, graph: { ...passingEvidence().metrics.graph, p95Ms: Number.NaN } } }],
    ['infinite latency', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, graph: { ...passingEvidence().metrics.graph, p99Ms: Number.POSITIVE_INFINITY } } }],
    ['negative warm-up', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, graph: { ...passingEvidence().metrics.graph, warmSeconds: -1 } } }],
    ['negative p95 latency', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, graph: { ...passingEvidence().metrics.graph, p95Ms: -1 } } }],
    ['negative p99 latency', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, ann: { ...passingEvidence().metrics.ann, p99Ms: -1 } } }],
    ['negative HNSW build time', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, hnsw: { ...passingEvidence().metrics.hnsw, buildMs: -1 } } }],
    ['out-of-range recall', { ...passingEvidence(), metrics: { ...passingEvidence().metrics, ann: { ...passingEvidence().metrics.ann, buckets: [{ ...passingEvidence().metrics.ann.buckets[0]!, meanRecall: 1.01 }, ...passingEvidence().metrics.ann.buckets.slice(1)] } } }],
  ])('rejects malformed or non-finite evidence: %s', (_case, evidence) => {
    expect(() => validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes)).toThrow(EvidenceValidationError);
  });

  it('fails when any producer marks a metric skipped', () => {
    const evidence = passingEvidence();
    evidence.skippedMetrics = ['rss'];
    const verdict = validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes);
    expect(verdict).toMatchObject({ status: 'FAIL', pass: false });
    expect(verdict.reasons.join('\n')).toMatch(/skipped/i);
  });

  it('fails binding mismatches instead of accepting evidence from another run', () => {
    const evidence = passingEvidence();
    evidence.bindings = { ...bindings, manifestSha256: 'e'.repeat(64) };
    const verdict = validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes);
    expect(verdict).toMatchObject({ status: 'FAIL', pass: false });
    expect(verdict.reasons.join('\n')).toMatch(/manifest/i);
  });

  it('fails a live container identity mismatch', () => {
    const evidence = passingEvidence();
    evidence.bindings = { ...bindings, target: { ...bindings.target, containerId: 'other-container' } };
    const verdict = validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes);
    expect(verdict).toMatchObject({ status: 'FAIL', pass: false });
    expect(verdict.reasons.join('\n')).toMatch(/container/i);
  });

  it.each(['jit', 'efSearch'] as const)('rejects missing ANN setting: %s', (setting) => {
    const evidence = passingEvidence();
    const annSearch = evidence.metrics.environment.effectiveSettings.annSearch as unknown as Record<string, unknown>;
    delete annSearch[setting];
    expect(() => validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes)).toThrow(EvidenceValidationError);
  });

  it.each([
    ['jit', 'on'],
    ['efSearch', '40'],
  ] as const)('fails a wrong ANN setting: %s', (setting, value) => {
    const evidence = passingEvidence();
    const annSearch = evidence.metrics.environment.effectiveSettings.annSearch as unknown as Record<string, unknown>;
    annSearch[setting] = value;
    const verdict = validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes);
    expect(verdict).toMatchObject({ status: 'FAIL', pass: false });
    expect(verdict.reasons).toContain('effective benchmark settings differ from the frozen contract');
  });

  it.each([
    ['p95 latency', (evidence: AuthoritativeEvidence) => { evidence.metrics.graph.p95Ms = 501; }],
    ['p99 latency', (evidence: AuthoritativeEvidence) => { evidence.metrics.ann.p99Ms = 1_501; }],
    ['query error', (evidence: AuthoritativeEvidence) => { evidence.metrics.graph.errorCount = 1; }],
    ['single-pass latency', (evidence: AuthoritativeEvidence) => { evidence.metrics.ann.passMetrics[1]!.p95Ms = 501; }],
    ['mean recall', (evidence: AuthoritativeEvidence) => { evidence.metrics.ann.buckets[0]!.meanRecall = 0.949; }],
    ['per-query recall', (evidence: AuthoritativeEvidence) => { evidence.metrics.ann.buckets[1]!.minimumRecall = 0.799; }],
    ['fill rate', (evidence: AuthoritativeEvidence) => { evidence.metrics.ann.buckets[2]!.fillRate = 0.989; }],
    ['graph authorization', (evidence: AuthoritativeEvidence) => { evidence.metrics.unauthorizedGraphHits = 1; }],
    ['vector authorization', (evidence: AuthoritativeEvidence) => { evidence.metrics.unauthorizedVectorHits = 1; }],
    ['authorized ANN leakage', (evidence: AuthoritativeEvidence) => { evidence.metrics.authorizedAnnLeakage = 1; }],
    ['transaction split', (evidence: AuthoritativeEvidence) => { evidence.metrics.transactions.commits = 49; }],
    ['transaction atomicity', (evidence: AuthoritativeEvidence) => { evidence.metrics.transactions.atomic = false; }],
    ['transaction orphan', (evidence: AuthoritativeEvidence) => { evidence.metrics.transactions.orphanCount = 1; }],
    ['agtype category', (evidence: AuthoritativeEvidence) => { evidence.metrics.agtype.categories.path = 999; }],
    ['agtype parse error', (evidence: AuthoritativeEvidence) => { evidence.metrics.agtype.parseErrors = 1; }],
    ['agtype semantic error', (evidence: AuthoritativeEvidence) => { evidence.metrics.agtype.semanticErrors = 1; }],
    ['HNSW build', (evidence: AuthoritativeEvidence) => { evidence.metrics.hnsw.buildMs = 1_200_001; }],
    ['HNSW plan count', (evidence: AuthoritativeEvidence) => { evidence.metrics.hnsw.planCount = 399; }],
    ['pre-ACL count', (evidence: AuthoritativeEvidence) => { evidence.metrics.preAclCandidates.mismatchCount = 1; }],
    ['decoy ACL', (evidence: AuthoritativeEvidence) => { evidence.metrics.decoyAcl.deniedOutputs = 1; }],
    ['memory samples', (evidence: AuthoritativeEvidence) => { evidence.metrics.memory.sampleCount = 0; }],
    ['effective settings', (evidence: AuthoritativeEvidence) => { evidence.metrics.environment.effectiveSettings = {
      ...evidence.metrics.environment.effectiveSettings, runtimeStatementTimeout: '1501ms',
    }; }],
    ['database host identity', (evidence: AuthoritativeEvidence) => { evidence.metrics.environment.databaseHost.cpuCount = 0; }],
    ['database size', (evidence: AuthoritativeEvidence) => { evidence.metrics.databaseBytes = 5 * 1_024 ** 3 + 1; }],
    ['container RSS approximation', (evidence: AuthoritativeEvidence) => { evidence.metrics.memory.peakBytes = 8 * 1_024 ** 3 + 1; }],
  ])('fails a threshold violation: %s', (_case, mutate) => {
    const evidence = passingEvidence();
    mutate(evidence);
    const verdict = validateBenchmarkEvidence(evidence, bindings, rawArtifactBytes);
    expect(verdict).toMatchObject({ status: 'FAIL', pass: false });
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });
});

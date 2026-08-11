import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_CONTRACT, BENCHMARK_EFFECTIVE_SETTINGS, canonicalSha256,
  timingMetric, validateHnswPlans, validatePreAclCandidateCounts,
  type BenchmarkEffectiveSettings, type TimedSample } from './benchmark-storage.js';

export interface ExpectedBindings {
  manifestSha256: string;
  commit: string;
  imageDigest: string;
  migrationHash: string;
  target: {
    containerId: string;
    volume: string;
    bind: string;
    memoryBytes: number;
  };
}

export interface TimingMetrics {
  warmSeconds: number;
  passes: number;
  concurrency: number;
  sampleCount: number;
  errorCount: number;
  p95Ms: number;
  p99Ms: number;
  passMetrics: PassTimingMetrics[];
}

export interface PassTimingMetrics {
  pass: number;
  sampleCount: number;
  errorCount: number;
  p95Ms: number;
  p99Ms: number;
}

export interface AnnBucketMetrics {
  bucket: number;
  meanRecall: number;
  minimumRecall: number;
  fillRate: number;
}

export interface AuthoritativeEvidence {
  schemaVersion: 'wiki-storage-benchmark-evidence/v1';
  mode: 'AUTHORITATIVE';
  status: 'COMPLETED';
  bindings: ExpectedBindings;
  skippedMetrics: string[];
  rawArtifactSha256: string;
  metrics: {
    graph: TimingMetrics;
    ann: TimingMetrics & { buckets: AnnBucketMetrics[] };
    unauthorizedGraphHits: number;
    unauthorizedVectorHits: number;
    authorizedAnnLeakage: number;
    environment: {
      databaseHost: {
        cpuCount: number; totalMemoryBytes: number; architecture: string;
        operatingSystem: string; name: string; serverVersion: string;
      };
      client: { cpuModel: string; cpuCount: number; totalMemoryBytes: number };
      container: { memoryBytes: number };
      storage: { pg_version: string; age_version: string; vector_version: string; indexdef: string };
      effectiveSettings: BenchmarkEffectiveSettings;
    };
    transactions: { commits: number; rollbacks: number; atomic: boolean; orphanCount: number };
    agtype: {
      categories: Record<'null' | 'bool' | 'int64' | 'float' | 'string' | 'list' | 'map' | 'vertex' | 'edge' | 'path', number>;
      parseErrors: number;
      semanticErrors: number;
      undefinedValues: number;
      precisionLosses: number;
    };
    aclCorrectness: { checked: number; passed: number; scenarios: string[] };
    hnsw: { buildMs: number; planCount: number; invalidPlanCount: number };
    preAclCandidates: { queryCount: number; mismatchCount: number };
    decoyAcl: { checked: number; productCalls: number; allowedRoots: number; deniedOutputs: number };
    memory: { metric: 'cgroup_v2_anon_plus_shmem'; sampleCount: number; peakBytes: number; peakMemoryCurrentBytes: number };
    databaseBytes: number;
  };
}

interface PreparedEvidence {
  schemaVersion: 'wiki-storage-benchmark-evidence/v1';
  mode: 'PREPARE';
  status: 'PREPARED';
  bindings: ExpectedBindings;
  skippedMetrics: string[];
  setup: { setupDurationMs: number };
}

export interface BenchmarkVerdict {
  readonly schemaVersion: 'wiki-storage-benchmark-verdict/v1';
  readonly status: 'PREPARED' | 'PASS' | 'FAIL';
  readonly pass: boolean;
  readonly bindings: ExpectedBindings;
  readonly reasons: readonly string[];
}

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceValidationError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvidenceValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new EvidenceValidationError(`${path} must be a non-empty string`);
  return value;
}

function digest(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new EvidenceValidationError(`${path} must be a lowercase SHA-256 digest`);
  return parsed;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new EvidenceValidationError(`${path} must be finite`);
  return value;
}

function nonNegativeFinite(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0) throw new EvidenceValidationError(`${path} must be non-negative`);
  return parsed;
}

function integer(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new EvidenceValidationError(`${path} must be a non-negative integer`);
  return parsed;
}

function ratio(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0 || parsed > 1) throw new EvidenceValidationError(`${path} must be between 0 and 1`);
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new EvidenceValidationError(`${path} must be boolean`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new EvidenceValidationError(`${path} must be an array of strings`);
  }
  return [...value];
}

function parseBindings(value: unknown): ExpectedBindings {
  const input = record(value, 'bindings');
  const bindings = {
    manifestSha256: text(input.manifestSha256, 'bindings.manifestSha256'),
    commit: text(input.commit, 'bindings.commit'),
    imageDigest: text(input.imageDigest, 'bindings.imageDigest'),
    migrationHash: text(input.migrationHash, 'bindings.migrationHash'),
    target: parseTarget(input.target),
  };
  if (!/^[0-9a-f]{64}$/i.test(bindings.manifestSha256)) throw new EvidenceValidationError('manifest digest is malformed');
  if (!/^[0-9a-f]{40}$/i.test(bindings.commit)) throw new EvidenceValidationError('commit binding is malformed');
  if (!/^sha256:[0-9a-f]{64}$/i.test(bindings.imageDigest)) throw new EvidenceValidationError('image digest is malformed');
  if (!/^[0-9a-f]{64}$/i.test(bindings.migrationHash)) throw new EvidenceValidationError('migration hash is malformed');
  return bindings;
}

function parseTarget(value: unknown): ExpectedBindings['target'] {
  const input = record(value, 'bindings.target');
  return {
    containerId: text(input.containerId, 'bindings.target.containerId'),
    volume: text(input.volume, 'bindings.target.volume'),
    bind: text(input.bind, 'bindings.target.bind'),
    memoryBytes: integer(input.memoryBytes, 'bindings.target.memoryBytes'),
  };
}

const AGTYPE_CATEGORIES = ['null', 'bool', 'int64', 'float', 'string', 'list', 'map', 'vertex', 'edge', 'path'] as const;

function parseAgtypeCategories(value: unknown): AuthoritativeEvidence['metrics']['agtype']['categories'] {
  const input = record(value, 'metrics.agtype.categories');
  return Object.fromEntries(AGTYPE_CATEGORIES.map((category) => [
    category,
    integer(input[category], `metrics.agtype.categories.${category}`),
  ])) as AuthoritativeEvidence['metrics']['agtype']['categories'];
}

function parseTiming(value: unknown, path: string): TimingMetrics {
  const input = record(value, path);
  if (!Array.isArray(input.passMetrics) || input.passMetrics.length !== BENCHMARK_CONTRACT.timed.passes) {
    throw new EvidenceValidationError(`${path}.passMetrics must contain exactly three passes`);
  }
  const passMetrics = input.passMetrics.map((value, index) => {
    const item = record(value, `${path}.passMetrics[${index}]`);
    return {
      pass: integer(item.pass, `${path}.passMetrics[${index}].pass`),
      sampleCount: integer(item.sampleCount, `${path}.passMetrics[${index}].sampleCount`),
      errorCount: integer(item.errorCount, `${path}.passMetrics[${index}].errorCount`),
      p95Ms: nonNegativeFinite(item.p95Ms, `${path}.passMetrics[${index}].p95Ms`),
      p99Ms: nonNegativeFinite(item.p99Ms, `${path}.passMetrics[${index}].p99Ms`),
    };
  });
  if (passMetrics.map((item) => item.pass).sort().join(',') !== '1,2,3') {
    throw new EvidenceValidationError(`${path}.passMetrics must cover passes 1..3 exactly once`);
  }
  return {
    warmSeconds: nonNegativeFinite(input.warmSeconds, `${path}.warmSeconds`),
    passes: integer(input.passes, `${path}.passes`),
    concurrency: integer(input.concurrency, `${path}.concurrency`),
    sampleCount: integer(input.sampleCount, `${path}.sampleCount`),
    errorCount: integer(input.errorCount, `${path}.errorCount`),
    p95Ms: nonNegativeFinite(input.p95Ms, `${path}.p95Ms`),
    p99Ms: nonNegativeFinite(input.p99Ms, `${path}.p99Ms`),
    passMetrics,
  };
}

function parseBuckets(value: unknown): AnnBucketMetrics[] {
  if (!Array.isArray(value) || value.length !== 4) throw new EvidenceValidationError('metrics.ann.buckets must contain four buckets');
  const buckets = value.map((item, index) => {
    const input = record(item, `metrics.ann.buckets[${index}]`);
    return {
      bucket: integer(input.bucket, `metrics.ann.buckets[${index}].bucket`),
      meanRecall: ratio(input.meanRecall, `metrics.ann.buckets[${index}].meanRecall`),
      minimumRecall: ratio(input.minimumRecall, `metrics.ann.buckets[${index}].minimumRecall`),
      fillRate: ratio(input.fillRate, `metrics.ann.buckets[${index}].fillRate`),
    };
  });
  if (buckets.map((bucket) => bucket.bucket).sort().join(',') !== '0,1,2,3') {
    throw new EvidenceValidationError('metrics.ann.buckets must cover buckets 0..3 exactly once');
  }
  return buckets;
}

function parseAuthoritative(input: Record<string, unknown>, bindings: ExpectedBindings, skippedMetrics: string[]): AuthoritativeEvidence {
  if (input.status !== 'COMPLETED') throw new EvidenceValidationError('AUTHORITATIVE status must be COMPLETED');
  const metrics = record(input.metrics, 'metrics');
  const annInput = record(metrics.ann, 'metrics.ann');
  const transactions = record(metrics.transactions, 'metrics.transactions');
  const agtype = record(metrics.agtype, 'metrics.agtype');
  const hnsw = record(metrics.hnsw, 'metrics.hnsw');
  const aclCorrectness = record(metrics.aclCorrectness, 'metrics.aclCorrectness');
  const preAcl = record(metrics.preAclCandidates, 'metrics.preAclCandidates');
  const decoyAcl = record(metrics.decoyAcl, 'metrics.decoyAcl');
  const memory = record(metrics.memory, 'metrics.memory');
  const environment = record(metrics.environment, 'metrics.environment');
  const databaseHost = record(environment.databaseHost, 'metrics.environment.databaseHost');
  const client = record(environment.client, 'metrics.environment.client');
  const container = record(environment.container, 'metrics.environment.container');
  const effectiveSettings = record(environment.effectiveSettings, 'metrics.environment.effectiveSettings');
  const exactSettings = record(effectiveSettings.exactGroundTruth, 'metrics.environment.effectiveSettings.exactGroundTruth');
  const annSettings = record(effectiveSettings.annSearch, 'metrics.environment.effectiveSettings.annSearch');
  const storage = record(environment.storage, 'metrics.environment.storage');
  return {
    schemaVersion: BENCHMARK_CONTRACT.evidenceVersion,
    mode: 'AUTHORITATIVE',
    status: 'COMPLETED',
    bindings,
    skippedMetrics,
    rawArtifactSha256: digest(input.rawArtifactSha256, 'rawArtifactSha256'),
    metrics: {
      graph: parseTiming(metrics.graph, 'metrics.graph'),
      ann: { ...parseTiming(annInput, 'metrics.ann'), buckets: parseBuckets(annInput.buckets) },
      unauthorizedGraphHits: integer(metrics.unauthorizedGraphHits, 'metrics.unauthorizedGraphHits'),
      unauthorizedVectorHits: integer(metrics.unauthorizedVectorHits, 'metrics.unauthorizedVectorHits'),
      authorizedAnnLeakage: integer(metrics.authorizedAnnLeakage, 'metrics.authorizedAnnLeakage'),
      environment: {
        databaseHost: {
          cpuCount: integer(databaseHost.cpuCount, 'metrics.environment.databaseHost.cpuCount'),
          totalMemoryBytes: integer(databaseHost.totalMemoryBytes, 'metrics.environment.databaseHost.totalMemoryBytes'),
          architecture: text(databaseHost.architecture, 'metrics.environment.databaseHost.architecture'),
          operatingSystem: text(databaseHost.operatingSystem, 'metrics.environment.databaseHost.operatingSystem'),
          name: text(databaseHost.name, 'metrics.environment.databaseHost.name'),
          serverVersion: text(databaseHost.serverVersion, 'metrics.environment.databaseHost.serverVersion'),
        },
        client: {
          cpuModel: text(client.cpuModel, 'metrics.environment.client.cpuModel'),
          cpuCount: integer(client.cpuCount, 'metrics.environment.client.cpuCount'),
          totalMemoryBytes: integer(client.totalMemoryBytes, 'metrics.environment.client.totalMemoryBytes'),
        },
        container: { memoryBytes: integer(container.memoryBytes, 'metrics.environment.container.memoryBytes') },
        storage: {
          pg_version: text(storage.pg_version, 'metrics.environment.storage.pg_version'),
          age_version: text(storage.age_version, 'metrics.environment.storage.age_version'),
          vector_version: text(storage.vector_version, 'metrics.environment.storage.vector_version'),
          indexdef: text(storage.indexdef, 'metrics.environment.storage.indexdef'),
        },
        effectiveSettings: {
          adminStatementTimeout: text(effectiveSettings.adminStatementTimeout, 'metrics.environment.effectiveSettings.adminStatementTimeout'),
          runtimeStatementTimeout: text(effectiveSettings.runtimeStatementTimeout, 'metrics.environment.effectiveSettings.runtimeStatementTimeout'),
          exactGroundTruth: {
            statementTimeout: text(exactSettings.statementTimeout, 'metrics.environment.effectiveSettings.exactGroundTruth.statementTimeout'),
            enableIndexScan: text(exactSettings.enableIndexScan, 'metrics.environment.effectiveSettings.exactGroundTruth.enableIndexScan'),
            enableIndexOnlyScan: text(exactSettings.enableIndexOnlyScan, 'metrics.environment.effectiveSettings.exactGroundTruth.enableIndexOnlyScan'),
            enableBitmapScan: text(exactSettings.enableBitmapScan, 'metrics.environment.effectiveSettings.exactGroundTruth.enableBitmapScan'),
            searchPath: text(exactSettings.searchPath, 'metrics.environment.effectiveSettings.exactGroundTruth.searchPath'),
          },
          annSearch: {
            statementTimeout: text(annSettings.statementTimeout, 'metrics.environment.effectiveSettings.annSearch.statementTimeout'),
            jit: text(annSettings.jit, 'metrics.environment.effectiveSettings.annSearch.jit'),
            enableSort: text(annSettings.enableSort, 'metrics.environment.effectiveSettings.annSearch.enableSort'),
            efSearch: text(annSettings.efSearch, 'metrics.environment.effectiveSettings.annSearch.efSearch'),
            iterativeScan: text(annSettings.iterativeScan, 'metrics.environment.effectiveSettings.annSearch.iterativeScan'),
            maxScanTuples: text(annSettings.maxScanTuples, 'metrics.environment.effectiveSettings.annSearch.maxScanTuples'),
            scanMemMultiplier: text(annSettings.scanMemMultiplier, 'metrics.environment.effectiveSettings.annSearch.scanMemMultiplier'),
            ivfflatProbes: text(annSettings.ivfflatProbes, 'metrics.environment.effectiveSettings.annSearch.ivfflatProbes'),
          },
        },
      },
      transactions: {
        commits: integer(transactions.commits, 'metrics.transactions.commits'),
        rollbacks: integer(transactions.rollbacks, 'metrics.transactions.rollbacks'),
        atomic: boolean(transactions.atomic, 'metrics.transactions.atomic'),
        orphanCount: integer(transactions.orphanCount, 'metrics.transactions.orphanCount'),
      },
      agtype: {
        categories: parseAgtypeCategories(agtype.categories),
        parseErrors: integer(agtype.parseErrors, 'metrics.agtype.parseErrors'),
        semanticErrors: integer(agtype.semanticErrors, 'metrics.agtype.semanticErrors'),
        undefinedValues: integer(agtype.undefinedValues, 'metrics.agtype.undefinedValues'),
        precisionLosses: integer(agtype.precisionLosses, 'metrics.agtype.precisionLosses'),
      },
      aclCorrectness: {
        checked: integer(aclCorrectness.checked, 'metrics.aclCorrectness.checked'),
        passed: integer(aclCorrectness.passed, 'metrics.aclCorrectness.passed'),
        scenarios: stringArray(aclCorrectness.scenarios, 'metrics.aclCorrectness.scenarios'),
      },
      hnsw: {
        buildMs: nonNegativeFinite(hnsw.buildMs, 'metrics.hnsw.buildMs'),
        planCount: integer(hnsw.planCount, 'metrics.hnsw.planCount'),
        invalidPlanCount: integer(hnsw.invalidPlanCount, 'metrics.hnsw.invalidPlanCount'),
      },
      preAclCandidates: {
        queryCount: integer(preAcl.queryCount, 'metrics.preAclCandidates.queryCount'),
        mismatchCount: integer(preAcl.mismatchCount, 'metrics.preAclCandidates.mismatchCount'),
      },
      decoyAcl: {
        checked: integer(decoyAcl.checked, 'metrics.decoyAcl.checked'),
        productCalls: integer(decoyAcl.productCalls, 'metrics.decoyAcl.productCalls'),
        allowedRoots: integer(decoyAcl.allowedRoots, 'metrics.decoyAcl.allowedRoots'),
        deniedOutputs: integer(decoyAcl.deniedOutputs, 'metrics.decoyAcl.deniedOutputs'),
      },
      memory: {
        metric: text(memory.metric, 'metrics.memory.metric') as 'cgroup_v2_anon_plus_shmem',
        sampleCount: integer(memory.sampleCount, 'metrics.memory.sampleCount'),
        peakBytes: integer(memory.peakBytes, 'metrics.memory.peakBytes'),
        peakMemoryCurrentBytes: integer(memory.peakMemoryCurrentBytes, 'metrics.memory.peakMemoryCurrentBytes'),
      },
      databaseBytes: integer(metrics.databaseBytes, 'metrics.databaseBytes'),
    },
  };
}

function parseEvidence(value: unknown): PreparedEvidence | AuthoritativeEvidence {
  const input = record(value, 'evidence');
  if (input.schemaVersion !== BENCHMARK_CONTRACT.evidenceVersion) throw new EvidenceValidationError('unsupported evidence schema');
  const bindings = parseBindings(input.bindings);
  const skippedMetrics = stringArray(input.skippedMetrics, 'skippedMetrics');
  if (input.mode === 'PREPARE') {
    if (input.status !== 'PREPARED') throw new EvidenceValidationError('PREPARE status must be PREPARED');
    const setup = record(input.setup, 'setup');
    return { schemaVersion: BENCHMARK_CONTRACT.evidenceVersion, mode: 'PREPARE', status: 'PREPARED', bindings, skippedMetrics,
      setup: { setupDurationMs: nonNegativeFinite(setup.setupDurationMs, 'setup.setupDurationMs') } };
  }
  if (input.mode !== 'AUTHORITATIVE') throw new EvidenceValidationError('mode must be PREPARE or AUTHORITATIVE');
  return parseAuthoritative(input, bindings, skippedMetrics);
}

function bindingReasons(actual: ExpectedBindings, expected: ExpectedBindings): string[] {
  const reasons: string[] = [];
  if (actual.manifestSha256 !== expected.manifestSha256) reasons.push('manifest digest binding mismatch');
  if (actual.commit !== expected.commit) reasons.push('commit binding mismatch');
  if (actual.imageDigest !== expected.imageDigest) reasons.push('image digest binding mismatch');
  if (actual.migrationHash !== expected.migrationHash) reasons.push('migration hash binding mismatch');
  if (actual.target.containerId !== expected.target.containerId) reasons.push('container identity binding mismatch');
  if (actual.target.volume !== expected.target.volume) reasons.push('database volume binding mismatch');
  if (actual.target.bind !== expected.target.bind) reasons.push('database bind binding mismatch');
  if (actual.target.memoryBytes !== expected.target.memoryBytes) reasons.push('container memory binding mismatch');
  return reasons;
}

function timingReasons(name: string, metrics: TimingMetrics, expectedSamples: number): string[] {
  const reasons: string[] = [];
  if (metrics.warmSeconds < BENCHMARK_CONTRACT.timed.warmSeconds) reasons.push(`${name} warm-up is below 30 seconds`);
  if (metrics.passes !== BENCHMARK_CONTRACT.timed.passes) reasons.push(`${name} must contain exactly 3 passes`);
  if (metrics.concurrency !== BENCHMARK_CONTRACT.timed.concurrency) reasons.push(`${name} concurrency must equal 8`);
  if (metrics.sampleCount !== expectedSamples) reasons.push(`${name} timed sample count must equal ${expectedSamples}`);
  if (metrics.errorCount !== 0) reasons.push(`${name} contains query errors`);
  if (metrics.p95Ms > BENCHMARK_CONTRACT.timed.p95Ms) reasons.push(`${name} p95 exceeds 500 ms`);
  if (metrics.p99Ms > BENCHMARK_CONTRACT.timed.p99Ms) reasons.push(`${name} p99 exceeds 1500 ms`);
  const expectedPerPass = expectedSamples / BENCHMARK_CONTRACT.timed.passes;
  for (const pass of metrics.passMetrics) {
    if (pass.sampleCount !== expectedPerPass) reasons.push(`${name} pass ${pass.pass} sample count must equal ${expectedPerPass}`);
    if (pass.errorCount !== 0) reasons.push(`${name} pass ${pass.pass} contains query errors`);
    if (pass.p95Ms > BENCHMARK_CONTRACT.timed.p95Ms) reasons.push(`${name} pass ${pass.pass} p95 exceeds 500 ms`);
    if (pass.p99Ms > BENCHMARK_CONTRACT.timed.p99Ms) reasons.push(`${name} pass ${pass.pass} p99 exceeds 1500 ms`);
  }
  return reasons;
}

function metricReasons(evidence: AuthoritativeEvidence): string[] {
  const metrics = evidence.metrics;
  const reasons = [...timingReasons('graph', metrics.graph, 600), ...timingReasons('ANN', metrics.ann, 1_200)];
  for (const bucket of metrics.ann.buckets) {
    if (bucket.meanRecall < BENCHMARK_CONTRACT.ann.meanRecall) reasons.push(`ANN bucket ${bucket.bucket} mean recall is below 0.95`);
    if (bucket.minimumRecall < BENCHMARK_CONTRACT.ann.minimumRecall) reasons.push(`ANN bucket ${bucket.bucket} contains recall below 0.80`);
    if (bucket.fillRate < BENCHMARK_CONTRACT.ann.fillRate) reasons.push(`ANN bucket ${bucket.bucket} fill rate is below 99%`);
  }
  if (metrics.unauthorizedGraphHits !== 0) reasons.push('unauthorized graph hits are non-zero');
  if (metrics.unauthorizedVectorHits !== 0) reasons.push('unauthorized vector hits are non-zero');
  if (metrics.authorizedAnnLeakage !== 0) reasons.push('authorized ANN results contain unauthorized leakage');
  if (metrics.transactions.commits !== 50 || metrics.transactions.rollbacks !== 50) reasons.push('transaction split must be exactly 50 commits and 50 rollbacks');
  if (!metrics.transactions.atomic || metrics.transactions.orphanCount !== 0) reasons.push('transaction atomicity or orphan gate failed');
  for (const [category, count] of Object.entries(metrics.agtype.categories)) {
    if (count !== 1_000) reasons.push(`agtype ${category} count must equal 1000`);
  }
  if (metrics.agtype.parseErrors !== 0 || metrics.agtype.semanticErrors !== 0
    || metrics.agtype.undefinedValues !== 0 || metrics.agtype.precisionLosses !== 0) reasons.push('agtype decode integrity gate failed');
  if (metrics.hnsw.buildMs > BENCHMARK_CONTRACT.hnswBuildMaxMs) reasons.push('HNSW build exceeds 20 minutes');
  if (metrics.aclCorrectness.checked !== 5 || metrics.aclCorrectness.passed !== 5
    || canonicalSha256(metrics.aclCorrectness.scenarios) !== canonicalSha256([
      'clearance_only', 'allow_below_rank', 'deny_override', 'neither', 'wrong_space',
    ])) reasons.push('ACL correctness scenario gate failed');
  if (metrics.hnsw.planCount !== 400 || metrics.hnsw.invalidPlanCount !== 0) reasons.push('HNSW plans must validate all 400 ANN queries');
  if (metrics.preAclCandidates.queryCount !== 400 || metrics.preAclCandidates.mismatchCount !== 0) reasons.push('pre-ACL candidate counts are incomplete or mislabeled');
  if (metrics.decoyAcl.checked !== 100 || metrics.decoyAcl.productCalls !== 100 || metrics.decoyAcl.allowedRoots !== 100
    || metrics.decoyAcl.deniedOutputs !== 0) reasons.push('decoy ACL gate failed');
  if (metrics.memory.metric !== 'cgroup_v2_anon_plus_shmem') reasons.push('container memory metric identity mismatch');
  if (metrics.memory.sampleCount < 1) reasons.push('container memory sampling produced no samples');
  if (metrics.environment.databaseHost.cpuCount < 1 || metrics.environment.databaseHost.totalMemoryBytes < 1) {
    reasons.push('database host CPU or memory evidence is invalid');
  }
  if (metrics.environment.container.memoryBytes !== evidence.bindings.target.memoryBytes) reasons.push('effective container memory differs from binding');
  if (canonicalSha256(metrics.environment.effectiveSettings) !== canonicalSha256(BENCHMARK_EFFECTIVE_SETTINGS)) {
    reasons.push('effective benchmark settings differ from the frozen contract');
  }
  if (metrics.databaseBytes > BENCHMARK_CONTRACT.databaseMaxBytes) reasons.push('database exceeds 5 GiB');
  if (metrics.memory.peakBytes > BENCHMARK_CONTRACT.rssMaxBytes) reasons.push('cgroup anon+shmem approximation exceeds 8 GiB');
  return reasons;
}

export function validateBenchmarkEvidence(
  value: unknown, expected: ExpectedBindings, rawArtifact?: Uint8Array,
): BenchmarkVerdict {
  const evidence = parseEvidence(value);
  const reasons = bindingReasons(evidence.bindings, expected);
  if (evidence.mode === 'PREPARE') {
    return { schemaVersion: 'wiki-storage-benchmark-verdict/v1', status: reasons.length === 0 ? 'PREPARED' : 'FAIL', pass: false, bindings: evidence.bindings, reasons };
  }
  if (!rawArtifact) throw new EvidenceValidationError('AUTHORITATIVE evidence requires the raw artifact bytes');
  const rawSha256 = createHash('sha256').update(rawArtifact).digest('hex');
  if (rawSha256 !== evidence.rawArtifactSha256) reasons.push('raw artifact digest binding mismatch');
  reasons.push(...rawReconciliationReasons(rawArtifact, evidence));
  if (evidence.skippedMetrics.length > 0) reasons.push(`skipped metrics: ${evidence.skippedMetrics.join(', ')}`);
  reasons.push(...metricReasons(evidence));
  return {
    schemaVersion: 'wiki-storage-benchmark-verdict/v1',
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    pass: reasons.length === 0,
    bindings: evidence.bindings,
    reasons,
  };
}

function rawReconciliationReasons(rawArtifact: Uint8Array, evidence: AuthoritativeEvidence): string[] {
  let input: Record<string, unknown>;
  try { input = record(JSON.parse(Buffer.from(rawArtifact).toString('utf8')), 'rawArtifact'); }
  catch (error) {
    if (error instanceof EvidenceValidationError) throw error;
    throw new EvidenceValidationError('rawArtifact must be valid JSON');
  }
  const array = (value: unknown, path: string): unknown[] => {
    if (!Array.isArray(value)) throw new EvidenceValidationError(`${path} must be an array`);
    return value;
  };
  const parseTimed = (value: unknown, path: string): TimedSample => {
    const row = record(value, path);
    const hits = stringArray(row.hits, `${path}.hits`);
    if (new Set(hits).size !== hits.length) throw new EvidenceValidationError(`${path}.hits contains duplicates`);
    const error = row.error === undefined ? undefined : text(row.error, `${path}.error`);
    return { queryId: text(row.queryId, `${path}.queryId`), pass: integer(row.pass, `${path}.pass`),
      durationMs: nonNegativeFinite(row.durationMs, `${path}.durationMs`), hits, ...(error ? { error } : {}) };
  };
  const graph = array(input.graphSamples, 'rawArtifact.graphSamples')
    .map((value, index) => parseTimed(value, `rawArtifact.graphSamples[${index}]`));
  const ann = array(input.annSamples, 'rawArtifact.annSamples')
    .map((value, index) => parseTimed(value, `rawArtifact.annSamples[${index}]`));
  const plans = array(input.hnswPlans, 'rawArtifact.hnswPlans').map((value, index) => {
    const row = record(value, `rawArtifact.hnswPlans[${index}]`);
    if (!('plan' in row)) throw new EvidenceValidationError(`rawArtifact.hnswPlans[${index}].plan is required`);
    return { queryId: text(row.queryId, `rawArtifact.hnswPlans[${index}].queryId`), plan: row.plan };
  });
  const counts = array(input.preAclCandidates, 'rawArtifact.preAclCandidates').map((value, index) => {
    const row = record(value, `rawArtifact.preAclCandidates[${index}]`);
    return { queryId: text(row.queryId, `rawArtifact.preAclCandidates[${index}].queryId`),
      bucket: integer(row.bucket, `rawArtifact.preAclCandidates[${index}].bucket`),
      actual: integer(row.actual, `rawArtifact.preAclCandidates[${index}].actual`) };
  });
  const queries = record(input.queries, 'rawArtifact.queries');
  const traversalQueries = array(queries.traversal, 'rawArtifact.queries.traversal').map((value, index) => {
    const row = record(value, `rawArtifact.queries.traversal[${index}]`);
    return { id: text(row.id, `rawArtifact.queries.traversal[${index}].id`) };
  });
  const annQueries = array(queries.ann, 'rawArtifact.queries.ann').map((value, index) => {
    const row = record(value, `rawArtifact.queries.ann[${index}]`);
    return { id: text(row.id, `rawArtifact.queries.ann[${index}].id`),
      bucket: integer(row.bucket, `rawArtifact.queries.ann[${index}].bucket`),
      spaceId: text(row.spaceId, `rawArtifact.queries.ann[${index}].spaceId`) };
  });
  const truth = array(input.truth, 'rawArtifact.truth').map((value, index) => {
    const row = record(value, `rawArtifact.truth[${index}]`);
    return { queryId: text(row.queryId, `rawArtifact.truth[${index}].queryId`),
      resultIds: stringArray(row.resultIds, `rawArtifact.truth[${index}].resultIds`) };
  });
  const memorySamples = array(input.memorySamples, 'rawArtifact.memorySamples').map((value, index) => {
    const row = record(value, `rawArtifact.memorySamples[${index}]`);
    return { rssApproximationBytes: integer(row.rssApproximationBytes, `rawArtifact.memorySamples[${index}].rssApproximationBytes`),
      memoryCurrentBytes: integer(row.memoryCurrentBytes, `rawArtifact.memorySamples[${index}].memoryCurrentBytes`) };
  });
  const hitSpaceRows = array(input.annHitSpaces, 'rawArtifact.annHitSpaces').map((value, index) => {
    const row = record(value, `rawArtifact.annHitSpaces[${index}]`);
    return [text(row.nodeId, `rawArtifact.annHitSpaces[${index}].nodeId`),
      text(row.spaceId, `rawArtifact.annHitSpaces[${index}].spaceId`)] as const;
  });
  if (new Set(hitSpaceRows.map(([nodeId]) => nodeId)).size !== hitSpaceRows.length) {
    throw new EvidenceValidationError('rawArtifact.annHitSpaces contains duplicate node IDs');
  }
  const hitSpaces = new Map(hitSpaceRows);
  const bucketSizes = array(input.bucketSizes, 'rawArtifact.bucketSizes').map((value, index) => integer(value, `rawArtifact.bucketSizes[${index}]`));
  const observations = record(input.observations, 'rawArtifact.observations');
  const reasons: string[] = [];
  const uniquePairs = (rows: readonly TimedSample[]) => new Set(rows.map((row) => `${row.queryId}:${row.pass}`)).size;
  const traversalIds = new Set(traversalQueries.map((query) => query.id));
  const annIds = new Set(annQueries.map((query) => query.id));
  if (traversalQueries.length !== 200 || new Set(traversalQueries.map((query) => query.id)).size !== 200
    || graph.length !== 600 || uniquePairs(graph) !== 600
    || graph.some((sample) => !traversalIds.has(sample.queryId) || sample.pass < 1 || sample.pass > 3)) {
    reasons.push('raw graph coverage must contain 200 registered queries across passes 1-3');
  }
  if (annQueries.length !== 400 || new Set(annQueries.map((query) => query.id)).size !== 400
    || ann.length !== 1_200 || uniquePairs(ann) !== 1_200
    || ann.some((sample) => !annIds.has(sample.queryId) || sample.pass < 1 || sample.pass > 3)) {
    reasons.push('raw ANN coverage must contain 400 registered queries across passes 1-3');
  }
  if (new Set(truth.map((row) => row.queryId)).size !== truth.length
    || [...traversalIds, ...annIds].some((id) => !truth.some((row) => row.queryId === id))) {
    reasons.push('raw ground truth coverage is duplicated or incomplete');
  }
  const expected = new Map(truth.map((row) => [row.queryId, row.resultIds]));
  const compare = (label: string, actual: unknown, summary: unknown): void => {
    if (canonicalSha256(actual) !== canonicalSha256(summary)) reasons.push(`raw ${label} does not reconcile with summary evidence`);
  };
  compare('graph timing', timingMetric(graph, expected), evidence.metrics.graph);
  const annTiming = timingMetric(ann);
  const queryById = new Map(annQueries.map((query) => [query.id, query]));
  const recall = (actual: readonly string[], wanted: readonly string[]): number => wanted.length === 0
    ? (actual.length === 0 ? 1 : 0)
    : actual.filter((id) => new Set(wanted).has(id)).length / wanted.length;
  const buckets = [0, 1, 2, 3].map((bucket) => {
    const samples = ann.filter((sample) => queryById.get(sample.queryId)?.bucket === bucket);
    const recalls = samples.map((sample) => recall(sample.hits, expected.get(sample.queryId) ?? []));
    return { bucket, meanRecall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
      minimumRecall: Math.min(...recalls), fillRate: samples.filter((sample) => sample.hits.length === 10).length / samples.length };
  });
  compare('ANN timing and recall', { ...annTiming, buckets }, evidence.metrics.ann);
  const leakage = ann.reduce((sum, sample) => sum + sample.hits.filter((id) =>
    hitSpaces.get(id) !== queryById.get(sample.queryId)?.spaceId).length, 0);
  compare('ANN leakage', leakage, evidence.metrics.authorizedAnnLeakage);
  const hnsw = { buildMs: nonNegativeFinite(observations.hnswBuildMs, 'rawArtifact.observations.hnswBuildMs'),
    ...validateHnswPlans(plans, annQueries.map((query) => query.id)) };
  compare('HNSW observations', hnsw, evidence.metrics.hnsw);
  compare('pre-ACL observations', validatePreAclCandidateCounts(counts, annQueries, bucketSizes), evidence.metrics.preAclCandidates);
  if (memorySamples.length === 0) reasons.push('raw memory sample coverage is empty');
  else compare('memory observations', {
    metric: 'cgroup_v2_anon_plus_shmem', sampleCount: memorySamples.length,
    peakBytes: Math.max(...memorySamples.map((sample) => sample.rssApproximationBytes)),
    peakMemoryCurrentBytes: Math.max(...memorySamples.map((sample) => sample.memoryCurrentBytes)),
  }, evidence.metrics.memory);
  for (const key of ['transactions', 'agtype', 'aclCorrectness', 'decoyAcl', 'environment'] as const) {
    compare(key, record(observations[key], `rawArtifact.observations.${key}`), evidence.metrics[key]);
  }
  for (const key of ['unauthorizedGraphHits', 'unauthorizedVectorHits', 'databaseBytes'] as const) {
    compare(key, integer(observations[key], `rawArtifact.observations.${key}`), evidence.metrics[key]);
  }
  return reasons;
}

export function renderVerdictMarkdown(verdict: BenchmarkVerdict): string {
  const heading = verdict.status === 'PREPARED'
    ? 'Prepared only; this is not a benchmark PASS'
    : `Authoritative verdict: ${verdict.status}`;
  const reasons = verdict.reasons.length === 0 ? '- No threshold failures.' : verdict.reasons.map((reason) => `- ${reason}`).join('\n');
  return `# WIKI-0002 storage benchmark verdict\n\n${heading}\n\n## Bindings\n\n- Manifest: \`${verdict.bindings.manifestSha256}\`\n- Commit: \`${verdict.bindings.commit}\`\n- Image: \`${verdict.bindings.imageDigest}\`\n- Migration: \`${verdict.bindings.migrationHash}\`\n- Container: \`${verdict.bindings.target.containerId}\`\n- Volume: \`${verdict.bindings.target.volume}\`\n- Bind: \`${verdict.bindings.target.bind}\`\n\n## Findings\n\n${reasons}\n`;
}

interface CliOptions extends ExpectedBindings { evidence: string; raw: string; jsonOut: string; markdownOut: string }

function parseArguments(arguments_: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new EvidenceValidationError('arguments must use --key value form');
    values.set(key.slice(2), value);
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new EvidenceValidationError(`missing required --${key}`);
    return value;
  };
  return {
    evidence: required('evidence'), raw: required('raw'), jsonOut: required('json-out'), markdownOut: required('markdown-out'),
    manifestSha256: required('manifest-sha256'), commit: required('commit'),
    imageDigest: required('image-digest'), migrationHash: required('migration-hash'),
    target: {
      containerId: required('database-container-id'), volume: required('database-volume'),
      bind: required('database-bind'), memoryBytes: Number(required('database-memory-bytes')),
    },
  };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(arguments_);
  const [evidenceBytes, rawArtifact] = await Promise.all([readFile(options.evidence, 'utf8'), readFile(options.raw)]);
  const evidence = JSON.parse(evidenceBytes) as unknown;
  const verdict = validateBenchmarkEvidence(evidence, options, rawArtifact);
  await Promise.all([
    writeFile(options.jsonOut, `${JSON.stringify(verdict, null, 2)}\n`),
    writeFile(options.markdownOut, renderVerdictMarkdown(verdict)),
  ]);
  if (!verdict.pass) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => {
    console.error('benchmark evidence is invalid; no verdict artifacts were written');
    process.exitCode = 1;
  });
}

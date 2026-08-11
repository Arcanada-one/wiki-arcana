import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { decodeAgtype } from '../src/storage/adapters/age/agtype.decoder.js';
import { AccessContextPolicy } from '../src/storage/access-context.policy.js';
import { AgeGraphAdapter } from '../src/storage/adapters/age/age-graph.adapter.js';
import { PgvectorVectorAdapter, VECTOR_SEARCH_SETTINGS } from '../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import { PostgresUnitOfWorkAdapter } from '../src/storage/adapters/postgres/postgres-unit-of-work.adapter.js';
import { QueryExecutor } from '../src/storage/adapters/postgres/query-executor.js';
import { POSTGRES_SESSION_OPTIONS } from '../src/storage/adapters/postgres/postgres-session.options.js';
import { READ_ACL_CTE, READ_ACL_PREDICATE } from '../src/storage/adapters/postgres/storage-acl.sql.js';
import type { AccessContext } from '../src/storage/ports/access-context.js';
import type { VectorHit } from '../src/storage/ports/vector.port.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN_PREFIX = 'wiki-storage/';
const FLOAT53_DENOMINATOR = 2 ** 53;
const NODE_COUNTER_BASE = 1_000_000n;
const EDGE_COUNTER_BASE = 2_000_000n;
const QUERY_NOISE_COUNTER_BASE = 10_000_000n;
const STORAGE_MIGRATIONS = [
  ['202607200001_storage_engines', resolve(ROOT, 'prisma/migrations/202607200001_storage_engines/migration.sql')],
  ['202607220001_storage_search_activation', resolve(ROOT, 'prisma/migrations/202607220001_storage_search_activation/migration.sql')],
] as const;
const execFileAsync = promisify(execFile);

export const BENCHMARK_CONTRACT = {
  version: 'wiki-storage-benchmark/v1',
  evidenceVersion: 'wiki-storage-benchmark-evidence/v1',
  seed: 20_260_720n,
  nodeCount: 100_000,
  edgeCount: 300_000,
  targetSpaceSizes: [50_000, 10_000, 1_000, 100] as const,
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
  hnswBuildMaxMs: 20 * 60 * 1_000,
  databaseMaxBytes: 5 * 1_024 ** 3,
  rssMaxBytes: 8 * 1_024 ** 3,
} as const;

export async function storageMigrationHash(): Promise<string> {
  const bytes = await Promise.all(STORAGE_MIGRATIONS.map(([, path]) => readFile(path)));
  return createHash('sha256').update(Buffer.concat(bytes)).digest('hex');
}

async function storageMigrationChecksums(): Promise<Map<string, string>> {
  const bytes = await Promise.all(STORAGE_MIGRATIONS.map(([, path]) => readFile(path)));
  return new Map(STORAGE_MIGRATIONS.map(([name], index) => [
    name,
    createHash('sha256').update(bytes[index]!).digest('hex'),
  ]));
}

export interface DatasetConfig {
  readonly seed: bigint;
  readonly targetSpaceSizes: readonly [number, number, number, number];
  readonly deniedSpaceCount: number;
  readonly deniedSpaceSize: number;
  readonly vectorDimension: number;
  readonly decoyReplacementsPerTarget: number;
  readonly traversalDistributions: readonly [
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
  ];
  readonly annQueriesPerBucket: number;
  readonly unauthorizedGraphQueries: number;
  readonly unauthorizedVectorQueries: number;
}

export const DEFAULT_DATASET_CONFIG: DatasetConfig = {
  seed: BENCHMARK_CONTRACT.seed,
  targetSpaceSizes: BENCHMARK_CONTRACT.targetSpaceSizes,
  deniedSpaceCount: BENCHMARK_CONTRACT.deniedSpaceCount,
  deniedSpaceSize: BENCHMARK_CONTRACT.deniedSpaceSize,
  vectorDimension: BENCHMARK_CONTRACT.vectorDimension,
  decoyReplacementsPerTarget: 25,
  traversalDistributions: [
    [13, 13, 12, 12],
    [12, 13, 13, 12],
    [12, 12, 13, 13],
    [13, 12, 12, 13],
  ],
  annQueriesPerBucket: 100,
  unauthorizedGraphQueries: 20,
  unauthorizedVectorQueries: 50,
};

export const SEED_BATCH_ROWS = {
  nodes: 2_500,
  edges: 2_500,
  vectors: 1_000,
} as const;

export const PROJECTION_REINDEX_SQL = 'REINDEX INDEX knowledge_vector_projections_ivfflat_idx';

export function seedQueryBudget(config: DatasetConfig): {
  readonly nodes: number;
  readonly edges: number;
  readonly vectors: number;
  readonly batchTransactions: number;
  readonly indexLifecycleStatements: number;
  readonly queryCalls: number;
} {
  const nodes = config.targetSpaceSizes.reduce((sum, size) => sum + size, 0)
    + config.deniedSpaceCount * config.deniedSpaceSize;
  const spaces = config.targetSpaceSizes.length + config.deniedSpaceCount;
  const counts = {
    nodes: Math.ceil(nodes / SEED_BATCH_ROWS.nodes),
    edges: Math.ceil((nodes * 3) / SEED_BATCH_ROWS.edges),
    vectors: Math.ceil(nodes / SEED_BATCH_ROWS.vectors),
  };
  const batchTransactions = 1 + counts.nodes + counts.edges + counts.vectors;
  const indexLifecycleStatements = 6;
  const spacesAndGrantsQueries = 4 + Math.ceil(spaces / 100);
  const queryCalls = spacesAndGrantsQueries + counts.nodes * 5 + counts.edges * 5
    + counts.vectors * 4 + indexLifecycleStatements;
  return { ...counts, batchTransactions, indexLifecycleStatements, queryCalls };
}

export interface BenchmarkSpace {
  readonly id: string;
  readonly slug: string;
  readonly size: number;
  readonly offset: number;
  readonly target: boolean;
  readonly bucket?: number;
}

export interface DatasetLayout {
  readonly config: DatasetConfig;
  readonly spaces: readonly BenchmarkSpace[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly subjectId: string;
  readonly grantIds: readonly string[];
  readonly grants: readonly BenchmarkGrant[];
  readonly aclSubjects: Readonly<Record<AclScenarioId, string>>;
  readonly decoyTargets: ReadonlyMap<string, string>;
  readonly decoyDeniedSpaceIds: readonly string[];
}

type AclScenarioId = 'explicit_allow' | 'clearance_only' | 'allow_below_rank' | 'allow_and_clearance'
  | 'deny_override' | 'neither' | 'wrong_space';

interface BenchmarkGrant {
  readonly id: string;
  readonly spaceId: string;
  readonly subjectId: string;
  readonly effect: 'allow' | 'deny';
}

export interface BenchmarkNode {
  readonly id: string;
  readonly spaceId: string;
  readonly globalIndex: number;
  readonly localIndex: number;
}

export interface BenchmarkEdge {
  readonly globalIndex: number;
  readonly id: string;
  readonly spaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: 'LINKS_TO';
  readonly jump: 1 | 7 | 37;
  readonly decoy: boolean;
}

interface QueryBase {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly spaceId: string;
  readonly bucket: number;
  readonly aclScenarioId: AclScenarioId;
  readonly context: AccessContext;
  readonly contextSha256: string;
}

export interface TraversalQuery extends QueryBase { readonly depth: 1 | 2 | 3 | 4 }
export interface AnnQuery extends QueryBase {
  readonly ordinal: number;
  readonly excludeNodeId: string;
  readonly k: 10;
  readonly noiseSigma: 0.01;
  readonly vectorSha256: string;
}
export interface UnauthorizedQuery extends QueryBase { readonly expectedHits: 0 }
export interface BenchmarkQueryManifest {
  readonly traversal: readonly TraversalQuery[];
  readonly ann: readonly AnnQuery[];
  readonly unauthorizedGraph: readonly UnauthorizedQuery[];
  readonly unauthorizedVector: readonly UnauthorizedQuery[];
}

export interface AclCorrectnessProbe {
  readonly scenarioId: Exclude<AclScenarioId, 'explicit_allow' | 'allow_and_clearance'>;
  readonly sourceNodeId: string;
  readonly spaceId: string;
  readonly context: AccessContext;
  readonly expectedAuthorized: boolean;
}

function counterDigest(domain: 'ids' | 'edges' | 'vectors' | 'queries', counter: bigint, seed: bigint): Buffer {
  const seedBytes = Buffer.alloc(8);
  const counterBytes = Buffer.alloc(8);
  seedBytes.writeBigUInt64BE(seed);
  counterBytes.writeBigUInt64BE(counter);
  return createHash('sha256')
    .update(`${DOMAIN_PREFIX}${domain}`, 'utf8')
    .update(Buffer.from([0]))
    .update(seedBytes)
    .update(counterBytes)
    .digest();
}

function uniform(domain: 'edges' | 'vectors' | 'queries', counter: bigint, seed: bigint): number {
  const first53Bits = Number(counterDigest(domain, counter, seed).readBigUInt64BE(0) >> 11n);
  return (first53Bits + 0.5) / FLOAT53_DENOMINATOR;
}

export function deterministicUuid(
  domain: 'ids' | 'queries',
  counter: bigint,
  seed: bigint = BENCHMARK_CONTRACT.seed,
): string {
  const bytes = Buffer.from(counterDigest(domain, counter, seed).subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function gaussianPair(domain: 'vectors' | 'queries', counter: bigint, seed: bigint): readonly [number, number] {
  const first = uniform(domain, counter, seed);
  const second = uniform(domain, counter + 1n, seed);
  const radius = Math.sqrt(-2 * Math.log(first));
  const angle = 2 * Math.PI * second;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function normalizedFloat32(values: readonly number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('deterministic vector normalization failed');
  return values.map((value) => Math.fround(value / norm));
}

export function generateNormalizedVector(
  nodeIndex: number,
  dimension: number = BENCHMARK_CONTRACT.vectorDimension,
  seed: bigint = BENCHMARK_CONTRACT.seed,
): number[] {
  const values: number[] = [];
  const base = BigInt(nodeIndex) * BigInt(dimension);
  for (let axis = 0; axis < dimension; axis += 2) {
    const pair = gaussianPair('vectors', base + BigInt(axis), seed);
    values.push(pair[0]);
    if (values.length < dimension) values.push(pair[1]);
  }
  return normalizedFloat32(values);
}

export function hashFloat32Vector(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return createHash('sha256').update(bytes).digest('hex');
}

function validateConfig(config: DatasetConfig): void {
  const sizes = [...config.targetSpaceSizes, config.deniedSpaceSize];
  if (sizes.some((size) => !Number.isSafeInteger(size) || size <= 37)) throw new Error('space sizes must exceed 37');
  if (config.deniedSpaceCount < 1 || config.vectorDimension < 2) throw new Error('invalid dataset dimensions');
  if (config.decoyReplacementsPerTarget > Math.min(...config.targetSpaceSizes)) throw new Error('too many decoys');
  if (config.annQueriesPerBucket > Math.min(...config.targetSpaceSizes)) throw new Error('too many ANN sources');
}

function nodeId(globalIndex: number, seed: bigint): string {
  return deterministicUuid('ids', NODE_COUNTER_BASE + BigInt(globalIndex), seed);
}

function createSpaces(config: DatasetConfig): BenchmarkSpace[] {
  const spaces: BenchmarkSpace[] = [];
  let offset = 0;
  for (const [bucket, size] of config.targetSpaceSizes.entries()) {
    spaces.push({ id: deterministicUuid('ids', BigInt(bucket), config.seed), slug: `wiki-benchmark-target-${bucket}`, size, offset, target: true, bucket });
    offset += size;
  }
  for (let index = 0; index < config.deniedSpaceCount; index += 1) {
    const ordinal = config.targetSpaceSizes.length + index;
    spaces.push({ id: deterministicUuid('ids', BigInt(ordinal), config.seed), slug: `wiki-benchmark-denied-${index}`, size: config.deniedSpaceSize, offset, target: false });
    offset += config.deniedSpaceSize;
  }
  return spaces;
}

function pickUniqueOffsets(
  size: number,
  count: number,
  startCounter: bigint,
  seed: bigint,
  domain: 'edges' | 'queries' = 'queries',
): number[] {
  const offsets = new Set<number>();
  let counter = startCounter;
  while (offsets.size < count) {
    offsets.add(Math.floor(uniform(domain, counter, seed) * size));
    counter += 1n;
  }
  return [...offsets];
}

function createDecoyTargets(spaces: readonly BenchmarkSpace[], config: DatasetConfig): {
  targets: Map<string, string>; deniedSpaceIds: string[];
} {
  const decoys = new Map<string, string>();
  const deniedSpaceIds = new Set<string>();
  const denied = spaces.filter((space) => !space.target);
  for (const target of spaces.filter((space) => space.target)) {
    const bucket = target.bucket!;
    const offsets = pickUniqueOffsets(target.size, config.decoyReplacementsPerTarget, BigInt(bucket) * 100_000n, config.seed, 'edges');
    offsets.forEach((offset, ordinal) => {
      const counter = BigInt(bucket * config.decoyReplacementsPerTarget + ordinal);
      const deniedSpace = denied[Math.floor(uniform('edges', counter, config.seed) * denied.length)]!;
      const deniedOffset = Math.floor(uniform('edges', counter + 1_000_000n, config.seed) * deniedSpace.size);
      decoys.set(nodeId(target.offset + offset, config.seed), nodeId(deniedSpace.offset + deniedOffset, config.seed));
      deniedSpaceIds.add(deniedSpace.id);
    });
  }
  return { targets: decoys, deniedSpaceIds: [...deniedSpaceIds].sort() };
}

export function createDatasetLayout(config: DatasetConfig = DEFAULT_DATASET_CONFIG): DatasetLayout {
  validateConfig(config);
  const spaces = createSpaces(config);
  const nodeCount = spaces.reduce((sum, space) => sum + space.size, 0);
  const scenarioIds: AclScenarioId[] = [
    'explicit_allow', 'clearance_only', 'allow_below_rank', 'allow_and_clearance',
    'deny_override', 'neither', 'wrong_space',
  ];
  const aclSubjects = Object.fromEntries(scenarioIds.map((scenario, index) => [
    scenario, deterministicUuid('ids', 20_000_000n + BigInt(index), config.seed),
  ])) as Record<AclScenarioId, string>;
  const grants: BenchmarkGrant[] = [];
  const decoys = createDecoyTargets(spaces, config);
  for (const space of spaces.filter((candidate) => candidate.target)) {
    for (const scenario of ['explicit_allow', 'allow_below_rank', 'allow_and_clearance'] as const) {
      grants.push({ id: deterministicUuid('ids', 21_000_000n + BigInt(grants.length), config.seed),
        spaceId: space.id, subjectId: aclSubjects[scenario], effect: 'allow' });
    }
    grants.push({ id: deterministicUuid('ids', 21_000_000n + BigInt(grants.length), config.seed),
      spaceId: space.id, subjectId: aclSubjects.deny_override, effect: 'allow' });
    grants.push({ id: deterministicUuid('ids', 21_000_000n + BigInt(grants.length), config.seed),
      spaceId: space.id, subjectId: aclSubjects.deny_override, effect: 'deny' });
  }
  for (const deniedSpaceId of decoys.deniedSpaceIds) {
    grants.push({ id: deterministicUuid('ids', 21_000_000n + BigInt(grants.length), config.seed),
      spaceId: deniedSpaceId, subjectId: aclSubjects.explicit_allow, effect: 'deny' });
  }
  const wrongSpaceGrantTarget = spaces.filter((space) => space.target)[1]!;
  grants.push({ id: deterministicUuid('ids', 21_000_000n + BigInt(grants.length), config.seed),
    spaceId: wrongSpaceGrantTarget.id, subjectId: aclSubjects.wrong_space, effect: 'allow' });
  return {
    config,
    spaces,
    nodeCount,
    edgeCount: nodeCount * 3,
    subjectId: aclSubjects.explicit_allow,
    grantIds: grants.map((grant) => grant.id),
    grants,
    aclSubjects,
    decoyTargets: decoys.targets,
    decoyDeniedSpaceIds: decoys.deniedSpaceIds,
  };
}

export function* iterateNodes(layout: DatasetLayout): Generator<BenchmarkNode> {
  for (const space of layout.spaces) {
    for (let localIndex = 0; localIndex < space.size; localIndex += 1) {
      const globalIndex = space.offset + localIndex;
      yield { id: nodeId(globalIndex, layout.config.seed), spaceId: space.id, globalIndex, localIndex };
    }
  }
}

export function* iterateEdges(layout: DatasetLayout): Generator<BenchmarkEdge> {
  const jumps = [1, 7, 37] as const;
  let edgeIndex = 0;
  for (const space of layout.spaces) {
    for (let localIndex = 0; localIndex < space.size; localIndex += 1) {
      const sourceNodeId = nodeId(space.offset + localIndex, layout.config.seed);
      for (const jump of jumps) {
        const decoyTarget = jump === 37 ? layout.decoyTargets.get(sourceNodeId) : undefined;
        const targetNodeId = decoyTarget ?? nodeId(space.offset + ((localIndex + jump) % space.size), layout.config.seed);
        yield {
          globalIndex: edgeIndex,
          id: deterministicUuid('ids', EDGE_COUNTER_BASE + BigInt(edgeIndex), layout.config.seed),
          spaceId: space.id,
          sourceNodeId,
          targetNodeId,
          edgeType: 'LINKS_TO',
          jump,
          decoy: decoyTarget !== undefined,
        };
        edgeIndex += 1;
      }
    }
  }
}

function selectedNodes(space: BenchmarkSpace, count: number, counter: bigint, layout: DatasetLayout): BenchmarkNode[] {
  return pickUniqueOffsets(space.size, count, counter, layout.config.seed)
    .map((localIndex) => ({
      id: nodeId(space.offset + localIndex, layout.config.seed),
      spaceId: space.id,
      globalIndex: space.offset + localIndex,
      localIndex,
    }));
}

function annVector(sourceIndex: number, queryOrdinal: number, config: DatasetConfig): number[] {
  const source = generateNormalizedVector(sourceIndex, config.vectorDimension, config.seed);
  const noisy: number[] = [];
  const base = QUERY_NOISE_COUNTER_BASE + BigInt(queryOrdinal * config.vectorDimension);
  for (let axis = 0; axis < config.vectorDimension; axis += 2) {
    const pair = gaussianPair('queries', base + BigInt(axis), config.seed);
    noisy.push(source[axis]! + 0.01 * pair[0]);
    if (noisy.length < config.vectorDimension) noisy.push(source[axis + 1]! + 0.01 * pair[1]);
  }
  return normalizedFloat32(noisy);
}

function contextForScenario(layout: DatasetLayout, scenario: AclScenarioId, spaceId: string): AccessContext {
  const hasAllow = ['explicit_allow', 'allow_below_rank', 'allow_and_clearance', 'deny_override', 'wrong_space'].includes(scenario);
  const hasDeny = scenario === 'deny_override';
  const level = ['clearance_only', 'allow_and_clearance', 'deny_override'].includes(scenario) ? 999 : 0;
  const allowedSpaceId = scenario === 'wrong_space'
    ? layout.spaces.filter((candidate) => candidate.target)[1]!.id
    : spaceId;
  const deny = scenario === 'explicit_allow'
    ? layout.decoyDeniedSpaceIds.map((deniedSpaceId) => ({ spaceId: deniedSpaceId, capability: 'read' as const }))
    : hasDeny ? [{ spaceId, capability: 'read' as const }] : [];
  return {
    subjectId: layout.aclSubjects[scenario], level,
    spaceGrants: {
      allow: hasAllow ? [{ spaceId: allowedSpaceId, capability: 'read' }] : [],
      deny,
    },
  };
}

function queryAclFields(layout: DatasetLayout, scenario: AclScenarioId, spaceId: string): Pick<QueryBase, 'aclScenarioId' | 'context' | 'contextSha256'> {
  const context = contextForScenario(layout, scenario, spaceId);
  return { aclScenarioId: scenario, context, contextSha256: canonicalSha256(context) };
}

export function generateAnnQueryVector(query: AnnQuery, layout: DatasetLayout): number[] {
  const source = [...iterateNodes(layout)].find((node) => node.id === query.sourceNodeId);
  if (!source) throw new Error('ANN source is absent from dataset');
  return annVector(source.globalIndex, query.ordinal, layout.config);
}

function addTraversalQueries(layout: DatasetLayout, queries: TraversalQuery[], nextId: () => string): void {
  const targets = layout.spaces.filter((space) => space.target);
  const selectedByBucket = targets.map((space, bucket) => {
    const count = layout.config.traversalDistributions.reduce((sum, row) => sum + row[bucket]!, 0);
    return selectedNodes(space, count, 1_000_000n + BigInt(bucket) * 100_000n, layout);
  });
  const positions = [0, 0, 0, 0];
  layout.config.traversalDistributions.forEach((distribution, depthIndex) => {
    distribution.forEach((count, bucket) => {
      for (let index = 0; index < count; index += 1) {
        const space = targets[bucket]!;
        const source = selectedByBucket[bucket]![positions[bucket]!]!;
        queries.push({ id: nextId(), sourceNodeId: source.id, spaceId: space.id, bucket,
          ...queryAclFields(layout, 'explicit_allow', space.id), depth: (depthIndex + 1) as 1 | 2 | 3 | 4 });
        positions[bucket]! += 1;
      }
    });
  });
}

function addAnnQueries(layout: DatasetLayout, queries: AnnQuery[], nextId: () => string): void {
  const targets = layout.spaces.filter((space) => space.target);
  for (const [bucket, space] of targets.entries()) {
    const sources = selectedNodes(space, layout.config.annQueriesPerBucket, 2_000_000n + BigInt(bucket) * 100_000n, layout);
    sources.forEach((source) => {
      const id = nextId();
      const vector = annVector(source.globalIndex, queries.length, layout.config);
      queries.push({ id, ordinal: queries.length, sourceNodeId: source.id, excludeNodeId: source.id,
        spaceId: space.id, bucket, ...queryAclFields(layout, 'explicit_allow', space.id),
        k: 10, noiseSigma: 0.01, vectorSha256: hashFloat32Vector(vector) });
    });
  }
}

function pickNodeLocalIndex(id: string, space: BenchmarkSpace, layout: DatasetLayout): number {
  for (let localIndex = 0; localIndex < space.size; localIndex += 1) {
    if (nodeId(space.offset + localIndex, layout.config.seed) === id) return localIndex;
  }
  throw new Error('selected node is absent from its space');
}

function addUnauthorizedQueries(
  layout: DatasetLayout,
  count: number,
  counter: bigint,
  nextId: () => string,
): UnauthorizedQuery[] {
  const denied = layout.spaces.filter((space) => !space.target);
  const queries: UnauthorizedQuery[] = [];
  for (let index = 0; index < count; index += 1) {
    const scenario = (['deny_override', 'neither', 'wrong_space'] as const)[index % 3]!;
    const space = scenario === 'wrong_space'
      ? denied[index % denied.length]!
      : layout.spaces.filter((candidate) => candidate.target)[index % layout.config.targetSpaceSizes.length]!;
    const offset = Math.floor(uniform('queries', counter + BigInt(index), layout.config.seed) * space.size);
    queries.push({ id: nextId(), sourceNodeId: nodeId(space.offset + offset, layout.config.seed), spaceId: space.id,
      bucket: space.bucket ?? -1, ...queryAclFields(layout, scenario, space.id), expectedHits: 0 });
  }
  return queries;
}

export function createQueryManifest(layout: DatasetLayout): BenchmarkQueryManifest {
  let sequence = 0n;
  const nextId = () => deterministicUuid('queries', sequence++, layout.config.seed);
  const traversal: TraversalQuery[] = [];
  const ann: AnnQuery[] = [];
  addTraversalQueries(layout, traversal, nextId);
  addAnnQueries(layout, ann, nextId);
  return {
    traversal,
    ann,
    unauthorizedGraph: addUnauthorizedQueries(layout, layout.config.unauthorizedGraphQueries, 3_000_000n, nextId),
    unauthorizedVector: addUnauthorizedQueries(layout, layout.config.unauthorizedVectorQueries, 4_000_000n, nextId),
  };
}

export function createAclCorrectnessProbes(layout: DatasetLayout): readonly AclCorrectnessProbe[] {
  const target = layout.spaces.find((space) => space.target)!;
  const sourceNodeId = nodeId(target.offset, layout.config.seed);
  return (['clearance_only', 'allow_below_rank', 'deny_override', 'neither', 'wrong_space'] as const)
    .map((scenarioId) => ({
      scenarioId, sourceNodeId, spaceId: target.id,
      context: contextForScenario(layout, scenarioId, target.id),
      expectedAuthorized: ['clearance_only', 'allow_below_rank'].includes(scenarioId),
    }));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('canonical JSON does not support undefined');
  return serialized;
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

const RUN_VARYING_EXPLAIN_KEYS = new Set([
  'Planning Time', 'Execution Time', 'JIT', 'Triggers', 'Workers',
  'Startup Cost', 'Total Cost', 'Plan Rows', 'Plan Width',
  'Rows Removed by Filter', 'Rows Removed by Join Filter', 'Rows Removed by Index Recheck',
  'Heap Fetches', 'Hash Buckets', 'Hash Batches', 'Original Hash Batches', 'Peak Memory Usage',
  'Sort Method', 'Sort Space Used', 'Sort Space Type',
]);

function isRunVaryingExplainKey(key: string): boolean {
  return key.startsWith('Actual ')
    || key.startsWith('Shared ') || key.startsWith('Local ') || key.startsWith('Temp ')
    || key.startsWith('I/O ') || key.startsWith('WAL ')
    || key.startsWith('Workers ') || key.endsWith(' Usage')
    || key.endsWith(' Buckets') || key.endsWith(' Batches')
    || RUN_VARYING_EXPLAIN_KEYS.has(key);
}

export function normalizeExplainPlanEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeExplainPlanEvidence);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isRunVaryingExplainKey(key))
    .map(([key, child]) => [key, normalizeExplainPlanEvidence(child)]));
}

export const EMPTY_RESULT_HASH = canonicalSha256([]);

interface ManifestBindings { readonly commit: string; readonly imageDigest: string; readonly migrationHash: string }

export interface DatasetProof {
  readonly counts: Readonly<Record<string, number>>;
  readonly hashes: Readonly<Record<string, string>>;
}

export interface PreparedManifest {
  readonly version: string;
  readonly seed: string;
  readonly generator: string;
  readonly counts: { readonly spaces: number; readonly nodes: number; readonly edges: number; readonly vectors: number };
  readonly topology: { readonly jumps: readonly number[]; readonly decoyReplacementsPerTarget: number; readonly decoyEdges: number };
  readonly vectorDimension: number;
  readonly spaceGrants: readonly { readonly id: string; readonly subjectId: string; readonly spaceId: string;
    readonly effect: 'allow' | 'deny'; readonly capability: 'read' }[];
  readonly aclScenarios: readonly { readonly queryId: string; readonly scenarioId: AclScenarioId; readonly contextSha256: string }[];
  readonly queryIds: { readonly traversal: readonly string[]; readonly ann: readonly string[]; readonly unauthorizedGraph: readonly string[]; readonly unauthorizedVector: readonly string[] };
  readonly exactResultHashes: readonly { readonly queryId: string; readonly resultHash: string }[];
  readonly queryManifestSha256: string;
  readonly groundTruthSha256: string;
  readonly groundTruthPlansSha256: string;
  readonly datasetProof: DatasetProof;
  readonly bindings: ManifestBindings;
  readonly manifestSha256: string;
}

function allQueries(queries: BenchmarkQueryManifest): readonly QueryBase[] {
  return [...queries.traversal, ...queries.ann, ...queries.unauthorizedGraph, ...queries.unauthorizedVector];
}

function assertQueryAndTruthShape(queries: BenchmarkQueryManifest, truth: readonly GroundTruthRecord[]): void {
  const queryIds = allQueries(queries).map((query) => query.id);
  const truthIds = truth.map((record) => record.queryId);
  if (new Set(queryIds).size !== queryIds.length) throw new Error('query manifest contains duplicate query IDs');
  if (new Set(truthIds).size !== truthIds.length) throw new Error('ground truth contains duplicate query IDs');
  if (queryIds.length !== truthIds.length || queryIds.some((id) => !truthIds.includes(id))) {
    throw new Error('ground truth query IDs do not exactly match the query manifest');
  }
  for (const record of truth) {
    if (record.resultHash !== canonicalSha256(record.resultIds)) throw new Error('ground truth result hash mismatch');
  }
  const unauthorizedIds = new Set([...queries.unauthorizedGraph, ...queries.unauthorizedVector].map((query) => query.id));
  if (truth.some((record) => unauthorizedIds.has(record.queryId)
    && (record.resultIds.length !== 0 || record.resultHash !== EMPTY_RESULT_HASH))) {
    throw new Error('unauthorized query ground truth must use the canonical empty-result hash');
  }
}

function preparedManifestBody(
  layout: DatasetLayout,
  queries: BenchmarkQueryManifest,
  groundTruth: readonly GroundTruthRecord[],
  bindings: ManifestBindings,
  groundTruthPlans: Readonly<Record<string, unknown>>,
  datasetProof: DatasetProof,
): Omit<PreparedManifest, 'manifestSha256'> {
  return {
    version: BENCHMARK_CONTRACT.version,
    seed: layout.config.seed.toString(),
    generator: 'node24-sha256-counter-box-muller-float32-v1',
    counts: { spaces: layout.spaces.length, nodes: layout.nodeCount, edges: layout.edgeCount, vectors: layout.nodeCount },
    topology: { jumps: [1, 7, 37], decoyReplacementsPerTarget: layout.config.decoyReplacementsPerTarget, decoyEdges: layout.decoyTargets.size },
    vectorDimension: layout.config.vectorDimension,
    spaceGrants: layout.grants.map((grant) => ({ ...grant, capability: 'read' as const })),
    aclScenarios: allQueries(queries).map((query) => ({
      queryId: query.id, scenarioId: query.aclScenarioId, contextSha256: query.contextSha256,
    })),
    queryIds: {
      traversal: queries.traversal.map((query) => query.id), ann: queries.ann.map((query) => query.id),
      unauthorizedGraph: queries.unauthorizedGraph.map((query) => query.id), unauthorizedVector: queries.unauthorizedVector.map((query) => query.id),
    },
    exactResultHashes: groundTruth.map((record) => ({ queryId: record.queryId, resultHash: record.resultHash })),
    queryManifestSha256: canonicalSha256(queries),
    groundTruthSha256: canonicalSha256(groundTruth),
    groundTruthPlansSha256: canonicalSha256(normalizeExplainPlanEvidence(groundTruthPlans)),
    datasetProof,
    bindings,
  };
}

export function buildPreparedManifest(
  layout: DatasetLayout,
  queries: BenchmarkQueryManifest,
  groundTruth: readonly GroundTruthRecord[],
  bindings: ManifestBindings,
  groundTruthPlans: Readonly<Record<string, unknown>>,
  datasetProof: DatasetProof,
): PreparedManifest {
  assertQueryAndTruthShape(queries, groundTruth);
  validateExactGroundTruthPlans(groundTruthPlans, queries);
  const body = preparedManifestBody(layout, queries, groundTruth, bindings, groundTruthPlans, datasetProof);
  return { ...body, manifestSha256: canonicalSha256(body) };
}

export function validatePreparedBundle(
  manifest: PreparedManifest,
  queries: BenchmarkQueryManifest,
  groundTruth: readonly GroundTruthRecord[],
  groundTruthPlans: Readonly<Record<string, unknown>>,
  datasetProof: DatasetProof,
  expectedBindings: ManifestBindings,
  expectedLayout?: DatasetLayout,
): void {
  assertQueryAndTruthShape(queries, groundTruth);
  validateExactGroundTruthPlans(groundTruthPlans, queries);
  for (const key of ['commit', 'imageDigest', 'migrationHash'] as const) {
    if (manifest.bindings[key] !== expectedBindings[key]) throw new Error(`${key} binding mismatch`);
  }
  if (manifest.queryManifestSha256 !== canonicalSha256(queries)) throw new Error('query manifest digest mismatch');
  if (manifest.groundTruthSha256 !== canonicalSha256(groundTruth)) throw new Error('ground truth digest mismatch');
  if (manifest.groundTruthPlansSha256 !== canonicalSha256(normalizeExplainPlanEvidence(groundTruthPlans))) {
    throw new Error('ground truth plans digest mismatch');
  }
  if (canonicalSha256(manifest.datasetProof) !== canonicalSha256(datasetProof)) throw new Error('dataset proof binding mismatch');
  const body: Record<string, unknown> = { ...manifest };
  delete body.manifestSha256;
  if (manifest.manifestSha256 !== canonicalSha256(body)) throw new Error('manifest digest mismatch');
  const manifestIds = Object.values(manifest.queryIds).flat();
  const queryIds = allQueries(queries).map((query) => query.id);
  if (canonicalSha256(manifestIds) !== canonicalSha256(queryIds)) throw new Error('manifest query IDs mismatch');
  const hashes = groundTruth.map((record) => ({ queryId: record.queryId, resultHash: record.resultHash }));
  if (canonicalSha256(manifest.exactResultHashes) !== canonicalSha256(hashes)) throw new Error('manifest exact-result hashes mismatch');
  if (expectedLayout !== undefined) {
    const canonicalQueries = createQueryManifest(expectedLayout);
    if (canonicalSha256(queries) !== canonicalSha256(canonicalQueries)) throw new Error('query workload does not match the frozen canonical workload');
    if (manifest.counts.nodes !== expectedLayout.nodeCount || manifest.counts.edges !== expectedLayout.edgeCount
      || manifest.vectorDimension !== expectedLayout.config.vectorDimension) throw new Error('manifest workload scale mismatch');
  }
}

export function validateExactGroundTruthPlans(
  plans: Readonly<Record<string, unknown>>,
  queries: BenchmarkQueryManifest,
): { readonly planCount: number; readonly invalidPlanCount: number } {
  const expectedIds = allQueries(queries).map((query) => query.id);
  const planIds = Object.keys(plans);
  if (planIds.length !== expectedIds.length || new Set(planIds).size !== expectedIds.length
    || expectedIds.some((id) => !(id in plans))) {
    throw new Error('exact ground-truth plans do not cover every query exactly once');
  }
  const vectorIds = new Set([...queries.ann, ...queries.unauthorizedVector].map((query) => query.id));
  const invalidPlanCount = planIds.filter((id) => {
    if (!vectorIds.has(id)) return false;
    const nodes = collectPlanNodes(plans[id]);
    const vectorNodes = nodes.filter((node) => node['Relation Name'] === 'knowledge_vectors');
    return !vectorNodes.some((node) => node['Node Type'] === 'Seq Scan')
      || vectorNodes.some((node) => typeof node['Index Name'] === 'string'
        || String(node['Node Type'] ?? '').includes('Index')
        || String(node['Node Type'] ?? '').includes('Bitmap'));
  }).length;
  if (invalidPlanCount !== 0) throw new Error('exact ground-truth plans must use sequential evaluation without HNSW');
  return { planCount: planIds.length, invalidPlanCount };
}

function collectPlanNodes(value: unknown): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (candidate === null || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    if (typeof record['Node Type'] === 'string') output.push(record);
    if ('Plan' in record) visit(record.Plan);
    if ('Plans' in record) visit(record.Plans);
  };
  visit(value);
  return output;
}

export interface VectorHashRow { readonly nodeId: string; readonly vector: readonly number[] }

export function hashVectorRows(rows: readonly VectorHashRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${canonicalJson([row.nodeId, hashFloat32Vector(row.vector)])}\n`);
  return hash.digest('hex');
}

export function parseCgroupMemorySample(memoryStat: string, memoryCurrent: string): {
  rssApproximationBytes: number; memoryCurrentBytes: number;
} {
  const fields = new Map(memoryStat.trim().split('\n').filter(Boolean).map((line) => {
    const match = /^(\S+) (\d+)$/.exec(line);
    if (!match) throw new Error('cgroup v2 memory.stat is malformed');
    return [match[1]!, Number(match[2])] as const;
  }));
  const anon = fields.get('anon');
  const shmem = fields.get('shmem');
  const current = /^\d+$/.test(memoryCurrent.trim()) ? Number(memoryCurrent.trim()) : Number.NaN;
  if (!Number.isSafeInteger(anon) || !Number.isSafeInteger(shmem) || !Number.isSafeInteger(current)) {
    throw new Error('cgroup v2 memory evidence omits numeric anon, shmem, or memory.current');
  }
  return { rssApproximationBytes: anon! + shmem!, memoryCurrentBytes: current };
}

interface DockerTargetExpectation {
  readonly container: string;
  readonly volume: string;
  readonly imageDigest: string;
  readonly bind: string;
  readonly memoryBytes: number;
}

const POSTGRES_VOLUME_ROOT = '/var/lib/postgresql';
const REGISTRY_ROOT_SPACE = ['01981c60-0000-7000-8000-000000000001', 'arcanada', 'Arcanada', 'public', 'linked'] as const;
const ACCESS_LEVEL_BASELINE = [
  ['public', 0, 'Public', 'Open knowledge spaces'],
  ['archivist', 10, 'Archivist', 'Curated operational knowledge'],
  ['council', 20, 'Council', 'Council-restricted knowledge'],
  ['holocron', 30, 'Hidden Holocron', 'Highest-clearance compartment'],
] as const;

export interface DockerTargetEvidence {
  readonly containerId: string;
  readonly imageDigest: string;
  readonly volume: string;
  readonly volumeDestination: string;
  readonly bind: string;
  readonly memoryBytes: number;
}

export interface DockerHostEvidence {
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
  readonly architecture: string;
  readonly operatingSystem: string;
  readonly name: string;
  readonly serverVersion: string;
}

export function validateDockerHostInfo(value: unknown): DockerHostEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Docker host info is malformed');
  const item = value as Record<string, unknown>;
  const requiredText = (key: string): string => {
    const candidate = item[key];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) throw new Error(`Docker host info omits ${key}`);
    return candidate;
  };
  if (!Number.isInteger(item.NCPU) || Number(item.NCPU) <= 0) throw new Error('Docker host CPU count is invalid');
  if (!Number.isInteger(item.MemTotal) || Number(item.MemTotal) <= 0) throw new Error('Docker host memory is invalid');
  return {
    cpuCount: Number(item.NCPU), totalMemoryBytes: Number(item.MemTotal),
    architecture: requiredText('Architecture'), operatingSystem: requiredText('OperatingSystem'),
    name: requiredText('Name'), serverVersion: requiredText('ServerVersion'),
  };
}

export function validateDockerTargetInspection(value: unknown, expected: DockerTargetExpectation): DockerTargetEvidence {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('Docker inspect must return exactly one container');
  const item = value[0] as Record<string, unknown>;
  const mounts = item.Mounts as { Type?: string; Name?: string; Destination?: string }[] | undefined;
  const mount = mounts?.find((candidate) => candidate.Type === 'volume' && candidate.Name === expected.volume);
  if (!mount?.Destination) throw new Error('Docker database volume binding mismatch');
  if (mount.Destination !== POSTGRES_VOLUME_ROOT) throw new Error('Docker database volume destination mismatch');
  if (item.Image !== expected.imageDigest) throw new Error('Docker image digest mismatch');
  const memory = (item.HostConfig as { Memory?: unknown } | undefined)?.Memory;
  if (memory !== expected.memoryBytes) throw new Error('Docker memory limit mismatch');
  const [hostIp, hostPort] = expected.bind.split(':');
  const ports = (item.NetworkSettings as { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> } | undefined)?.Ports;
  const binding = ports?.['5432/tcp']?.find((candidate) => candidate.HostIp === hostIp && candidate.HostPort === hostPort);
  if (!binding) throw new Error('Docker bind identity mismatch');
  if (typeof item.Id !== 'string' || item.Id.length === 0) throw new Error('Docker container identity is missing');
  return { containerId: item.Id, imageDigest: expected.imageDigest, volume: expected.volume,
    volumeDestination: mount.Destination, bind: expected.bind, memoryBytes: expected.memoryBytes };
}

export interface DatabaseServerIdentity {
  readonly systemIdentifier: string;
  readonly database: string;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly dataDirectory: string;
}

interface DatabaseEndpointIdentity {
  readonly database: string;
  readonly serverAddress: string;
  readonly serverPort: number;
}

export function validateDatabaseUrlBindings(
  adminUrl: string,
  runtimeUrl: string,
): { database: string; adminUser: string } {
  const parse = (raw: string, label: string) => {
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new Error(`${label} database URL is invalid`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${label} database URL protocol is invalid`);
    const hostname = url.hostname.toLowerCase();
    if (!(hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname))) {
      throw new Error(`${label} database URL endpoint must be loopback`);
    }
    const port = url.port || '5432';
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!database) throw new Error(`${label} database URL omits database name`);
    const user = decodeURIComponent(url.username);
    if (!user) throw new Error(`${label} database URL omits user`);
    return { database, endpoint: `${hostname}:${port}`, user };
  };
  const admin = parse(adminUrl, 'admin');
  const runtime = parse(runtimeUrl, 'runtime');
  if (admin.endpoint !== runtime.endpoint) throw new Error('admin and runtime database URL endpoints differ');
  if (admin.database !== runtime.database) throw new Error('admin and runtime database URLs target different databases');
  return { database: admin.database, adminUser: admin.user };
}

export function validateDatabaseServerIdentity(
  admin: DatabaseServerIdentity,
  runtime: DatabaseEndpointIdentity,
  containerSystemIdentifier: string,
  target: DockerTargetEvidence,
  expectedDatabase: string,
): DatabaseServerIdentity {
  if (admin.database !== runtime.database || admin.serverAddress !== runtime.serverAddress
    || admin.serverPort !== runtime.serverPort) {
    throw new Error('admin and runtime PostgreSQL server identity mismatch');
  }
  if (admin.database !== expectedDatabase) throw new Error('PostgreSQL database identity does not match database URLs');
  if (!/^\d+$/.test(admin.systemIdentifier) || !/^\d+$/.test(containerSystemIdentifier)
    || admin.systemIdentifier !== containerSystemIdentifier) throw new Error('PostgreSQL system identity does not match inspected Docker container');
  const volumeRoot = posix.resolve(target.volumeDestination);
  const dataDirectory = posix.resolve(admin.dataDirectory);
  if (!isAbsolute(admin.dataDirectory)
    || (dataDirectory !== volumeRoot && !dataDirectory.startsWith(`${volumeRoot}/`))) {
    throw new Error('PostgreSQL data_directory is outside inspected Docker volume root');
  }
  return admin;
}

export async function cycleWarmupCases<T>(
  cases: readonly T[],
  seconds: number,
  run: (item: T) => Promise<unknown>,
  now: () => number = () => performance.now(),
  concurrency = 1,
): Promise<void> {
  if (cases.length === 0) throw new Error('warm-up requires registered cases');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('warm-up concurrency must be a positive integer');
  const deadline = now() + seconds * 1_000;
  let index = 0;
  do {
    const batch = Array.from({ length: concurrency }, (_, offset) => cases[(index + offset) % cases.length]!);
    await Promise.all(batch.map((item) => run(item)));
    index += batch.length;
  } while (now() < deadline || index < cases.length);
}

export function interleaveWarmupCases<T>(cases: readonly T[], bucket: (item: T) => number): readonly T[] {
  if (cases.length === 0) return [];
  const groups = new Map<number, T[]>();
  for (const item of cases) groups.set(bucket(item), [...(groups.get(bucket(item)) ?? []), item]);
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => left - right).map(([, items]) => items);
  return Array.from({ length: Math.max(...orderedGroups.map((items) => items.length)) }, (_, index) =>
    orderedGroups.map((items) => items[index]).filter((item): item is T => item !== undefined)).flat();
}

interface TransactionCaseResult {
  readonly outcome: 'commit' | 'rollback';
  readonly relationalPresent: boolean;
  readonly agePresent: boolean;
  readonly vectorPresent: boolean;
}

export function summarizeTransactionCases(results: readonly TransactionCaseResult[]): { commits: number; rollbacks: number; atomic: boolean; orphanCount: number } {
  const commits = results.filter((result) => result.outcome === 'commit').length;
  const rollbacks = results.length - commits;
  let orphanCount = 0;
  for (const result of results) {
    const expected = result.outcome === 'commit';
    if ([result.relationalPresent, result.agePresent, result.vectorPresent].some((present) => present !== expected)) orphanCount += 1;
  }
  return { commits, rollbacks, atomic: results.length === 100 && commits === 50 && rollbacks === 50 && orphanCount === 0, orphanCount };
}

const AGTYPE_CATEGORIES = ['null', 'bool', 'int64', 'float', 'string', 'list', 'map', 'vertex', 'edge', 'path'] as const;
type AgtypeCategory = typeof AGTYPE_CATEGORIES[number];
interface AgtypeCorpusRow {
  readonly category: AgtypeCategory;
  readonly ordinal: number;
  readonly encoded: unknown;
  readonly expected?: unknown;
}

function validAgtypeShape(category: AgtypeCategory, value: unknown): boolean {
  if (category === 'null') return value === null;
  if (category === 'bool') return typeof value === 'boolean';
  if (category === 'int64') return typeof value === 'bigint';
  if (category === 'float') return typeof value === 'number' && Number.isFinite(value);
  if (category === 'string') return typeof value === 'string';
  if (category === 'list' || category === 'path') return Array.isArray(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (category === 'vertex') return 'id' in object && 'label' in object && 'properties' in object;
  if (category === 'edge') return 'start_id' in object && 'end_id' in object && 'properties' in object;
  return true;
}

function validAgtypeSemantics(category: AgtypeCategory, ordinal: number, value: unknown): boolean {
  const cypherIndex = ordinal + 1;
  if (category === 'null') return value === null;
  if (category === 'bool') return value === (cypherIndex % 2 === 0);
  if (category === 'int64') return value === (ordinal % 2 === 0
    ? 9_223_372_036_854_775_807n : -9_223_372_036_854_775_808n);
  if (category === 'float') return value === cypherIndex + 0.5;
  if (category === 'string') return value === 'escaped\n"value';
  if (category === 'list') return canonicalSha256(value) === canonicalSha256([cypherIndex, true, null]);
  if (category === 'map') return canonicalSha256(value) === canonicalSha256({ value: cypherIndex });
  if (category === 'vertex') return validAgtypeShape(category, value)
    && (value as Record<string, unknown>).label === 'KnowledgeNode';
  if (category === 'edge') return validAgtypeShape(category, value)
    && (value as Record<string, unknown>).label === 'KNOWLEDGE_EDGE';
  return Array.isArray(value) && value.length >= 3 && value.length % 2 === 1;
}

function agtypeSemanticProjection(category: AgtypeCategory, value: unknown): unknown {
  if (category === 'vertex' && value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return { label: item.label, properties: item.properties };
  }
  if (category === 'edge' && value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return { label: item.label, properties: item.properties };
  }
  if (category === 'path' && Array.isArray(value)) {
    return value.map((item) => agtypeSemanticProjection(
      item && typeof item === 'object' && 'start_id' in item ? 'edge' : 'vertex', item,
    ));
  }
  return value;
}

export function summarizeAgtypeCorpus(rows: readonly AgtypeCorpusRow[], expectedPerCategory = 1_000): {
  categories: Record<AgtypeCategory, number>; parseErrors: number; semanticErrors: number;
  undefinedValues: number; precisionLosses: number;
} {
  const categories = Object.fromEntries(AGTYPE_CATEGORIES.map((category) => [category, 0])) as Record<AgtypeCategory, number>;
  let parseErrors = 0;
  let undefinedValues = 0;
  let precisionLosses = 0;
  let semanticErrors = 0;
  for (const row of rows) {
    categories[row.category] += 1;
    try {
      const decoded = decodeAgtype(row.encoded);
      if (decoded === undefined) undefinedValues += 1;
      if (!validAgtypeShape(row.category, decoded)) parseErrors += 1;
      else if (row.expected !== undefined
        ? !isDeepStrictEqual(agtypeSemanticProjection(row.category, decoded), row.expected)
        : !validAgtypeSemantics(row.category, row.ordinal, decoded)) semanticErrors += 1;
      if (row.category === 'int64') {
        const expected = row.ordinal % 2 === 0 ? 9_223_372_036_854_775_807n : -9_223_372_036_854_775_808n;
        if (decoded !== expected) precisionLosses += 1;
      }
    } catch { parseErrors += 1; }
  }
  for (const count of Object.values(categories)) if (count !== expectedPerCategory) parseErrors += 1;
  return { categories, parseErrors, semanticErrors, undefinedValues, precisionLosses };
}

export function validateHnswPlans(
  plans: readonly { readonly queryId: string; readonly plan: unknown }[],
  expectedQueryIds: readonly string[],
): { planCount: number; invalidPlanCount: number } {
  const expected = new Set(expectedQueryIds);
  const invalidPlanCount = plans.filter((item) => {
    if (!expected.has(item.queryId)) return true;
    return !collectPlanNodes(item.plan).some((node) =>
      node['Relation Name'] === 'knowledge_vectors'
      && node['Index Name'] === 'knowledge_vectors_embedding_hnsw_idx'
      && ['Index Scan', 'Index Only Scan'].includes(String(node['Node Type'])));
  }).length;
  if (plans.length !== expected.size || new Set(plans.map((item) => item.queryId)).size !== expected.size) {
    throw new Error('HNSW plans do not cover every ANN query exactly once');
  }
  return { planCount: plans.length, invalidPlanCount };
}

export function validatePreAclCandidateCounts(
  counts: readonly { readonly queryId: string; readonly bucket: number; readonly actual: number }[],
  queries: readonly { readonly id: string; readonly bucket: number }[],
  bucketSizes: readonly number[],
): { queryCount: number; mismatchCount: number } {
  const expected = new Map(queries.map((query) => [query.id, query.bucket]));
  const mismatchCount = counts.filter((record) => expected.get(record.queryId) !== record.bucket
    || record.actual !== bucketSizes[record.bucket]! - 1).length;
  if (counts.length !== queries.length || new Set(counts.map((record) => record.queryId)).size !== queries.length) {
    throw new Error('pre-ACL counts do not cover every ANN query exactly once');
  }
  return { queryCount: counts.length, mismatchCount };
}

export function summarizeDecoyAclChecks(
  checks: readonly { readonly allowedRoot: boolean; readonly deniedOutputs: number }[],
  expectedCount: number = BENCHMARK_CONTRACT.decoyEdges,
): { checked: number; allowedRoots: number; deniedOutputs: number } {
  if (checks.length !== expectedCount) throw new Error('decoy ACL checks do not cover every replacement edge');
  return { checked: checks.length, allowedRoots: checks.filter((check) => check.allowedRoot).length,
    deniedOutputs: checks.reduce((sum, check) => sum + check.deniedOutputs, 0) };
}

export async function runDecoyProductChecks(
  graph: Pick<AgeGraphAdapter, 'traverse'>, layout: DatasetLayout,
): Promise<readonly { sourceNodeId: string; deniedTargetId: string; context: AccessContext;
  allowedRoot: boolean; deniedOutputs: number }[]> {
  const wanted = new Set([...layout.decoyTargets.keys(), ...layout.decoyTargets.values()]);
  const nodeSpaces = new Map<string, string>();
  for (const node of iterateNodes(layout)) if (wanted.has(node.id)) nodeSpaces.set(node.id, node.spaceId);
  const checks = [];
  for (const [sourceNodeId, deniedTargetId] of layout.decoyTargets) {
    const sourceSpaceId = nodeSpaces.get(sourceNodeId);
    const deniedSpaceId = nodeSpaces.get(deniedTargetId);
    if (!sourceSpaceId || !deniedSpaceId) throw new Error('decoy source or destination space is absent');
    const context: AccessContext = {
      subjectId: layout.aclSubjects.explicit_allow, level: 0,
      spaceGrants: { allow: [{ spaceId: sourceSpaceId, capability: 'read' }],
        deny: [{ spaceId: deniedSpaceId, capability: 'read' }] },
    };
    const results = await graph.traverse(context, { startNodeId: sourceNodeId, maxDepth: 1 });
    checks.push({ sourceNodeId, deniedTargetId, context, allowedRoot: results.length > 0,
      deniedOutputs: results.filter((node) => node.id === deniedTargetId).length });
  }
  return checks;
}

export interface GateBBindings {
  readonly manifestSha256: string;
  readonly commit: string;
  readonly imageDigest: string;
  readonly migrationHash: string;
  readonly containerId: string;
  readonly volume: string;
  readonly bind: string;
}

interface GateEvidence {
  readonly gate: 'B';
  readonly authorized: true;
  readonly payload: GateBApprovalPayload;
  readonly hmacSha256: string;
}

interface GateBApprovalPayload {
  readonly bindings: GateBBindings;
  readonly command: { readonly argv: readonly string[]; readonly sha256: string };
}

export function gateBApprovalPacketTemplate(
  bindings: GateBBindings, argv: readonly string[],
): {
  readonly payload: GateBApprovalPayload;
  readonly canonicalPayload: string;
  readonly evidenceTemplate: GateEvidence;
  readonly hmacGeneration: string;
} {
  const payload = { bindings, command: { argv, sha256: canonicalSha256(argv) } };
  return {
    payload,
    canonicalPayload: canonicalJson(payload),
    evidenceTemplate: { gate: 'B', authorized: true, payload, hmacSha256: '<lowercase post-approval HMAC-SHA256 hex>' },
    hmacGeneration: 'After operator Gate-B approval only: compute HMAC-SHA256 using the exact bytes of the separate mode-0600 key file over canonicalJson(payload); store only the lowercase hex digest as hmacSha256.',
  };
}

export async function assertAuthoritativeGate(
  evidencePath: string | undefined,
  tokenPath: string | undefined,
  expectedBindings: GateBBindings,
  expectedArgv: readonly string[],
): Promise<GateEvidence> {
  if (!evidencePath || !tokenPath) throw new Error('Gate-B authorization evidence and token file are required');
  try {
    await Promise.all([assertSecretFilePermissions(evidencePath), assertSecretFilePermissions(tokenPath)]);
    const [evidenceRaw, tokenRaw] = await Promise.all([readFile(evidencePath, 'utf8'), readFile(tokenPath)]);
    if (tokenRaw.length < 32) throw new Error('HMAC key is shorter than 32 bytes');
    const evidence = JSON.parse(evidenceRaw) as Partial<GateEvidence>;
    const expectedPayload = gateBApprovalPacketTemplate(expectedBindings, expectedArgv).payload;
    const actual = createHmac('sha256', tokenRaw).update(canonicalJson(expectedPayload)).digest();
    if (!/^[0-9a-f]{64}$/.test(evidence.hmacSha256 ?? '')) throw new Error('authorization digest is malformed');
    const expected = Buffer.from(evidence.hmacSha256!, 'hex');
    if (evidence.gate !== 'B' || evidence.authorized !== true || !timingSafeEqual(actual, expected)) {
      throw new Error('authorization mismatch');
    }
    if (canonicalSha256(evidence.payload) !== canonicalSha256(expectedPayload)) throw new Error('approval payload mismatch');
    await writeFile(`${evidencePath}.consumed`, `${JSON.stringify({
      consumedAt: new Date().toISOString(), payloadSha256: canonicalSha256(expectedPayload),
    })}\n`, { flag: 'wx', mode: 0o600 });
    return evidence as GateEvidence;
  } catch {
    throw new Error('Gate-B authorization evidence is invalid');
  }
}

export function authoritativeCommandArgv(options: CliOptions, artifactsDir: string): readonly string[] {
  return [
    'pnpm', 'storage:benchmark', '--',
    '--artifacts-dir', artifactsDir,
    '--database-container', options.databaseContainer,
    '--database-volume', options.databaseVolume,
    '--database-bind', options.databaseBind,
    '--admin-url-file', options.adminUrlFile,
    '--runtime-url-file', options.runtimeUrlFile,
    '--commit', options.commit,
    '--image-digest', options.imageDigest,
    '--migration-hash', options.migrationHash,
    '--gate-b-evidence', options.gateEvidence ?? '',
    '--gate-b-token-file', options.gateTokenFile ?? '',
  ];
}

// Database preparation and timed execution are kept below the pure generator so
// the deterministic contract can be tested without touching a database.
export interface CliOptions {
  readonly mode: 'PREPARE' | 'SEED' | 'AUTHORITATIVE';
  readonly artifactsDir: string;
  readonly databaseContainer: string;
  readonly databaseVolume: string;
  readonly databaseBind: string;
  readonly adminUrlFile: string;
  readonly runtimeUrlFile: string;
  readonly commit: string;
  readonly imageDigest: string;
  readonly migrationHash: string;
  readonly gateEvidence?: string;
  readonly gateTokenFile?: string;
}

export interface BindingEvidence {
  readonly manifestSha256: string;
  readonly commit: string;
  readonly imageDigest: string;
  readonly migrationHash: string;
}

export interface GroundTruthRecord { readonly queryId: string; readonly resultIds: readonly string[]; readonly resultHash: string }

export function parseBenchmarkArguments(arguments_: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let separatorSeen = false;
  for (let index = 0; index < arguments_.length;) {
    const key = arguments_[index];
    if (key === '--') {
      if (separatorSeen) throw new Error('arguments may contain at most one standalone -- separator');
      separatorSeen = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || key.length <= 2 || value === undefined || value.startsWith('--')) {
      throw new Error('arguments must use --key value form');
    }
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`duplicate --${name} argument`);
    values.set(name, value);
    index += 2;
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`missing required --${key}`);
    return value;
  };
  const mode = required('mode').toUpperCase();
  if (!['PREPARE', 'SEED', 'AUTHORITATIVE'].includes(mode)) throw new Error('invalid benchmark mode');
  return {
    mode: mode as CliOptions['mode'],
    artifactsDir: required('artifacts-dir'),
    databaseContainer: required('database-container'),
    databaseVolume: required('database-volume'),
    databaseBind: required('database-bind'),
    adminUrlFile: required('admin-url-file'),
    runtimeUrlFile: required('runtime-url-file'),
    commit: required('commit'),
    imageDigest: required('image-digest'),
    migrationHash: required('migration-hash'),
    gateEvidence: values.get('gate-b-evidence'),
    gateTokenFile: values.get('gate-b-token-file'),
  };
}

function validateBindings(options: CliOptions, migrationHash: string): void {
  if (!/^[0-9a-f]{40}$/i.test(options.commit)) throw new Error('commit binding must be a 40-character SHA');
  if (!/^sha256:[0-9a-f]{64}$/i.test(options.imageDigest)) throw new Error('image binding must be a sha256 digest');
  if (!/^[0-9a-f]{64}$/i.test(options.migrationHash) || options.migrationHash !== migrationHash) {
    throw new Error('migration binding does not match the repository migration');
  }
}

export interface GitCheckoutEvidence { readonly head: string; readonly statusPorcelain: string }

export function validateGitCheckoutBinding(expectedCommit: string, evidence: GitCheckoutEvidence): GitCheckoutEvidence {
  if (!/^[0-9a-f]{40}$/.test(evidence.head) || evidence.head !== expectedCommit.toLowerCase()) {
    throw new Error('commit binding does not match executing Git HEAD');
  }
  if (evidence.statusPorcelain.trim().length !== 0) throw new Error('executing Git checkout is dirty or contains untracked files');
  return evidence;
}

async function inspectGitCheckout(expectedCommit: string): Promise<GitCheckoutEvidence> {
  const [head, statusResult] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }),
  ]);
  return validateGitCheckoutBinding(expectedCommit, {
    head: head.stdout.trim().toLowerCase(), statusPorcelain: statusResult.stdout,
  });
}

async function assertExternalArtifactPath(
  artifactsDir: string, mode: 'PREPARE' | 'SEED' | 'AUTHORITATIVE',
): Promise<string> {
  if (!isAbsolute(artifactsDir)) throw new Error('artifact path must be absolute');
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const canonical = await realpath(artifactsDir);
  const entries = await readdir(canonical);
  if (mode !== 'AUTHORITATIVE' && entries.length > 0) throw new Error('artifact run directory must be fresh and empty');
  if (mode === 'AUTHORITATIVE' && entries.some((entry) =>
    ['authoritative-raw.json', 'authoritative-evidence.json'].includes(entry))) {
    throw new Error('stale authoritative evidence exists in artifact run directory');
  }
  return canonical;
}

export async function assertSecretFilePermissions(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('database URL secret file must be a regular file with mode 0600 or stricter');
  }
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

async function inspectDockerTarget(options: CliOptions): Promise<DockerTargetEvidence> {
  const result = await execFileAsync('docker', ['inspect', options.databaseContainer], { encoding: 'utf8', timeout: 10_000 });
  return validateDockerTargetInspection(JSON.parse(result.stdout), {
    container: options.databaseContainer,
    volume: options.databaseVolume,
    imageDigest: options.imageDigest,
    bind: options.databaseBind,
    memoryBytes: BENCHMARK_CONTRACT.rssMaxBytes,
  });
}

async function inspectDockerHost(): Promise<DockerHostEvidence> {
  const result = await execFileAsync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 10_000 });
  return validateDockerHostInfo(JSON.parse(result.stdout));
}

async function readDatabaseEndpointIdentity(pool: Pool): Promise<DatabaseEndpointIdentity> {
  const result = await pool.query<DatabaseEndpointIdentity>(`SELECT
    current_database() AS database,
    inet_server_addr()::text AS "serverAddress",
    inet_server_port()::int AS "serverPort"`);
  const identity = result.rows[0];
  if (!identity) throw new Error('PostgreSQL server identity query returned no rows');
  return identity;
}

async function readDatabaseServerIdentity(pool: Pool): Promise<DatabaseServerIdentity> {
  const [endpoint, result] = await Promise.all([
    readDatabaseEndpointIdentity(pool),
    pool.query<{ systemIdentifier: string; dataDirectory: string }>(
      `SELECT (pg_control_system()).system_identifier::text AS "systemIdentifier",
        current_setting('data_directory') AS "dataDirectory"`,
    ),
  ]);
  const details = result.rows[0];
  if (!details) throw new Error('PostgreSQL admin identity query returned no rows');
  return { ...endpoint, ...details };
}

async function readContainerSystemIdentifier(container: string, user: string, database: string): Promise<string> {
  const result = await execFileAsync('docker', [
    'exec', container, 'psql', '-U', user, '-d', database, '-Atqc',
    'SELECT (pg_control_system()).system_identifier::text',
  ], { encoding: 'utf8', timeout: 10_000 });
  const systemIdentifier = result.stdout.trim();
  if (!/^\d+$/.test(systemIdentifier)) throw new Error('inspected Docker container system identity is malformed');
  return systemIdentifier;
}

async function bindDatabaseTarget(
  adminPool: Pool,
  runtimePool: Pool,
  adminUrl: string,
  runtimeUrl: string,
  target: DockerTargetEvidence,
  container: string,
): Promise<DatabaseServerIdentity> {
  const { database, adminUser } = validateDatabaseUrlBindings(adminUrl, runtimeUrl);
  const [adminIdentity, runtimeIdentity, containerSystemIdentifier] = await Promise.all([
    readDatabaseServerIdentity(adminPool), readDatabaseEndpointIdentity(runtimePool),
    readContainerSystemIdentifier(container, adminUser, database),
  ]);
  return validateDatabaseServerIdentity(adminIdentity, runtimeIdentity, containerSystemIdentifier, target, database);
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

async function insertRows(client: PoolClient, table: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(',')})`;
  });
  await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, values);
}

async function inBatches<T>(items: Iterable<T>, size: number, work: (batch: readonly T[]) => Promise<void>): Promise<void> {
  let batch: T[] = [];
  for (const item of items) {
    batch.push(item);
    if (batch.length === size) {
      await work(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await work(batch);
}

export const BENCHMARK_AGE_SEARCH_PATH_SQL = `SET LOCAL search_path TO ag_catalog, "$user", public`;

export async function benchmarkTransaction<T>(
  client: Pick<PoolClient, 'query'>, work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(BENCHMARK_AGE_SEARCH_PATH_SQL);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function withBenchmarkAgeClient<T>(
  pool: Pick<Pool, 'connect'>, work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await benchmarkTransaction(client, () => work(client));
  } finally {
    client.release();
  }
}

const AGE_SEED_LOOKUP_INDEX = 'wiki_benchmark_seed_node_properties_gin_idx';

export async function assertAgeSeedLookupIndexAbsent(
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('wiki_arcana.${AGE_SEED_LOOKUP_INDEX}') IS NOT NULL AS "exists"`,
  );
  if (result.rows[0]?.exists !== false) {
    throw new Error('setup-only AGE lookup index must be absent before measurement');
  }
}

export async function withAgeSeedLookupIndex<T>(
  client: Pick<PoolClient, 'query'>,
  work: () => Promise<T>,
): Promise<T> {
  let primaryError: unknown;
  let outcome: { readonly value: T } | undefined;
  try {
    await client.query(`DROP INDEX IF EXISTS wiki_arcana."${AGE_SEED_LOOKUP_INDEX}"`);
    await assertAgeSeedLookupIndexAbsent(client);
    await client.query(
      `CREATE INDEX "${AGE_SEED_LOOKUP_INDEX}" ON wiki_arcana."KnowledgeNode" USING gin (properties)`,
    );
    outcome = { value: await work() };
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await client.query(`DROP INDEX IF EXISTS wiki_arcana."${AGE_SEED_LOOKUP_INDEX}"`);
    await assertAgeSeedLookupIndexAbsent(client);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'AGE seed failed and setup-only index cleanup also failed',
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  if (outcome === undefined) throw new Error('AGE seed completed without an outcome');
  return outcome.value;
}

async function seedSpacesAndGrants(client: PoolClient, layout: DatasetLayout, deadlineStart: bigint): Promise<void> {
  assertWallClockWithinLimit(deadlineStart);
  await benchmarkTransaction(client, async () => {
    await inBatches(layout.spaces, 100, async (spaces) => insertRows(client, 'knowledge_spaces',
      ['id', 'slug', 'name', 'required_level', 'isolation_mode'],
      spaces.map((space) => [space.id, space.slug, space.slug, 'holocron', 'linked'])));
    await insertRows(client, 'space_grants', ['id', 'space_id', 'subject_type', 'subject_id', 'effect', 'capability'],
      layout.grants.map((grant) => [grant.id, grant.spaceId, 'user', grant.subjectId, grant.effect, 'read']));
  });
}

async function seedNodes(client: PoolClient, layout: DatasetLayout, deadlineStart: bigint): Promise<void> {
  await inBatches(iterateNodes(layout), SEED_BATCH_ROWS.nodes, async (nodes) => {
    assertWallClockWithinLimit(deadlineStart);
    await benchmarkTransaction(client, async () => {
      await insertRows(client, 'knowledge_nodes', ['id', 'space_id', 'properties'],
        nodes.map((node) => [node.id, node.spaceId, JSON.stringify({ benchmark: true, ordinal: node.globalIndex })]));
      await client.query(
        `SELECT * FROM ag_catalog.cypher('wiki_arcana',
         $cypher$UNWIND $rows AS row MERGE (node:KnowledgeNode {id: row.id}) SET node.spaceId = row.spaceId RETURN count(node)$cypher$,
         $1::ag_catalog.agtype) AS (count ag_catalog.agtype)`,
        [JSON.stringify({ rows: nodes.map((node) => ({ id: node.id, spaceId: node.spaceId })) })],
      );
    });
  });
}

async function seedEdges(client: PoolClient, layout: DatasetLayout, deadlineStart: bigint): Promise<void> {
  await inBatches(iterateEdges(layout), SEED_BATCH_ROWS.edges, async (edges) => {
    assertWallClockWithinLimit(deadlineStart);
    await benchmarkTransaction(client, async () => {
      await insertRows(client, 'knowledge_edges', ['id', 'space_id', 'source_node_id', 'target_node_id', 'edge_type', 'properties'],
        edges.map((edge) => [edge.id, edge.spaceId, edge.sourceNodeId, edge.targetNodeId, edge.edgeType,
          JSON.stringify({ benchmarkOrdinal: edge.globalIndex })]));
      await client.query(
        `SELECT * FROM ag_catalog.cypher('wiki_arcana',
         $cypher$UNWIND $rows AS row MATCH (source:KnowledgeNode {id: row.sourceNodeId})
         MATCH (target:KnowledgeNode {id: row.targetNodeId})
         MERGE (source)-[edge:KNOWLEDGE_EDGE {id: row.id}]->(target)
         SET edge.spaceId = row.spaceId, edge.edgeType = 'LINKS_TO' RETURN count(edge)$cypher$,
         $1::ag_catalog.agtype) AS (count ag_catalog.agtype)`,
        [JSON.stringify({ rows: edges })],
      );
    });
  });
}

function updateVectorHash(hash: ReturnType<typeof createHash>, row: VectorHashRow): void {
  hash.update(`${canonicalJson([row.nodeId, hashFloat32Vector(row.vector)])}\n`);
}

async function seedVectors(client: PoolClient, layout: DatasetLayout, deadlineStart: bigint): Promise<string> {
  const hash = createHash('sha256');
  await inBatches(iterateNodes(layout), SEED_BATCH_ROWS.vectors, async (nodes) => {
    assertWallClockWithinLimit(deadlineStart);
    const rows = nodes.map((node) => ({ nodeId: node.id, spaceId: node.spaceId,
      vector: generateNormalizedVector(node.globalIndex, layout.config.vectorDimension, layout.config.seed) }));
    for (const row of rows) updateVectorHash(hash, row);
    await benchmarkTransaction(client, () => insertRows(client, 'knowledge_vectors', ['node_id', 'space_id', 'embedding'],
      rows.map((row) => [row.nodeId, row.spaceId, vectorLiteral(row.vector)])));
  });
  return hash.digest('hex');
}

export async function seedDataset(pool: Pool, layout: DatasetLayout, deadlineStart: bigint): Promise<string> {
  const client = await pool.connect();
  try {
    await seedSpacesAndGrants(client, layout, deadlineStart);
    await withAgeSeedLookupIndex(client, async () => {
      await seedNodes(client, layout, deadlineStart);
      await seedEdges(client, layout, deadlineStart);
    });
    const vectorHash = await seedVectors(client, layout, deadlineStart);
    await client.query(PROJECTION_REINDEX_SQL);
    return vectorHash;
  } finally {
    client.release();
  }
}

function parseVectorLiteral(value: string, dimension: number): number[] {
  if (!value.startsWith('[') || !value.endsWith(']')) throw new Error('stored vector literal is malformed');
  const vector = value.slice(1, -1).split(',').map(Number);
  if (vector.length !== dimension || vector.some((item) => !Number.isFinite(item))) throw new Error('stored vector is malformed');
  return vector.map(Math.fround);
}

async function actualVectorHash(client: PoolClient, layout: DatasetLayout, deadlineStart?: bigint): Promise<string> {
  const hash = createHash('sha256');
  for (let start = 0; start < layout.nodeCount; start += 100) {
    if (deadlineStart !== undefined) assertWallClockWithinLimit(deadlineStart);
    const result = await client.query<{ node_id: string; embedding: string }>(
      `SELECT kv.node_id::text, kv.embedding::text FROM knowledge_vectors kv
       JOIN knowledge_nodes kn ON kn.id=kv.node_id
       WHERE (kn.properties->>'ordinal')::int >= $1 AND (kn.properties->>'ordinal')::int < $2
       ORDER BY (kn.properties->>'ordinal')::int`,
      [start, start + 100],
    );
    for (const row of result.rows) updateVectorHash(hash, {
      nodeId: row.node_id,
      vector: parseVectorLiteral(row.embedding, layout.config.vectorDimension),
    });
  }
  return hash.digest('hex');
}

function expectedDatasetHash(layout: DatasetLayout): string {
  const hash = createHash('sha256');
  for (const node of iterateNodes(layout)) hash.update(`${canonicalJson(['node', node.id, node.spaceId, node.globalIndex])}\n`);
  for (const edge of iterateEdges(layout)) {
    hash.update(`${canonicalJson(['edge', edge.id, edge.spaceId, edge.sourceNodeId, edge.targetNodeId, edge.globalIndex])}\n`);
  }
  return hash.digest('hex');
}

async function actualDatasetHash(client: PoolClient, layout: DatasetLayout): Promise<string> {
  const hash = createHash('sha256');
  const nodes = await client.query<{ id: string; space_id: string; ordinal: number }>(
    `SELECT id::text, space_id::text, (properties->>'ordinal')::int AS ordinal
     FROM knowledge_nodes WHERE properties->>'benchmark'='true' ORDER BY ordinal`,
  );
  for (const node of nodes.rows) hash.update(`${canonicalJson(['node', node.id, node.space_id, node.ordinal])}\n`);
  const edges = await client.query<{ id: string; space_id: string; source: string; target: string; ordinal: number }>(
    `SELECT id::text, space_id::text, source_node_id::text AS source, target_node_id::text AS target,
            (properties->>'benchmarkOrdinal')::int AS ordinal
     FROM knowledge_edges WHERE space_id=ANY($1::uuid[]) ORDER BY ordinal`,
    [layout.spaces.map((space) => space.id)],
  );
  for (const edge of edges.rows) {
    hash.update(`${canonicalJson(['edge', edge.id, edge.space_id, edge.source, edge.target, edge.ordinal])}\n`);
  }
  return hash.digest('hex');
}

function hashCanonicalRows(rows: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${canonicalJson(row)}\n`);
  return hash.digest('hex');
}

export function expectedDatasetProof(layout: DatasetLayout, vectorHash: string): DatasetProof {
  const byFirst = (left: readonly unknown[], right: readonly unknown[]) => String(left[0]).localeCompare(String(right[0]));
  const spaces = [REGISTRY_ROOT_SPACE, ...layout.spaces.map((space) =>
    [space.id, space.slug, space.slug, 'holocron', 'linked'] as const)].sort(byFirst);
  const accessLevels = ACCESS_LEVEL_BASELINE.map((row) => [...row]).sort(byFirst);
  const closure = spaces.map((space) => [space[0], space[0], 0]).sort(byFirst);
  const grants = layout.grants.map((grant) => [
    grant.id, grant.spaceId, 'user', grant.subjectId, grant.effect, 'read',
  ]).sort(byFirst);
  const nodes = [...iterateNodes(layout)].map((node) => [node.id, node.spaceId, node.globalIndex]);
  const edges = [...iterateEdges(layout)].map((edge) => [
    edge.id, edge.spaceId, edge.sourceNodeId, edge.targetNodeId, edge.edgeType, edge.globalIndex,
  ]);
  const ageNodes = nodes.map(([id, spaceId]) => [id, spaceId]).sort(byFirst);
  const ageEdges = edges.map(([id, spaceId, source, target, edgeType]) => [id, spaceId, source, target, edgeType]).sort(byFirst);
  const effectivePermissions = grants.filter((row) => row[4] === 'allow'
    && !grants.some((denied) => denied[1] === row[1] && denied[3] === row[3] && denied[4] === 'deny'))
    .map((row) => [row[1], row[3], row[5]])
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    counts: {
      spaces: spaces.length, accessLevels: accessLevels.length, closure: closure.length,
      grants: grants.length, effectivePermissions: effectivePermissions.length,
      relationalNodes: nodes.length, relationalEdges: edges.length, vectors: nodes.length,
      ageNodes: ageNodes.length, ageEdges: ageEdges.length,
    },
    hashes: {
      spaces: hashCanonicalRows(spaces), accessLevels: hashCanonicalRows(accessLevels), closure: hashCanonicalRows(closure),
      grants: hashCanonicalRows(grants),
      effectivePermissions: hashCanonicalRows(effectivePermissions),
      relationalNodes: hashCanonicalRows(nodes), relationalEdges: hashCanonicalRows(edges), vectors: vectorHash,
      ageNodes: hashCanonicalRows(ageNodes), ageEdges: hashCanonicalRows(ageEdges),
    },
  };
}

async function actualDatasetProof(client: PoolClient, layout: DatasetLayout, vectorHash: string): Promise<DatasetProof> {
  const spaces = (await client.query<{ id: string; slug: string; name: string; required_level: string; isolation_mode: string }>(
    `SELECT id::text, slug, name, required_level::text, isolation_mode::text
     FROM knowledge_spaces ORDER BY id`,
  )).rows.map((row) => [row.id, row.slug, row.name, row.required_level, row.isolation_mode]);
  const accessLevels = (await client.query<{ slug: string; ordinal: number; display_name: string; description: string }>(
    'SELECT slug, ordinal, display_name, description FROM access_levels ORDER BY slug',
  )).rows.map((row) => [row.slug, row.ordinal, row.display_name, row.description]);
  const closure = (await client.query<{ ancestor_id: string; descendant_id: string; depth: number }>(
    'SELECT ancestor_id::text, descendant_id::text, depth FROM space_closure ORDER BY ancestor_id, descendant_id',
  )).rows.map((row) => [row.ancestor_id, row.descendant_id, row.depth]);
  const grants = (await client.query<{
    id: string; space_id: string; subject_type: string; subject_id: string; effect: string; capability: string;
  }>(`SELECT id::text, space_id::text, subject_type::text, subject_id, effect::text, capability::text
      FROM space_grants ORDER BY id`)).rows
    .map((row) => [row.id, row.space_id, row.subject_type, row.subject_id, row.effect, row.capability]);
  const permissions = (await client.query<{ space_id: string; subject_id: string; capability: string }>(
    `SELECT space_id::text, subject_id, capability::text FROM effective_permissions
     ORDER BY space_id, subject_id, capability`,
  )).rows.map((row) => [row.space_id, row.subject_id, row.capability]);
  const nodes = (await client.query<{ id: string; space_id: string; ordinal: number }>(
    `SELECT id::text, space_id::text, (properties->>'ordinal')::int AS ordinal
     FROM knowledge_nodes ORDER BY ordinal`,
  )).rows.map((row) => [row.id, row.space_id, row.ordinal]);
  const edges = (await client.query<{
    id: string; space_id: string; source: string; target: string; edge_type: string; ordinal: number;
  }>(`SELECT id::text, space_id::text, source_node_id::text AS source, target_node_id::text AS target,
        edge_type, (properties->>'benchmarkOrdinal')::int AS ordinal
      FROM knowledge_edges ORDER BY ordinal`)).rows
    .map((row) => [row.id, row.space_id, row.source, row.target, row.edge_type, row.ordinal]);
  const decode = (value: unknown) => decodeAgtype(value);
  const ageNodes = (await client.query<{ id: unknown; space_id: unknown }>(
    `SELECT * FROM ag_catalog.cypher('wiki_arcana',
      $cypher$MATCH (node:KnowledgeNode) RETURN node.id AS id, node.spaceId AS space_id ORDER BY id$cypher$)
      AS (id ag_catalog.agtype, space_id ag_catalog.agtype)`,
  )).rows.map((row) => [decode(row.id), decode(row.space_id)]);
  const ageEdges = (await client.query<{ id: unknown; space_id: unknown; source: unknown; target: unknown; edge_type: unknown }>(
    `SELECT * FROM ag_catalog.cypher('wiki_arcana',
      $cypher$MATCH (source:KnowledgeNode)-[edge:KNOWLEDGE_EDGE]->(target:KnowledgeNode)
      RETURN edge.id AS id, edge.spaceId AS space_id, source.id AS source, target.id AS target,
        edge.edgeType AS edge_type ORDER BY id$cypher$)
      AS (id ag_catalog.agtype, space_id ag_catalog.agtype, source ag_catalog.agtype,
          target ag_catalog.agtype, edge_type ag_catalog.agtype)`,
  )).rows.map((row) => [decode(row.id), decode(row.space_id), decode(row.source), decode(row.target), decode(row.edge_type)]);
  const vectorCount = (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM knowledge_vectors')).rows[0]?.count ?? -1;
  return {
    counts: {
      spaces: spaces.length, accessLevels: accessLevels.length, closure: closure.length,
      grants: grants.length, effectivePermissions: permissions.length,
      relationalNodes: nodes.length, relationalEdges: edges.length, vectors: vectorCount,
      ageNodes: ageNodes.length, ageEdges: ageEdges.length,
    },
    hashes: {
      spaces: hashCanonicalRows(spaces), accessLevels: hashCanonicalRows(accessLevels), closure: hashCanonicalRows(closure),
      grants: hashCanonicalRows(grants), effectivePermissions: hashCanonicalRows(permissions),
      relationalNodes: hashCanonicalRows(nodes), relationalEdges: hashCanonicalRows(edges), vectors: vectorHash,
      ageNodes: hashCanonicalRows(ageNodes), ageEdges: hashCanonicalRows(ageEdges),
    },
  };
}

async function validateMigrationBinding(client: PoolClient, migrationHash: string): Promise<void> {
  const expected = await storageMigrationChecksums();
  const result = await client.query<{
    migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null;
  }>(`SELECT migration_name, checksum, finished_at, rolled_back_at
      FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [[...expected.keys()]]);
  const validRows = result.rows.filter((migration) => migration.checksum === expected.get(migration.migration_name)
    && migration.finished_at !== null && migration.rolled_back_at === null);
  if (validRows.length !== expected.size || migrationHash !== await storageMigrationHash()) {
    throw new Error('live database migration binding does not match the repository migration');
  }
}

async function validateStoragePreflight(client: PoolClient, migrationHash: string): Promise<Record<string, unknown>> {
  await validateMigrationBinding(client, migrationHash);
  await assertAgeSeedLookupIndexAbsent(client);
  const setup = await client.query<{ indexdef: string; vector_version: string | null; age_version: string | null; pg_version: string }>(
    `SELECT pg_get_indexdef(indexrelid) AS indexdef,
            current_setting('server_version') AS pg_version,
            (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector_version,
            (SELECT extversion FROM pg_extension WHERE extname='age') AS age_version
     FROM pg_index WHERE indexrelid='knowledge_vectors_embedding_hnsw_idx'::regclass`,
  );
  const row = setup.rows[0];
  if (!row?.vector_version || !row.age_version) throw new Error('required storage extensions are not installed');
  if (!/m='?16'?/.test(row.indexdef) || !/ef_construction='?128'?/.test(row.indexdef)) {
    throw new Error('HNSW setup does not match m=16/ef_construction=128');
  }
  return row;
}

interface SetupEvidence extends Record<string, unknown> {
  readonly datasetProof: DatasetProof;
  readonly setupDurationMs?: number;
}

async function validateSetup(
  client: PoolClient,
  layout: DatasetLayout,
  migrationHash: string,
  expectedVectorHash: string,
  deadlineStart: bigint,
): Promise<SetupEvidence> {
  const counts = await client.query<{ nodes: number; edges: number; vectors: number }>(
    `SELECT (SELECT count(*)::int FROM knowledge_nodes WHERE properties->>'benchmark'='true') AS nodes,
            (SELECT count(*)::int FROM knowledge_edges WHERE space_id = ANY($1::uuid[])) AS edges,
            (SELECT count(*)::int FROM knowledge_vectors WHERE space_id = ANY($1::uuid[])) AS vectors`,
    [layout.spaces.map((space) => space.id)],
  );
  const row = counts.rows[0];
  if (!row || row.nodes !== layout.nodeCount || row.edges !== layout.edgeCount || row.vectors !== layout.nodeCount) {
    throw new Error('seeded dataset counts do not match the canonical layout');
  }
  const storage = await validateStoragePreflight(client, migrationHash);
  const [expectedHash, actualHash, storedVectorHash] = await Promise.all([
    Promise.resolve(expectedDatasetHash(layout)),
    actualDatasetHash(client, layout),
    actualVectorHash(client, layout, deadlineStart),
  ]);
  if (expectedHash !== actualHash) throw new Error('seeded dataset hash does not match the canonical topology');
  if (expectedVectorHash !== storedVectorHash) throw new Error('seeded vector contents do not match the canonical float32 corpus');
  const [expectedProof, datasetProof] = await Promise.all([
    Promise.resolve(expectedDatasetProof(layout, expectedVectorHash)),
    actualDatasetProof(client, layout, storedVectorHash),
  ]);
  if (canonicalSha256(expectedProof) !== canonicalSha256(datasetProof)) {
    throw new Error('seeded dataset proof does not match spaces, ACL, relational, vector, and AGE contents');
  }
  return { counts: row, datasetHash: canonicalSha256({ topology: actualHash, vectors: storedVectorHash }),
    topologyHash: actualHash, vectorHash: storedVectorHash, datasetProof, storage, migrationHash };
}

export const EXACT_GROUND_TRUTH_SETTINGS = [
  BENCHMARK_AGE_SEARCH_PATH_SQL,
  'SET LOCAL statement_timeout = 60000',
  'SET LOCAL enable_indexscan = off',
  'SET LOCAL enable_indexonlyscan = off',
  'SET LOCAL enable_bitmapscan = off',
] as const;

export const ANN_SEARCH_SETTINGS = VECTOR_SEARCH_SETTINGS;

export interface BenchmarkEffectiveSettings {
  readonly adminStatementTimeout: string;
  readonly runtimeStatementTimeout: string;
  readonly exactGroundTruth: { readonly statementTimeout: string; readonly enableIndexScan: string;
    readonly enableIndexOnlyScan: string; readonly enableBitmapScan: string; readonly searchPath: string };
  readonly annSearch: { readonly statementTimeout: string; readonly jit: string; readonly enableSort: string; readonly efSearch: string; readonly iterativeScan: string;
    readonly maxScanTuples: string; readonly scanMemMultiplier: string; readonly ivfflatProbes: string };
}

export const BENCHMARK_EFFECTIVE_SETTINGS: BenchmarkEffectiveSettings = {
  adminStatementTimeout: '20min',
  runtimeStatementTimeout: '1500ms',
  exactGroundTruth: { statementTimeout: '1min', enableIndexScan: 'off', enableIndexOnlyScan: 'off', enableBitmapScan: 'off',
    searchPath: 'ag_catalog, "$user", public' },
  annSearch: { statementTimeout: '1500ms', jit: 'off', enableSort: 'off', efSearch: '1', iterativeScan: 'strict_order',
    maxScanTuples: '20000', scanMemMultiplier: '2', ivfflatProbes: '100' },
} as const;

async function observeEffectiveSettings(
  adminPool: Pool, runtimePool: Pool, vectorAdapter: PgvectorVectorAdapter,
): Promise<BenchmarkEffectiveSettings> {
  const admin = await adminPool.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value");
  const runtime = await runtimePool.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value");
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    for (const setting of EXACT_GROUND_TRUTH_SETTINGS) await client.query(setting);
    const exact = (await client.query<{
      statementTimeout: string; enableIndexScan: string; enableIndexOnlyScan: string; enableBitmapScan: string; searchPath: string;
    }>(`SELECT current_setting('statement_timeout') AS "statementTimeout",
      current_setting('enable_indexscan') AS "enableIndexScan",
      current_setting('enable_indexonlyscan') AS "enableIndexOnlyScan",
      current_setting('enable_bitmapscan') AS "enableBitmapScan",
      current_setting('search_path') AS "searchPath"`)).rows[0]!;
    await client.query('ROLLBACK');
    const ann = await vectorAdapter.observeSearchSettings();
    const observed = {
      adminStatementTimeout: admin.rows[0]?.value ?? '', runtimeStatementTimeout: runtime.rows[0]?.value ?? '',
      exactGroundTruth: exact, annSearch: ann,
    };
    if (canonicalSha256(observed) !== canonicalSha256(BENCHMARK_EFFECTIVE_SETTINGS)) {
      throw new Error('observed benchmark settings differ from the frozen contract');
    }
    return observed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const EXACT_TRAVERSAL_SQL = `WITH RECURSIVE access_context AS (
  SELECT $3::uuid AS subject_id, $4::integer AS clearance
), walk(node_id, depth, path) AS (
  SELECT $1::uuid, 0, ARRAY[$1::uuid]
  WHERE EXISTS (SELECT 1 FROM knowledge_nodes root JOIN knowledge_spaces ks ON ks.id=root.space_id
    JOIN access_levels access_level ON access_level.slug=ks.required_level CROSS JOIN access_context
    WHERE root.id=$1 AND ${READ_ACL_PREDICATE})
  UNION ALL
  SELECT edge.target_node_id, walk.depth + 1, walk.path || edge.target_node_id
  FROM walk JOIN knowledge_edges edge ON edge.source_node_id=walk.node_id
  WHERE walk.depth < $2 AND NOT edge.target_node_id=ANY(walk.path)
    AND EXISTS (SELECT 1 FROM knowledge_nodes target JOIN knowledge_spaces ks ON ks.id=target.space_id
      JOIN access_levels access_level ON access_level.slug=ks.required_level CROSS JOIN access_context
      WHERE target.id=edge.target_node_id AND ${READ_ACL_PREDICATE})
) SELECT DISTINCT node_id::text AS id FROM walk WHERE depth>0 ORDER BY id`;

export const EXACT_ANN_SQL = `WITH ${READ_ACL_CTE}
  SELECT kv.node_id::text AS id FROM knowledge_vectors kv
  JOIN knowledge_spaces ks ON ks.id = kv.space_id
  JOIN access_levels access_level ON access_level.slug = ks.required_level
  CROSS JOIN access_context
  WHERE kv.space_id=$1 AND kv.node_id<>$5 AND ${READ_ACL_PREDICATE}
  ORDER BY kv.embedding <=> $4::vector LIMIT 10`;

const EXACT_ROOT_ACL_SQL = `WITH access_context AS (
  SELECT $2::uuid AS subject_id, $3::integer AS clearance
) SELECT root.id::text AS id FROM knowledge_nodes root
JOIN knowledge_spaces ks ON ks.id=root.space_id
JOIN access_levels access_level ON access_level.slug=ks.required_level
CROSS JOIN access_context WHERE root.id=$1 AND ${READ_ACL_PREDICATE}`;

async function exactQuery(
  client: PoolClient,
  statement: string,
  values: readonly unknown[],
): Promise<{ resultIds: string[]; plan: unknown }> {
  await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
  try {
    for (const setting of EXACT_GROUND_TRUTH_SETTINGS) await client.query(setting);
    const result = await client.query<{ id: string }>(statement, values as unknown[]);
    const plan = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, values as unknown[]);
    await client.query('COMMIT');
    return { resultIds: result.rows.map((row) => row.id), plan: plan.rows[0]?.['QUERY PLAN'] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function prepareGroundTruth(
  runtimePool: Pool,
  layout: DatasetLayout,
  queries: BenchmarkQueryManifest,
  deadlineStart: bigint,
): Promise<{ records: GroundTruthRecord[]; plans: Record<string, unknown> }> {
  const client = await runtimePool.connect();
  const records: GroundTruthRecord[] = [];
  const plans: Record<string, unknown> = {};
  try {
    for (const query of queries.traversal) {
      assertWallClockWithinLimit(deadlineStart);
      const exact = await exactQuery(client, EXACT_TRAVERSAL_SQL,
        [query.sourceNodeId, query.depth, query.context.subjectId, query.context.level]);
      records.push({ queryId: query.id, resultIds: exact.resultIds, resultHash: canonicalSha256(exact.resultIds) });
      plans[query.id] = exact.plan;
    }
    for (const [ordinal, query] of queries.ann.entries()) {
      assertWallClockWithinLimit(deadlineStart);
      const space = layout.spaces.find((candidate) => candidate.id === query.spaceId)!;
      const sourceIndex = space.offset + pickNodeLocalIndex(query.sourceNodeId, space, layout);
      const vector = annVector(sourceIndex, ordinal, layout.config);
      if (hashFloat32Vector(vector) !== query.vectorSha256) throw new Error('ANN vector regeneration mismatch');
      const exact = await exactQuery(client, EXACT_ANN_SQL,
        [query.spaceId, query.context.subjectId, query.context.level, vectorLiteral(vector), query.excludeNodeId]);
      records.push({ queryId: query.id, resultIds: exact.resultIds, resultHash: canonicalSha256(exact.resultIds) });
      plans[query.id] = exact.plan;
    }
    for (const query of queries.unauthorizedGraph) {
      assertWallClockWithinLimit(deadlineStart);
      const exact = await exactQuery(client, EXACT_TRAVERSAL_SQL,
        [query.sourceNodeId, 4, query.context.subjectId, query.context.level]);
      records.push({ queryId: query.id, resultIds: exact.resultIds, resultHash: canonicalSha256(exact.resultIds) });
      plans[query.id] = exact.plan;
    }
    for (const query of queries.unauthorizedVector) {
      assertWallClockWithinLimit(deadlineStart);
      const source = [...iterateNodes(layout)].find((node) => node.id === query.sourceNodeId);
      if (!source) throw new Error('unauthorized vector source is absent from dataset');
      const vector = generateNormalizedVector(source.globalIndex, layout.config.vectorDimension, layout.config.seed);
      const exact = await exactQuery(client, EXACT_ANN_SQL,
        [query.spaceId, query.context.subjectId, query.context.level, vectorLiteral(vector), query.sourceNodeId]);
      records.push({ queryId: query.id, resultIds: exact.resultIds, resultHash: canonicalSha256(exact.resultIds) });
      plans[query.id] = exact.plan;
    }
  } finally {
    client.release();
  }
  return { records, plans };
}

async function checkAclCorrectness(runtimePool: Pool, layout: DatasetLayout, deadlineStart: bigint): Promise<{
  checked: number; passed: number; scenarios: readonly string[];
}> {
  const client = await runtimePool.connect();
  const results: { scenario: string; passed: boolean }[] = [];
  try {
    for (const probe of createAclCorrectnessProbes(layout)) {
      assertWallClockWithinLimit(deadlineStart);
      const exact = await exactQuery(client, EXACT_TRAVERSAL_SQL,
        [probe.sourceNodeId, 1, probe.context.subjectId, probe.context.level]);
      results.push({ scenario: probe.scenarioId, passed: (exact.resultIds.length > 0) === probe.expectedAuthorized });
    }
  } finally { client.release(); }
  if (results.some((result) => !result.passed)) throw new Error('ACL correctness scenario failed');
  return { checked: results.length, passed: results.filter((result) => result.passed).length,
    scenarios: results.map((result) => result.scenario) };
}

export async function checkEveryDecoyAcl(
  runtimePool: Pick<Pool, 'connect'>, graph: Pick<AgeGraphAdapter, 'traverse'>,
  layout: DatasetLayout, deadlineStart: bigint,
): Promise<{ checked: number; productCalls: number; allowedRoots: number; deniedOutputs: number;
}> {
  const productChecks = await runDecoyProductChecks(graph, layout);
  const client = await runtimePool.connect();
  const checks: { allowedRoot: boolean; deniedOutputs: number }[] = [];
  try {
    for (const product of productChecks) {
      assertWallClockWithinLimit(deadlineStart);
      const root = await exactQuery(client, EXACT_ROOT_ACL_SQL,
        [product.sourceNodeId, product.context.subjectId, product.context.level]);
      const exact = await exactQuery(client, EXACT_TRAVERSAL_SQL,
        [product.sourceNodeId, 1, product.context.subjectId, product.context.level]);
      checks.push({ allowedRoot: product.allowedRoot && root.resultIds.includes(product.sourceNodeId),
        deniedOutputs: product.deniedOutputs + exact.resultIds.filter((id) => id === product.deniedTargetId).length });
    }
  } finally { client.release(); }
  return { productCalls: checks.length, ...summarizeDecoyAclChecks(checks, layout.decoyTargets.size) };
}

async function prepare(options: CliOptions, seedOnly: boolean): Promise<void> {
  const prepareStarted = process.hrtime.bigint();
  await inspectGitCheckout(options.commit);
  const artifactsDir = await assertExternalArtifactPath(options.artifactsDir, options.mode);
  if (!seedOnly && (!options.gateEvidence || !options.gateTokenFile)) {
    throw new Error('PREPARE requires the future Gate-B evidence and HMAC key paths to bind the exact authoritative command');
  }
  const actualMigrationHash = await storageMigrationHash();
  validateBindings(options, actualMigrationHash);
  const target = await inspectDockerTarget(options);
  await Promise.all([assertSecretFilePermissions(options.adminUrlFile), assertSecretFilePermissions(options.runtimeUrlFile)]);
  const [adminUrl, runtimeUrl] = await Promise.all([readFile(options.adminUrlFile, 'utf8'), readFile(options.runtimeUrlFile, 'utf8')]);
  if (adminUrl.trim() === runtimeUrl.trim()) throw new Error('admin and runtime database credentials must be distinct');
  const adminPool = new Pool({ connectionString: adminUrl.trim(), max: 1,
    statement_timeout: BENCHMARK_CONTRACT.timeouts.reindexMs });
  const runtimePool = new Pool({ connectionString: runtimeUrl.trim(), max: 1,
    statement_timeout: BENCHMARK_CONTRACT.timeouts.timedQueryMs, options: POSTGRES_SESSION_OPTIONS });
  const layout = createDatasetLayout();
  const queries = createQueryManifest(layout);
  const runtimeExecutor = new QueryExecutor(runtimePool);
  const runtimePolicy = new AccessContextPolicy();
  const runtimeGraph = new AgeGraphAdapter(runtimeExecutor, runtimePolicy,
    new PostgresUnitOfWorkAdapter(runtimePool, runtimeExecutor));
  const setupStarted = prepareStarted;
  try {
    const serverIdentity = await bindDatabaseTarget(
      adminPool, runtimePool, adminUrl.trim(), runtimeUrl.trim(), target, options.databaseContainer,
    );
    const boundTarget = { ...target, serverIdentity };
    const preflightClient = await adminPool.connect();
    try { await validateStoragePreflight(preflightClient, options.migrationHash); }
    finally { preflightClient.release(); }
    assertWallClockWithinLimit(prepareStarted);
    const expectedVectorHash = await seedDataset(adminPool, layout, prepareStarted);
    const validationClient = await adminPool.connect();
    let setup: SetupEvidence;
    try {
      setup = await benchmarkTransaction(validationClient,
        () => validateSetup(validationClient, layout, options.migrationHash, expectedVectorHash, prepareStarted));
    }
    finally { validationClient.release(); }
    if (seedOnly) {
      setup = { ...setup, setupDurationMs: elapsedMilliseconds(setupStarted) };
      await atomicWriteFile(resolve(artifactsDir, 'seed-evidence.json'), `${JSON.stringify({ status: 'SEEDED', target: boundTarget, setup }, null, 2)}\n`);
      assertWallClockWithinLimit(prepareStarted);
      return;
    }
    assertWallClockWithinLimit(prepareStarted);
    const truth = await prepareGroundTruth(runtimePool, layout, queries, prepareStarted);
    const aclCorrectness = await checkAclCorrectness(runtimePool, layout, prepareStarted);
    const decoyAcl = await checkEveryDecoyAcl(runtimePool, runtimeGraph, layout, prepareStarted);
    if (decoyAcl.allowedRoots !== decoyAcl.checked || decoyAcl.deniedOutputs !== 0) {
      throw new Error('decoy ACL preparation did not prove allowed roots and denied destinations');
    }
    const binding = { commit: options.commit, imageDigest: options.imageDigest, migrationHash: options.migrationHash };
    const manifest = buildPreparedManifest(layout, queries, truth.records, binding, truth.plans, setup.datasetProof);
    const manifestSha256 = manifest.manifestSha256;
    const gateBindings = {
      manifestSha256, ...binding, containerId: boundTarget.containerId,
      volume: boundTarget.volume, bind: boundTarget.bind,
    };
    const gateBApprovalPacket = gateBApprovalPacketTemplate(gateBindings, authoritativeCommandArgv(options, artifactsDir));
    await Promise.all([
      atomicWriteFile(resolve(artifactsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
      atomicWriteFile(resolve(artifactsDir, 'queries.json'), `${JSON.stringify(queries, null, 2)}\n`),
      atomicWriteFile(resolve(artifactsDir, 'ground-truth.json'), `${JSON.stringify(truth.records, null, 2)}\n`),
      atomicWriteFile(resolve(artifactsDir, 'ground-truth-plans.json'), `${JSON.stringify(truth.plans, null, 2)}\n`),
      atomicWriteFile(resolve(artifactsDir, 'decoy-acl.json'), `${JSON.stringify(decoyAcl, null, 2)}\n`),
      atomicWriteFile(resolve(artifactsDir, 'acl-correctness.json'), `${JSON.stringify(aclCorrectness, null, 2)}\n`),
    ]);
    assertWallClockWithinLimit(prepareStarted);
    setup = { ...setup, setupDurationMs: elapsedMilliseconds(setupStarted) };
    await atomicWriteFile(resolve(artifactsDir, 'prepare-evidence.json'), `${JSON.stringify({
      schemaVersion: BENCHMARK_CONTRACT.evidenceVersion,
      mode: 'PREPARE', status: 'PREPARED',
      bindings: { ...binding, manifestSha256, target: boundTarget },
      skippedMetrics: ['authoritative timed benchmark not authorized'], setup, aclCorrectness, decoyAcl, gateBApprovalPacket,
    }, null, 2)}\n`);
    assertWallClockWithinLimit(prepareStarted);
  } finally {
    await Promise.all([adminPool.end(), runtimePool.end()]);
  }
}

export interface TimedSample {
  readonly queryId: string;
  readonly pass: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly hits: readonly string[];
}

interface ContainerMemorySample {
  readonly timestamp: string; readonly rssApproximationBytes: number; readonly memoryCurrentBytes: number;
  readonly rawMemoryStat: string; readonly rawMemoryCurrent: string;
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  attempts: number,
  wait: () => Promise<void> = () => delay(250),
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('retry attempts must be a positive integer');
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt < attempts) await wait();
    }
  }
  throw lastError;
}

function startMemorySampler(container: string): { stop: () => Promise<{
  metric: 'cgroup_v2_anon_plus_shmem'; sampleCount: number; peakBytes: number; peakMemoryCurrentBytes: number;
  samples: ContainerMemorySample[];
}> } {
  const samples: ContainerMemorySample[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const [statResult, currentResult] = await retryTransient(() => Promise.all([
          execFileAsync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/memory.stat'], { encoding: 'utf8', timeout: 5_000 }),
          execFileAsync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/memory.current'], { encoding: 'utf8', timeout: 5_000 }),
        ]), 3);
        const parsed = parseCgroupMemorySample(statResult.stdout, currentResult.stdout);
        samples.push({ timestamp: new Date().toISOString(), ...parsed,
          rawMemoryStat: statResult.stdout, rawMemoryCurrent: currentResult.stdout });
      } catch { /* A transient Docker/SSH gap must not discard earlier valid cgroup samples. */ }
      if (!stopped) await delay(1_000);
    }
  })();
  return { stop: async () => {
    stopped = true;
    await loop;
    if (samples.length === 0) throw new Error('cgroup v2 container memory sampling failed or produced no samples');
    return { metric: 'cgroup_v2_anon_plus_shmem', sampleCount: samples.length,
      peakBytes: Math.max(...samples.map((sample) => sample.rssApproximationBytes)),
      peakMemoryCurrentBytes: Math.max(...samples.map((sample) => sample.memoryCurrentBytes)), samples };
  } };
}

async function runConcurrent<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let position = 0;
  async function worker(): Promise<void> {
    while (position < items.length) {
      const current = position++;
      output[current] = await work(items[current]!);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return output;
}

function elapsedMilliseconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

export function assertWallClockWithinLimit(started: bigint, now: bigint = process.hrtime.bigint()): void {
  if (Number(now - started) / 1_000_000 > BENCHMARK_CONTRACT.timeouts.wallClockMs) {
    throw new Error('benchmark phase exceeded registered wall-clock timeout');
  }
}

async function timeGraphQuery(
  adapter: AgeGraphAdapter, context: AccessContext, query: TraversalQuery, pass: number,
  expected: readonly string[],
): Promise<TimedSample> {
  const started = process.hrtime.bigint();
  try {
    const result = await adapter.traverse(context, { startNodeId: query.sourceNodeId, maxDepth: query.depth });
    const hits = validateTimedGraphHits(result.map((node) => node.id), expected);
    return { queryId: query.id, pass, durationMs: elapsedMilliseconds(started), hits };
  } catch {
    return { queryId: query.id, pass, durationMs: elapsedMilliseconds(started), error: 'query failed', hits: [] };
  }
}

async function timeAnnQuery(
  adapter: PgvectorVectorAdapter,
  context: AccessContext,
  query: AnnQuery,
  vector: readonly number[],
  pass: number,
): Promise<TimedSample> {
  const started = process.hrtime.bigint();
  try {
    const result = await adapter.search(context, {
      spaceId: query.spaceId, values: vector, limit: 10, excludeNodeId: query.sourceNodeId,
    });
    const hits = validateTimedAnnHits(result, query.spaceId, query.sourceNodeId, query.k);
    return { queryId: query.id, pass, durationMs: elapsedMilliseconds(started), hits };
  } catch {
    return { queryId: query.id, pass, durationMs: elapsedMilliseconds(started), error: 'query failed', hits: [] };
  }
}

export function validateTimedGraphHits(actual: readonly string[], expected: readonly string[]): string[] {
  if (new Set(actual).size !== actual.length) throw new Error('graph result contains duplicate IDs');
  const normalized = [...actual].sort();
  if (!isDeepStrictEqual(normalized, [...expected].sort())) throw new Error('graph result differs from exact ground truth');
  return normalized;
}

export function validateTimedAnnHits(
  rows: readonly VectorHit[], expectedSpaceId: string, excludedNodeId: string, limit: number,
): string[] {
  if (rows.length > limit) throw new Error('ANN result exceeds the requested limit');
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('ANN result contains duplicate IDs');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (rows.some((row) => !uuid.test(row.id) || row.id === excludedNodeId
    || row.spaceId !== expectedSpaceId || !Number.isFinite(row.score) || row.score < -1 || row.score > 1)) {
    throw new Error('ANN result contains unauthorized or malformed hits');
  }
  if (rows.some((row, index) => index > 0 && rows[index - 1]!.score < row.score)) {
    throw new Error('ANN result scores are not in descending order');
  }
  return rows.map((row) => row.id);
}

async function explainAnnQuery(
  adapter: PgvectorVectorAdapter, context: AccessContext, query: AnnQuery, vector: readonly number[],
): Promise<unknown> {
  return adapter.explainSearch(context, {
    spaceId: query.spaceId, values: vector, limit: query.k, excludeNodeId: query.excludeNodeId,
  });
}

async function captureAnnPreflight(
  pool: Pool,
  adapter: PgvectorVectorAdapter,
  layout: DatasetLayout,
  queries: readonly AnnQuery[],
): Promise<{ plans: { queryId: string; plan: unknown }[]; counts: { queryId: string; bucket: number; actual: number }[] }> {
  const plans: { queryId: string; plan: unknown }[] = [];
  const counts: { queryId: string; bucket: number; actual: number }[] = [];
  for (const query of queries) {
    const space = layout.spaces.find((candidate) => candidate.id === query.spaceId)!;
    const vector = annVector(space.offset + pickNodeLocalIndex(query.sourceNodeId, space, layout), query.ordinal, layout.config);
    const count = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM knowledge_vectors WHERE space_id=$1 AND node_id<>$2',
      [query.spaceId, query.excludeNodeId],
    );
    counts.push({ queryId: query.id, bucket: query.bucket, actual: count.rows[0]?.count ?? -1 });
    plans.push({ queryId: query.id, plan: await explainAnnQuery(adapter, query.context, query, vector) });
  }
  return { plans, counts };
}

async function authoritative(options: CliOptions): Promise<void> {
  const authoritativeStarted = process.hrtime.bigint();
  await inspectGitCheckout(options.commit);
  const artifactsDir = await assertExternalArtifactPath(options.artifactsDir, 'AUTHORITATIVE');
  const [target, databaseHost] = await Promise.all([inspectDockerTarget(options), inspectDockerHost()]);
  await Promise.all([assertSecretFilePermissions(options.adminUrlFile), assertSecretFilePermissions(options.runtimeUrlFile)]);
  const [manifestRaw, queriesRaw, truthRaw, plansRaw, runtimeUrl, adminUrl] = await Promise.all([
    readFile(resolve(artifactsDir, 'manifest.json'), 'utf8'), readFile(resolve(artifactsDir, 'queries.json'), 'utf8'),
    readFile(resolve(artifactsDir, 'ground-truth.json'), 'utf8'), readFile(resolve(artifactsDir, 'ground-truth-plans.json'), 'utf8'),
    readFile(options.runtimeUrlFile, 'utf8'), readFile(options.adminUrlFile, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestRaw) as PreparedManifest;
  const queries = JSON.parse(queriesRaw) as BenchmarkQueryManifest;
  const truth = JSON.parse(truthRaw) as GroundTruthRecord[];
  const groundTruthPlans = JSON.parse(plansRaw) as Record<string, unknown>;
  const layout = createDatasetLayout();
  validatePreparedBundle(manifest, queries, truth, groundTruthPlans, manifest.datasetProof, {
    commit: options.commit, imageDigest: options.imageDigest, migrationHash: options.migrationHash,
  }, layout);
  await assertAuthoritativeGate(options.gateEvidence, options.gateTokenFile, {
    manifestSha256: manifest.manifestSha256,
    commit: options.commit,
    imageDigest: options.imageDigest,
    migrationHash: options.migrationHash,
    containerId: target.containerId,
    volume: target.volume,
    bind: target.bind,
  }, authoritativeCommandArgv(options, artifactsDir));
  const pool = new Pool({ connectionString: runtimeUrl.trim(), max: BENCHMARK_CONTRACT.timed.concurrency,
    statement_timeout: BENCHMARK_CONTRACT.timeouts.timedQueryMs, options: POSTGRES_SESSION_OPTIONS });
  const adminPool = new Pool({ connectionString: adminUrl.trim(), max: 1,
    statement_timeout: BENCHMARK_CONTRACT.timeouts.reindexMs });
  const executor = new QueryExecutor(pool);
  const policy = new AccessContextPolicy();
  const unitOfWork = new PostgresUnitOfWorkAdapter(pool, executor);
  const graph = new AgeGraphAdapter(executor, policy, unitOfWork);
  const vectors = new PgvectorVectorAdapter(executor, policy, unitOfWork);
  const memorySampler = startMemorySampler(options.databaseContainer);
  let memoryStopped = false;
  try {
    assertWallClockWithinLimit(authoritativeStarted);
    const serverIdentity = await bindDatabaseTarget(
      adminPool, pool, adminUrl.trim(), runtimeUrl.trim(), target, options.databaseContainer,
    );
    const boundTarget = { ...target, serverIdentity };
    const observedSettings = await observeEffectiveSettings(adminPool, pool, vectors);
    const preflightClient = await adminPool.connect();
    let storageEnvironment: Record<string, unknown>;
    try {
      storageEnvironment = await benchmarkTransaction(preflightClient, async () => {
        const storage = await validateStoragePreflight(preflightClient, options.migrationHash);
        const liveVectorHash = await actualVectorHash(preflightClient, layout);
        const liveDatasetProof = await actualDatasetProof(preflightClient, layout, liveVectorHash);
        if (canonicalSha256(liveDatasetProof) !== canonicalSha256(manifest.datasetProof)) {
          throw new Error('live authoritative dataset proof does not match prepared manifest');
        }
        return storage;
      });
    } finally { preflightClient.release(); }
    const hnswBuildMs = await rebuildHnsw(adminPool);
    assertWallClockWithinLimit(authoritativeStarted);
    const annPreflight = await captureAnnPreflight(pool, vectors, layout, queries.ann);
    const hnsw = { buildMs: hnswBuildMs, ...validateHnswPlans(annPreflight.plans, queries.ann.map((query) => query.id)) };
    if (hnsw.invalidPlanCount !== 0) throw new Error('one or more ANN plans do not use the HNSW index');
    const preAclCandidates = validatePreAclCandidateCounts(annPreflight.counts, queries.ann,
      layout.spaces.filter((space) => space.target).map((space) => space.size));
    if (preAclCandidates.mismatchCount !== 0) throw new Error('ANN pre-ACL candidate counts are mislabeled');
    const transactions = await runTransactionCases(adminPool, layout);
    const agtype = await runAgtypeCorpus(pool, layout);
    const aclCorrectness = await checkAclCorrectness(pool, layout, authoritativeStarted);
    const decoyAcl = await checkEveryDecoyAcl(pool, graph, layout, authoritativeStarted);
    await cycleWarmupCases(queries.traversal, BENCHMARK_CONTRACT.timed.warmSeconds,
      (query) => unitOfWork.transaction(
        () => graph.traverse(query.context, { startNodeId: query.sourceNodeId, maxDepth: query.depth }),
        [`SET LOCAL statement_timeout = ${BENCHMARK_CONTRACT.timeouts.groundTruthMs}`],
      ), undefined, BENCHMARK_CONTRACT.timed.concurrency);
    const graphSamples: TimedSample[] = [];
    const annSamples: TimedSample[] = [];
    const exactResults = new Map(truth.map((record) => [record.queryId, record.resultIds]));
    for (let pass = 0; pass < BENCHMARK_CONTRACT.timed.passes; pass += 1) {
      assertWallClockWithinLimit(authoritativeStarted);
      graphSamples.push(...await runConcurrent(queries.traversal, BENCHMARK_CONTRACT.timed.concurrency,
        (query) => timeGraphQuery(graph, query.context, query, pass + 1, exactResults.get(query.id) ?? [])));
    }
    await cycleWarmupCases(interleaveWarmupCases(queries.ann, (query) => query.bucket),
      BENCHMARK_CONTRACT.timed.warmSeconds, (query) => {
      const space = layout.spaces.find((candidate) => candidate.id === query.spaceId)!;
      const vector = annVector(space.offset + pickNodeLocalIndex(query.sourceNodeId, space, layout), query.ordinal, layout.config);
      return unitOfWork.transaction(() => vectors.search(query.context, {
        spaceId: query.spaceId, values: vector, limit: query.k, excludeNodeId: query.excludeNodeId,
      }), [`SET LOCAL statement_timeout = ${BENCHMARK_CONTRACT.timeouts.groundTruthMs}`]);
    }, undefined, BENCHMARK_CONTRACT.timed.concurrency);
    for (let pass = 0; pass < BENCHMARK_CONTRACT.timed.passes; pass += 1) {
      assertWallClockWithinLimit(authoritativeStarted);
      annSamples.push(...await runConcurrent(queries.ann, BENCHMARK_CONTRACT.timed.concurrency, (query) => {
        const space = layout.spaces.find((candidate) => candidate.id === query.spaceId)!;
        const vector = annVector(space.offset + pickNodeLocalIndex(query.sourceNodeId, space, layout), query.ordinal, layout.config);
        return timeAnnQuery(vectors, query.context, query, vector, pass + 1);
      }));
    }
    const unauthorizedGraphHits = await unauthorizedGraphResultCount(graph, queries.unauthorizedGraph);
    const unauthorizedVectorHits = await unauthorizedVectorResultCount(vectors, queries.unauthorizedVector);
    const authorizedAnnLeakage = countAuthorizedAnnLeakage(annSamples, queries.ann, layout);
    const databaseBytes = Number((await adminPool.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes')).rows[0]?.bytes);
    const memory = await memorySampler.stop();
    assertWallClockWithinLimit(authoritativeStarted);
    memoryStopped = true;
    await writeAuthoritativeRaw(options, boundTarget, layout, queries, truth, graphSamples, annSamples,
      { hnsw, preAclCandidates, transactions, agtype, aclCorrectness, decoyAcl, memory, unauthorizedGraphHits, unauthorizedVectorHits,
        authorizedAnnLeakage, databaseBytes, environment: {
          databaseHost,
          client: { cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, totalMemoryBytes: totalmem() },
          container: { memoryBytes: target.memoryBytes },
          storage: storageEnvironment,
          effectiveSettings: observedSettings,
        } },
      annPreflight, manifest.manifestSha256, artifactsDir);
  } finally {
    if (!memoryStopped) await memorySampler.stop().catch(() => undefined);
    await Promise.all([pool.end(), adminPool.end()]);
  }
}

function percentile(samples: readonly TimedSample[], percentileValue: number): number {
  const values = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  return values[Math.max(0, Math.ceil(values.length * percentileValue) - 1)] ?? Number.NaN;
}

function recall(actual: readonly string[], expected: readonly string[]): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const expectedIds = new Set(expected);
  return actual.filter((id) => expectedIds.has(id)).length / expected.length;
}

function countAuthorizedAnnLeakage(
  samples: readonly TimedSample[], queries: readonly AnnQuery[], layout: DatasetLayout,
): number {
  const querySpaces = new Map(queries.map((query) => [query.id, query.spaceId]));
  const nodeSpaces = new Map([...iterateNodes(layout)].map((node) => [node.id, node.spaceId]));
  return samples.reduce((count, sample) => count + sample.hits.filter((id) =>
    nodeSpaces.get(id) !== querySpaces.get(sample.queryId)).length, 0);
}

interface AuthoritativeGateEvidence {
  readonly hnsw: { readonly buildMs: number; readonly planCount: number; readonly invalidPlanCount: number };
  readonly preAclCandidates: { readonly queryCount: number; readonly mismatchCount: number };
  readonly transactions: ReturnType<typeof summarizeTransactionCases>;
  readonly agtype: ReturnType<typeof summarizeAgtypeCorpus>;
  readonly aclCorrectness: { readonly checked: number; readonly passed: number; readonly scenarios: readonly string[] };
  readonly decoyAcl: { readonly checked: number; readonly productCalls: number;
    readonly allowedRoots: number; readonly deniedOutputs: number };
  readonly memory: { readonly metric: 'cgroup_v2_anon_plus_shmem'; readonly sampleCount: number;
    readonly peakBytes: number; readonly peakMemoryCurrentBytes: number; readonly samples: readonly ContainerMemorySample[] };
  readonly unauthorizedGraphHits: number;
  readonly unauthorizedVectorHits: number;
  readonly authorizedAnnLeakage: number;
  readonly databaseBytes: number;
  readonly environment: Readonly<Record<string, unknown>>;
}

async function writeAuthoritativeRaw(
  options: CliOptions, target: DockerTargetEvidence, layout: DatasetLayout, queries: BenchmarkQueryManifest,
  truth: readonly GroundTruthRecord[], graphSamples: readonly TimedSample[], annSamples: readonly TimedSample[],
  gates: AuthoritativeGateEvidence,
  annPreflight: { plans: readonly { queryId: string; plan: unknown }[]; counts: readonly { queryId: string; bucket: number; actual: number }[] },
  manifestSha256: string, artifactsDir: string,
): Promise<void> {
  const expected = new Map(truth.map((record) => [record.queryId, record.resultIds]));
  const bucketMetrics = [0, 1, 2, 3].map((bucket) => {
    const samples = annSamples.filter((sample) => queries.ann.find((query) => query.id === sample.queryId)?.bucket === bucket);
    const recalls = samples.map((sample) => recall(sample.hits, expected.get(sample.queryId) ?? []));
    return { bucket, meanRecall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length, minimumRecall: Math.min(...recalls), fillRate: samples.filter((sample) => sample.hits.length === 10).length / samples.length };
  });
  const hitIds = new Set(annSamples.flatMap((sample) => sample.hits));
  const annHitSpaces = [...iterateNodes(layout)].filter((node) => hitIds.has(node.id))
    .map((node) => ({ nodeId: node.id, spaceId: node.spaceId }));
  const rawBytes = Buffer.from(`${JSON.stringify({
    graphSamples, annSamples, hnswPlans: annPreflight.plans, preAclCandidates: annPreflight.counts,
    memorySamples: gates.memory.samples, queries, truth, annHitSpaces,
    bucketSizes: layout.spaces.filter((space) => space.target).map((space) => space.size),
    observations: {
      hnswBuildMs: gates.hnsw.buildMs, transactions: gates.transactions, agtype: gates.agtype,
      aclCorrectness: gates.aclCorrectness, decoyAcl: gates.decoyAcl,
      unauthorizedGraphHits: gates.unauthorizedGraphHits, unauthorizedVectorHits: gates.unauthorizedVectorHits,
      databaseBytes: gates.databaseBytes, environment: gates.environment,
    },
  }, null, 2)}\n`, 'utf8');
  const evidence = {
    schemaVersion: BENCHMARK_CONTRACT.evidenceVersion, mode: 'AUTHORITATIVE', status: 'COMPLETED',
    bindings: { manifestSha256, commit: options.commit, imageDigest: options.imageDigest, migrationHash: options.migrationHash, target }, skippedMetrics: [],
    metrics: {
      graph: timingMetric(graphSamples, expected), ann: { ...timingMetric(annSamples), buckets: bucketMetrics },
      unauthorizedGraphHits: gates.unauthorizedGraphHits,
      unauthorizedVectorHits: gates.unauthorizedVectorHits,
      authorizedAnnLeakage: gates.authorizedAnnLeakage,
      environment: gates.environment,
      transactions: gates.transactions,
      agtype: gates.agtype,
      aclCorrectness: gates.aclCorrectness,
      hnsw: gates.hnsw,
      preAclCandidates: gates.preAclCandidates,
      decoyAcl: gates.decoyAcl,
      memory: { metric: gates.memory.metric, sampleCount: gates.memory.sampleCount,
        peakBytes: gates.memory.peakBytes, peakMemoryCurrentBytes: gates.memory.peakMemoryCurrentBytes },
      databaseBytes: gates.databaseBytes,
    },
  };
  const boundEvidence = { ...evidence, rawArtifactSha256: createHash('sha256').update(rawBytes).digest('hex') };
  await atomicWriteFile(resolve(artifactsDir, 'authoritative-raw.json'), rawBytes.toString('utf8'));
  await atomicWriteFile(resolve(artifactsDir, 'authoritative-evidence.json'), `${JSON.stringify(boundEvidence, null, 2)}\n`);
}

interface PassTimingMetric { readonly pass: number; readonly sampleCount: number; readonly errorCount: number; readonly p95Ms: number; readonly p99Ms: number }
interface TimingMetric {
  readonly warmSeconds: number;
  readonly passes: number;
  readonly concurrency: number;
  readonly sampleCount: number;
  readonly errorCount: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly passMetrics: readonly PassTimingMetric[];
}

export function timingMetric(samples: readonly TimedSample[], expected?: ReadonlyMap<string, readonly string[]>): TimingMetric {
  const summarize = (selected: readonly TimedSample[]) => ({
    sampleCount: selected.length,
    errorCount: selected.filter((sample) => sample.error
      || (expected !== undefined && canonicalSha256(sample.hits) !== canonicalSha256(expected.get(sample.queryId) ?? []))).length,
    p95Ms: percentile(selected, 0.95),
    p99Ms: percentile(selected, 0.99),
  });
  const aggregate = summarize(samples);
  const passMetrics = Array.from({ length: BENCHMARK_CONTRACT.timed.passes }, (_, index) => {
    const pass = index + 1;
    return { pass, ...summarize(samples.filter((sample) => sample.pass === pass)) };
  });
  return { warmSeconds: BENCHMARK_CONTRACT.timed.warmSeconds, passes: BENCHMARK_CONTRACT.timed.passes,
    concurrency: BENCHMARK_CONTRACT.timed.concurrency, ...aggregate, passMetrics };
}

async function unauthorizedGraphResultCount(
  graph: AgeGraphAdapter,
  queries: readonly UnauthorizedQuery[],
): Promise<number> {
  let hits = 0;
  for (const query of queries) {
    hits += (await graph.traverse(query.context, { startNodeId: query.sourceNodeId, maxDepth: 4 })).length;
  }
  return hits;
}

async function unauthorizedVectorResultCount(
  adapter: PgvectorVectorAdapter, queries: readonly UnauthorizedQuery[],
): Promise<number> {
  let hits = 0;
  const vector = generateNormalizedVector(0);
  for (const query of queries) {
    hits += (await adapter.search(query.context, {
      spaceId: query.spaceId, values: vector, limit: 10, excludeNodeId: query.sourceNodeId,
    })).length;
  }
  return hits;
}

function transactionProbeIds(layout: DatasetLayout): string[] {
  return Array.from({ length: 100 }, (_, index) => deterministicUuid('ids', 9_000_000n + BigInt(index), layout.config.seed));
}

async function cleanupTransactionProbes(client: PoolClient, ids: readonly string[]): Promise<void> {
  await benchmarkTransaction(client, async () => {
    await client.query(
      `SELECT * FROM ag_catalog.cypher('wiki_arcana',
       $cypher$UNWIND $ids AS probe_id MATCH (node:KnowledgeNode {id: probe_id}) DETACH DELETE node RETURN count(node)$cypher$,
       $1::ag_catalog.agtype) AS (count ag_catalog.agtype)`,
      [JSON.stringify({ ids })],
    );
    await client.query('DELETE FROM knowledge_vectors WHERE node_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM knowledge_nodes WHERE id=ANY($1::uuid[])', [ids]);
  });
}

async function writeTransactionProbe(client: PoolClient, id: string, spaceId: string, vector: string, commit: boolean): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(BENCHMARK_AGE_SEARCH_PATH_SQL);
    await client.query(`INSERT INTO knowledge_nodes (id,space_id,properties) VALUES ($1,$2,'{"transactionProbe":true}'::jsonb)`, [id, spaceId]);
    await client.query(
      `SELECT * FROM ag_catalog.cypher('wiki_arcana',
       $cypher$CREATE (node:KnowledgeNode {id: $id, spaceId: $spaceId}) RETURN node$cypher$,
       $1::ag_catalog.agtype) AS (node ag_catalog.agtype)`,
      [JSON.stringify({ id, spaceId })],
    );
    await client.query('INSERT INTO knowledge_vectors (node_id,space_id,embedding) VALUES ($1,$2,$3::vector)', [id, spaceId, vector]);
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function transactionProbePresence(client: PoolClient, id: string): Promise<Omit<TransactionCaseResult, 'outcome'>> {
  return benchmarkTransaction(client, async () => {
    const relational = await client.query<{ present: boolean }>('SELECT EXISTS(SELECT 1 FROM knowledge_nodes WHERE id=$1) AS present', [id]);
    const vector = await client.query<{ present: boolean }>('SELECT EXISTS(SELECT 1 FROM knowledge_vectors WHERE node_id=$1) AS present', [id]);
    const age = await client.query<{ count: unknown }>(
      `SELECT * FROM ag_catalog.cypher('wiki_arcana',
       $cypher$MATCH (node:KnowledgeNode {id: $id}) RETURN count(node)$cypher$,
       $1::ag_catalog.agtype) AS (count ag_catalog.agtype)`,
      [JSON.stringify({ id })],
    );
    return { relationalPresent: relational.rows[0]?.present === true, vectorPresent: vector.rows[0]?.present === true,
      agePresent: decodeAgtype(age.rows[0]?.count) === 1 };
  });
}

export async function runTransactionCases(pool: Pool, layout: DatasetLayout): Promise<ReturnType<typeof summarizeTransactionCases>> {
  const client = await pool.connect();
  const ids = transactionProbeIds(layout);
  const spaceId = layout.spaces.find((space) => space.target)!.id;
  const vector = vectorLiteral(generateNormalizedVector(9_000_000));
  const results: TransactionCaseResult[] = [];
  try {
    await cleanupTransactionProbes(client, ids);
    for (const [index, id] of ids.entries()) {
      const outcome = index < 50 ? 'commit' as const : 'rollback' as const;
      await writeTransactionProbe(client, id, spaceId, vector, outcome === 'commit');
      results.push({ outcome, ...await transactionProbePresence(client, id) });
    }
    const summary = summarizeTransactionCases(results);
    if (!summary.atomic) throw new Error('transaction atomicity probe failed');
    return summary;
  } finally {
    try {
      await cleanupTransactionProbes(client, ids);
    } finally {
      client.release();
    }
  }
}

const AGTYPE_QUERIES: Record<AgtypeCategory, string> = {
  null: 'UNWIND range(1,1000) AS i RETURN null AS value',
  bool: 'UNWIND range(1,1000) AS i RETURN i % 2 = 0 AS value',
  int64: 'UNWIND range(0,999) AS i RETURN CASE WHEN i % 2 = 0 THEN 9223372036854775807 ELSE -9223372036854775807 - 1 END AS value',
  float: 'UNWIND range(1,1000) AS i RETURN i + 0.5 AS value',
  string: 'UNWIND range(1,1000) AS i RETURN "escaped\\n\\"value" AS value',
  list: 'UNWIND range(1,1000) AS i RETURN [i,true,null] AS value',
  map: 'UNWIND range(1,1000) AS i RETURN {value:i} AS value',
  vertex: 'MATCH (node:KnowledgeNode) RETURN node AS value ORDER BY node.id LIMIT 1000',
  edge: 'MATCH ()-[edge:KNOWLEDGE_EDGE]->() RETURN edge AS value ORDER BY edge.id LIMIT 1000',
  path: 'MATCH path=(source:KnowledgeNode)-[edge:KNOWLEDGE_EDGE]->(target:KnowledgeNode) RETURN path AS value ORDER BY edge.id LIMIT 1000',
};

interface AgtypeExpectedLayout {
  readonly nodes: readonly BenchmarkNode[];
  readonly edges: readonly BenchmarkEdge[];
  readonly nodesById: ReadonlyMap<string, BenchmarkNode>;
}

function expectedAgtypeSemantic(category: AgtypeCategory, ordinal: number, expectedLayout: AgtypeExpectedLayout): unknown {
  const index = ordinal + 1;
  if (category === 'null') return null;
  if (category === 'bool') return index % 2 === 0;
  if (category === 'int64') return ordinal % 2 === 0
    ? 9_223_372_036_854_775_807n : -9_223_372_036_854_775_808n;
  if (category === 'float') return index + 0.5;
  if (category === 'string') return 'escaped\n"value';
  if (category === 'list') return [index, true, null];
  if (category === 'map') return { value: index };
  const nodeProjection = (node: BenchmarkNode) => ({ label: 'KnowledgeNode', properties: { id: node.id, spaceId: node.spaceId } });
  if (category === 'vertex') return nodeProjection(expectedLayout.nodes[ordinal]!);
  const edge = expectedLayout.edges[ordinal]!;
  const edgeProjection = { label: 'KNOWLEDGE_EDGE', properties: { id: edge.id, spaceId: edge.spaceId, edgeType: edge.edgeType } };
  if (category === 'edge') return edgeProjection;
  return [nodeProjection(expectedLayout.nodesById.get(edge.sourceNodeId)!), edgeProjection,
    nodeProjection(expectedLayout.nodesById.get(edge.targetNodeId)!)];
}

async function runAgtypeCorpus(pool: Pool, layout: DatasetLayout): Promise<ReturnType<typeof summarizeAgtypeCorpus>> {
  return withBenchmarkAgeClient(pool, async (client) => {
    const rows: AgtypeCorpusRow[] = [];
    const nodes = [...iterateNodes(layout)].sort((left, right) => left.id.localeCompare(right.id));
    const expectedLayout: AgtypeExpectedLayout = {
      nodes,
      edges: [...iterateEdges(layout)].sort((left, right) => left.id.localeCompare(right.id)),
      nodesById: new Map(nodes.map((node) => [node.id, node])),
    };
    for (const category of AGTYPE_CATEGORIES) {
      const result = await client.query<{ value: unknown }>(
        `SELECT value FROM ag_catalog.cypher('wiki_arcana', $cypher$${AGTYPE_QUERIES[category]}$cypher$) AS (value ag_catalog.agtype)`,
      );
      result.rows.forEach((row, ordinal) => rows.push({
        category, ordinal, encoded: row.value, expected: expectedAgtypeSemantic(category, ordinal, expectedLayout),
      }));
    }
    const summary = summarizeAgtypeCorpus(rows);
    if (summary.parseErrors || summary.semanticErrors || summary.undefinedValues || summary.precisionLosses) {
      throw new Error('agtype corpus integrity gate failed');
    }
    return summary;
  });
}

async function rebuildHnsw(pool: Pool): Promise<number> {
  const client = await pool.connect();
  const started = process.hrtime.bigint();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${BENCHMARK_CONTRACT.timeouts.reindexMs}`);
    await client.query('REINDEX INDEX knowledge_vectors_embedding_hnsw_idx');
    await client.query('COMMIT');
    const durationMs = elapsedMilliseconds(started);
    if (durationMs > BENCHMARK_CONTRACT.timeouts.reindexMs) throw new Error('HNSW REINDEX exceeded registered wall-clock limit');
    return durationMs;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseBenchmarkArguments(arguments_);
  if (options.mode === 'AUTHORITATIVE') await authoritative(options);
  else await prepare(options, options.mode === 'SEED');
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

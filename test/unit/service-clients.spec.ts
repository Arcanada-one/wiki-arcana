import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ServiceUrlSchema } from '../../src/config/env.schema.js';
import { ScrutatorClient } from '../../src/clients/scrutator.client.js';
import { LtmClient } from '../../src/clients/ltm.client.js';
import { CircuitOpenError, UpstreamTimeoutError } from '../../src/clients/resilient-service-client.js';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/', import.meta.url));

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixtureDirectory}${name}`, 'utf8')) as unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('service URL allowlist', () => {
  const meshHost = [100, 64, 0, 10].join('.');
  it.each([
    'https://search.internal.example',
    `http://${meshHost}:8310`,
  ])('allows HTTPS or HTTP on the Tailscale CGNAT mesh: %s', (url) => {
    expect(ServiceUrlSchema.parse(url)).toBe(url);
  });

  it.each([
    'http://search.internal.example',
    'http://127.0.0.1:8310',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.10:8310',
    'ftp://100.64.0.10/resource',
  ])('rejects SSRF-prone service URL: %s', (url) => {
    expect(() => ServiceUrlSchema.parse(url)).toThrow();
  });
});

describe('Scrutator and LTM service clients', () => {
  it('decodes both recorded Scrutator health fixtures through production schemas', async () => {
    const responses = [
      jsonResponse(await fixture('scrutator-api-health.json')),
      jsonResponse(await fixture('scrutator-embedding-health.json')),
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const client = new ScrutatorClient({
      apiUrl: 'https://search.internal.example',
      embeddingUrl: 'https://embedding.internal.example',
      credentialProvider: async () => 'service-token',
      fetcher,
    });

    await expect(client.health()).resolves.toEqual({ status: 'ok', service: 'Scrutator', version: '0.3.0' });
    await expect(client.embeddingHealth()).resolves.toMatchObject({ status: 'ok', model: 'BAAI/bge-m3', dimension: 1024 });
  });

  it('never forwards a caller bearer and always uses a separate service credential', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ status: 'ok', service: 'Scrutator', version: '0.3.0' })
    ));
    const client = new ScrutatorClient({
      apiUrl: 'https://search.internal.example',
      embeddingUrl: 'https://embedding.internal.example',
      credentialProvider: async () => 'fixture-service-token',
      fetcher,
    });
    await client.health({ callerBearer: 'caller-user-token' });

    const request = fetcher.mock.calls[0]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture-service-token');
    expect(JSON.stringify(request)).not.toContain('caller-user-token');
  });

  it('times out a stalled upstream request', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const client = new LtmClient({
      baseUrl: 'https://memory.internal.example',
      credentialProvider: async () => 'service-token',
      fetcher,
      timeoutMs: 10,
    });
    await expect(client.health()).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('opens its circuit after consecutive failures and avoids another fetch', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: 'down' }, 503));
    const client = new LtmClient({
      baseUrl: 'https://memory.internal.example',
      credentialProvider: async () => 'service-token',
      fetcher,
      circuitFailureThreshold: 2,
      circuitResetMs: 60_000,
    });
    await expect(client.health()).rejects.toThrow('503');
    await expect(client.health()).rejects.toThrow('503');
    await expect(client.health()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

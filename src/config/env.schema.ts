import { z } from 'zod';

export const ServiceUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && isTailscaleIpv4(url.hostname));
  if (!allowed) {
    context.addIssue({ code: 'custom', message: 'service URL must use HTTPS or HTTP on a Tailscale mesh address' });
  }
  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'service URL must not contain credentials' });
  }
});

const PostgreSqlUrlSchema = z.string().min(1).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      context.addIssue({ code: 'custom', message: 'database URL must use PostgreSQL' });
    }
    if (!url.username || !url.password || !url.pathname || url.pathname === '/') {
      context.addIssue({ code: 'custom', message: 'database URL must include credentials and database name' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'database URL must be a valid URL' });
  }
});

const RuntimeConfigShape = {
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4110),
  AUTH_ISSUER_URL: z.url().refine(isHttpsUrl, 'AUTH_ISSUER_URL must use HTTPS'),
  AUTH_AUDIENCE: z.url().refine(isHttpsUrl, 'AUTH_AUDIENCE must use HTTPS'),
  AUTH_JWKS_URL: z.url().refine(isHttpsUrl, 'AUTH_JWKS_URL must use HTTPS'),
  SCRUTATOR_API_URL: ServiceUrlSchema,
  SCRUTATOR_EMBEDDING_URL: ServiceUrlSchema,
  LTM_API_URL: ServiceUrlSchema,
  STORAGE_DATABASE_URL: PostgreSqlUrlSchema,
  STORAGE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  STORAGE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1_500),
  STORAGE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  STORAGE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5_000),
};

export const AppConfigSchema = z.object(RuntimeConfigShape).superRefine((configuration, context) => {
  if (new URL(configuration.AUTH_ISSUER_URL).origin !== new URL(configuration.AUTH_JWKS_URL).origin) {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_JWKS_URL'],
      message: 'AUTH_JWKS_URL must share the AUTH_ISSUER_URL origin',
    });
  }
});

export const StorageAdminConfigSchema = z.object({
  STORAGE_DATABASE_URL: PostgreSqlUrlSchema,
  STORAGE_ADMIN_DATABASE_URL: PostgreSqlUrlSchema,
}).superRefine((configuration, context) => {
  const runtimeUrl = parsePostgreSqlUrl(configuration.STORAGE_DATABASE_URL);
  const adminUrl = parsePostgreSqlUrl(configuration.STORAGE_ADMIN_DATABASE_URL);
  if (!runtimeUrl || !adminUrl) return;

  if (runtimeUrl.href === adminUrl.href) {
    context.addIssue({
      code: 'custom',
      path: ['STORAGE_ADMIN_DATABASE_URL'],
      message: 'runtime and admin database URLs must be separate',
    });
  }
  if (decodeUrlComponent(runtimeUrl.username) === decodeUrlComponent(adminUrl.username)) {
    context.addIssue({
      code: 'custom',
      path: ['STORAGE_ADMIN_DATABASE_URL'],
      message: 'runtime and admin database roles must be separate',
    });
  }
});

function parsePostgreSqlUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'postgresql:' || url.protocol === 'postgres:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isHttpsUrl(value: string): boolean {
  return new URL(value).protocol === 'https:';
}

function isTailscaleIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100
    && octets[1]! >= 64
    && octets[1]! <= 127;
}

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type StorageAdminConfig = z.infer<typeof StorageAdminConfigSchema>;

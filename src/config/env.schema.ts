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

export const AppConfigSchema = z.object({
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4110),
  AUTH_ISSUER_URL: z.url().refine(isHttpsUrl, 'AUTH_ISSUER_URL must use HTTPS'),
  AUTH_AUDIENCE: z.url().refine(isHttpsUrl, 'AUTH_AUDIENCE must use HTTPS'),
  AUTH_JWKS_URL: z.url().refine(isHttpsUrl, 'AUTH_JWKS_URL must use HTTPS'),
  SCRUTATOR_API_URL: ServiceUrlSchema,
  SCRUTATOR_EMBEDDING_URL: ServiceUrlSchema,
  LTM_API_URL: ServiceUrlSchema,
}).superRefine((configuration, context) => {
  if (new URL(configuration.AUTH_ISSUER_URL).origin !== new URL(configuration.AUTH_JWKS_URL).origin) {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_JWKS_URL'],
      message: 'AUTH_JWKS_URL must share the AUTH_ISSUER_URL origin',
    });
  }
});

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

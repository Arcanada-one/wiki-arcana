import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { OidcTokenVerifier } from './auth/oidc-token-verifier.js';
import { loadConfiguration } from './config/configuration.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'request.headers.authorization',
  'headers.authorization',
  'token',
  '*.token',
  '*.secret',
  '*.password',
];

export interface ApplicationOptions {
  environment?: NodeJS.ProcessEnv;
  tokenVerifier?: OidcTokenVerifier;
}

export async function createWikiApplication(options: ApplicationOptions = {}): Promise<NestFastifyApplication> {
  const configuration = loadConfiguration(options.environment);
  const adapter = new FastifyAdapter({
    bodyLimit: 65_536,
    requestTimeout: 10_000,
    logger: { redact: REDACT_PATHS },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(configuration, options.tokenVerifier),
    adapter,
    { bufferLogs: true },
  );
  app.enableShutdownHooks();
  await app.init();
  return app;
}

export async function startWikiApplication(): Promise<NestFastifyApplication> {
  const configuration = loadConfiguration();
  const app = await createWikiApplication({ environment: process.env });
  await app.listen(configuration.PORT, configuration.HOST);
  return app;
}

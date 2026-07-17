import { AppConfigSchema, type AppConfig } from './env.schema.js';

export function loadConfiguration(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return AppConfigSchema.parse(environment);
}


import type { Environment } from './environment.js';
import { parseEnvironment } from './environment.js';

export type { Environment, ParsedEnvironment } from './environment.js';
export { hasCompleteFirebaseCredentials, parseEnvironment } from './environment.js';

function loadEnvironment(): Environment {
  const result = parseEnvironment(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${JSON.stringify(result.fieldErrors)}`,
    );
  }
  return result.env;
}

export const env = loadEnvironment();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

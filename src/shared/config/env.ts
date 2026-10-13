import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Firebase (either file path or individual credentials)
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  // Redis
  REDIS_URL: z.string().url().optional(),

  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(process.env.NODE_ENV === 'development' ? 500 : 100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  // Swagger Documentation (optional - if not set, Swagger is unprotected)
  SWAGGER_USERNAME: z.string().optional(),
  SWAGGER_PASSWORD: z.string().optional(),

  // First run - run migrations automatically on startup (optional)
  FIRST_RUN: z.coerce.boolean().optional(),

  // CORS - Allowed origins (comma-separated list)
  ALLOWED_ORIGINS: z.string().optional(),
});

export type Environment = z.infer<typeof envSchema>;

export type ParsedEnvironment =
  | { readonly success: true; readonly env: Environment }
  | {
      readonly success: false;
      readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
    };

export function hasCompleteFirebaseCredentials(env: Partial<Environment>): boolean {
  const hasCredentialsFile = env.GOOGLE_APPLICATION_CREDENTIALS !== undefined;
  const hasIndividualCredentials =
    env.FIREBASE_PROJECT_ID !== undefined &&
    env.FIREBASE_CLIENT_EMAIL !== undefined &&
    env.FIREBASE_PRIVATE_KEY !== undefined;
  return hasCredentialsFile || hasIndividualCredentials;
}

/**
 * Pure environment parser. Never calls `process.exit`; boot code decides what
 * to do with a failure. In `production`, Firebase credentials are mandatory.
 */
export function parseEnvironment(source: unknown): ParsedEnvironment {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const flattened = parsed.error.flatten().fieldErrors;
    const fieldErrors: Record<string, string[]> = Object.fromEntries(
      Object.entries(flattened).map(([field, errors]) => [field, (errors ?? []).map(String)]),
    );
    return { success: false, fieldErrors };
  }

  const env = parsed.data;

  if (env.NODE_ENV === 'production' && !hasCompleteFirebaseCredentials(env)) {
    return {
      success: false,
      fieldErrors: {
        firebase: [
          'Firebase credentials are required in production. Provide GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
        ],
      },
    };
  }

  return { success: true, env };
}

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

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
  // Higher limits for development to avoid issues during development
  RATE_LIMIT_MAX: z.coerce.number().default(process.env.NODE_ENV === 'development' ? 500 : 100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  // Swagger Documentation (optional - if not set, Swagger is unprotected)
  SWAGGER_USERNAME: z.string().optional(),
  SWAGGER_PASSWORD: z.string().optional(),

  // First run - run migrations automatically on startup (optional)
  FIRST_RUN: z.coerce.boolean().optional(),
  
  // CORS - Allowed origins (comma-separated list)
  // In production, specify allowed frontend URLs
  // Example: "https://recta.app,https://www.recta.app,http://localhost:5173"
  ALLOWED_ORIGINS: z.string().optional(),
});

function validateEnv(): { DATABASE_URL: string; PORT: number; NODE_ENV: "development" | "production" | "test"; RATE_LIMIT_MAX: number; RATE_LIMIT_WINDOW_MS: number; GOOGLE_APPLICATION_CREDENTIALS?: string | undefined; FIREBASE_PROJECT_ID?: string | undefined; FIREBASE_CLIENT_EMAIL?: string | undefined; FIREBASE_PRIVATE_KEY?: string | undefined; REDIS_URL?: string | undefined; SWAGGER_USERNAME?: string | undefined; SWAGGER_PASSWORD?: string | undefined; FIRST_RUN?: boolean | undefined; ALLOWED_ORIGINS?: string | undefined; } {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    const fieldErrors = parsed.error.flatten().fieldErrors;
    console.error(JSON.stringify(fieldErrors, null, 2));
    console.error('\n📝 Missing or invalid variables:');
    Object.entries(fieldErrors).forEach(([field, errors]) => {
      console.error(`  - ${field}: ${errors?.join(', ') || 'invalid'}`);
    });
    console.error('\n💡 Please check your environment variables configuration.');
    process.exit(1);
  }

  // Validate Firebase credentials are provided (either file or individual)
  // NOTE: This validation is deferred - we don't fail startup if Firebase is missing
  // The health check should work even without Firebase
  const env = parsed.data;
  
  // Only validate Firebase in production or if explicitly required
  // In Railway, we want the server to start even if Firebase config is missing initially
  if (env.NODE_ENV === 'production') {
    const hasCredentialsFile = !!env.GOOGLE_APPLICATION_CREDENTIALS;
    const hasIndividualCredentials =
      env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY;

    if (!hasCredentialsFile && !hasIndividualCredentials) {
      console.warn('⚠️  Firebase credentials not provided - some features may not work');
      console.warn('   Provide GOOGLE_APPLICATION_CREDENTIALS or all of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
      // Don't exit - allow server to start for health checks
    }
  }

  return env;
}

export const env = validateEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';




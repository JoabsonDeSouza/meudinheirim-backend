import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { env, isProduction } from './shared/config/env.js';
import { initializeFirebase } from './shared/config/firebase.js';
import { connectDatabase, disconnectDatabase, prisma } from './shared/db/prisma.js';
import { runMigrations } from './shared/db/migrations.js';
import { errorHandler } from './shared/errors/error-handler.js';
import { isOriginAllowed, parseAllowedOrigins } from './shared/http/origin-policy.js';
import { shouldEnableSwaggerUi } from './shared/http/swagger-policy.js';
import { buildReadinessResult } from './shared/ops/readiness.js';
import { hasCompleteFirebaseCredentials } from './shared/config/environment.js';

// Routes
import { authRoutes } from './modules/auth/index.js';
import { authConfigRoutes } from './modules/auth/auth-config.routes.js';
import { userRoutes } from './modules/users/index.js';
import { householdRoutes } from './modules/households/index.js';
import { accountRoutes } from './modules/accounts/index.js';
import { categoryRoutes } from './modules/categories/index.js';
import { categoryV1Routes } from './modules/categories/categories.v1.routes.js';
import { transactionRoutes } from './modules/transactions/index.js';
import { transactionV1Routes } from './modules/transactions/transactions.v1.routes.js';
import { syncRoutes } from './modules/sync/sync.routes.js';
import { budgetRoutes } from './modules/budgets/index.js';
import { budgetV1Routes } from './modules/budgets/budgets.v1.routes.js';
import { savingsGoalRoutes } from './modules/savings-goals/index.js';
import { recurringTransactionRoutes } from './modules/recurring-transactions/index.js';
import { recurringV1Routes } from './modules/recurring-transactions/recurring.v1.routes.js';
import { feedbackRoutes } from './modules/feedback/index.js';
import { notificationRoutes } from './modules/notifications/index.js';
import { dashboardRoutes } from './modules/dashboard/index.js';

/**
 * Build the Fastify application
 */
export async function buildApp(): Promise<FastifyInstance> {
  console.log('🔨 Building Fastify application...');
  
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logger: {
      level: isProduction ? 'info' : 'debug',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie'],
        censor: '[REDACTED]',
      },
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
    },
    trustProxy: true,
  });

  console.log('✅ Fastify instance created');

  // ============================================================================
  // HEALTH CHECK (registered FIRST, before any plugins or routes)
  // ============================================================================

  console.log('📋 Registering health check endpoint...');
  app.get('/health', {
    schema: {
      description: 'Health check endpoint',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
            uptime: { type: 'number', description: 'Server uptime in seconds' },
          },
        },
      },
    },
  }, async (request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });
  console.log('✅ Health check endpoint registered at /health');

  app.get('/ready', {
    schema: {
      description: 'Readiness check for database, authentication and migrations',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            code: { type: 'string', enum: ['READY'] },
          },
          required: ['ready', 'code'],
        },
        503: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            code: { type: 'string', enum: ['NOT_READY'] },
          },
          required: ['ready', 'code'],
        },
      },
    },
  }, async (_request, reply) => {
    let database = false;
    let migrations = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
      const rows = await prisma.$queryRaw<Array<{ ready: boolean }>>`
        SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS ready
      `;
      migrations = rows[0]?.ready === true;
    } catch {
      // Readiness response deliberately omits internal dependency errors.
    }
    const result = buildReadinessResult({
      database,
      migrations,
      auth: hasCompleteFirebaseCredentials(env),
    });
    return reply.code(result.ready ? 200 : 503).send(result);
  });

  // ============================================================================
  // PLUGINS
  // ============================================================================

  // Swagger/OpenAPI Documentation
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Recta API',
        description: 'Personal finance backend with household collaboration support',
        version: '1.0.0',
      },
      paths: {
        '/health': {
          get: {
            tags: ['Health'],
            summary: 'Liveness probe',
            responses: { '200': { description: 'Process is alive' } },
          },
        },
        '/ready': {
          get: {
            tags: ['Health'],
            summary: 'Readiness probe',
            responses: {
              '200': { description: 'Dependencies are ready' },
              '503': { description: 'One or more dependencies are not ready' },
            },
          },
        },
      },
      servers: [
        {
          url: isProduction
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-railway-app.up.railway.app'}`
            : `http://localhost:${env.PORT}`,
          description: isProduction ? 'Production server' : 'Development server',
        },
      ],
      components: {
        schemas: {
          MoneyDto: {
            type: 'object',
            required: ['minorUnits', 'currency'],
            properties: {
              minorUnits: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
              currency: { type: 'string', enum: ['BRL', 'USD'] },
            },
            additionalProperties: false,
          },
          TransactionV1Dto: {
            type: 'object',
            required: ['id', 'kind', 'amount', 'categoryCode', 'accountId', 'occurredAt', 'timeZone', 'note', 'paid', 'createdAt', 'updatedAt', 'deletedAt', 'version', 'clientMutationId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              kind: { type: 'string', enum: ['expense', 'income'] },
              amount: { $ref: '#/components/schemas/MoneyDto' },
              categoryCode: { type: 'string' },
              accountId: { type: 'string', format: 'uuid' },
              occurredAt: { type: 'string', format: 'date-time' },
              timeZone: { type: 'string' },
              note: { type: ['string', 'null'] },
              paid: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              deletedAt: { type: ['string', 'null'], format: 'date-time' },
              version: { type: 'integer', minimum: 1 },
              clientMutationId: { type: 'string', format: 'uuid' },
            },
            additionalProperties: false,
          },
          TransferV1Dto: {
            type: 'object',
            required: ['transaction', 'fromVersion', 'toVersion'],
            properties: {
              transaction: {
                type: 'object',
                required: ['id', 'kind', 'amount', 'fromAccountId', 'toAccountId', 'occurredAt', 'timeZone', 'note', 'version', 'clientMutationId'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  kind: { type: 'string', enum: ['transfer'] },
                  amount: { $ref: '#/components/schemas/MoneyDto' },
                  fromAccountId: { type: 'string', format: 'uuid' },
                  toAccountId: { type: 'string', format: 'uuid' },
                  occurredAt: { type: 'string', format: 'date-time' },
                  timeZone: { type: 'string' },
                  note: { type: ['string', 'null'] },
                  version: { type: 'integer', minimum: 1 },
                  clientMutationId: { type: 'string', format: 'uuid' },
                },
                additionalProperties: false,
              },
              fromVersion: { type: 'integer', minimum: 1 },
              toVersion: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
          SyncChangeDto: {
            type: 'object',
            required: ['sequence', 'entityType', 'entityId', 'version', 'payload', 'deletedAt', 'createdAt'],
            properties: {
              sequence: { type: 'string', pattern: '^[1-9][0-9]*$' },
              entityType: { type: 'string' },
              entityId: { type: 'string', format: 'uuid' },
              version: { type: 'integer', minimum: 1 },
              payload: { type: 'object', additionalProperties: true },
              deletedAt: { type: ['string', 'null'], format: 'date-time' },
              createdAt: { type: 'string', format: 'date-time' },
            },
            additionalProperties: false,
          },
          ApiErrorDto: {
            type: 'object',
            required: ['success', 'error'],
            properties: {
              success: { type: 'boolean', enum: [false] },
              error: {
                type: 'object',
                required: ['code', 'message', 'requestId'],
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  requestId: { type: 'string' },
                  fieldErrors: {
                    type: 'object',
                    additionalProperties: { type: 'array', items: { type: 'string' } },
                  },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Firebase ID Token',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        { name: 'Auth', description: 'Authentication endpoints' },
        { name: 'Users', description: 'User management endpoints' },
        { name: 'Households', description: 'Household management endpoints' },
        { name: 'Accounts', description: 'Account management endpoints' },
        { name: 'Categories', description: 'Transaction category endpoints' },
        { name: 'Transactions', description: 'Transaction management endpoints' },
        { name: 'Budgets', description: 'Budget management endpoints' },
        { name: 'Savings Goals', description: 'Savings goal endpoints' },
        { name: 'Recurring Transactions', description: 'Recurring transaction endpoints' },
        { name: 'Feedback', description: 'User feedback endpoints' },
        { name: 'Sync', description: 'Idempotent mutations and change feed' },
      ],
    },
  });

  // Swagger UI with optional authentication
  if (shouldEnableSwaggerUi(isProduction, env.SWAGGER_USERNAME, env.SWAGGER_PASSWORD)) {
    await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    uiHooks: {
      onRequest: function (request, reply, next) {
        next();
      },
      preHandler: function (request, reply, next) {
        // Protect Swagger UI with basic auth if credentials are provided
        if (env.SWAGGER_USERNAME && env.SWAGGER_PASSWORD) {
          const auth = request.headers.authorization;
          
          if (!auth || !auth.startsWith('Basic ')) {
            reply.header('WWW-Authenticate', 'Basic realm="Swagger UI"');
            reply.code(401).send({ error: 'Unauthorized' });
            return;
          }

          const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
          const [username, password] = credentials.split(':');

          if (username !== env.SWAGGER_USERNAME || password !== env.SWAGGER_PASSWORD) {
            reply.header('WWW-Authenticate', 'Basic realm="Swagger UI"');
            reply.code(401).send({ error: 'Unauthorized' });
            return;
          }
        }
        next();
      },
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, _request, _reply) => {
      return swaggerObject;
    },
    transformSpecificationClone: true,
    });
  }

  // CORS: exact origins only. Native and command-line requests without Origin remain allowed.
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS)));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: isProduction ? {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    } : false,
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => {
      // Use Firebase UID if available, otherwise IP
      return request.authUser?.uid || request.ip;
    },
  });

  // ============================================================================
  // ERROR HANDLING
  // ============================================================================

  app.setErrorHandler(errorHandler);

  // Protect Swagger endpoints (UI and JSON spec) with basic auth if configured
  if (env.SWAGGER_USERNAME && env.SWAGGER_PASSWORD) {
    app.addHook('onRequest', async (request, reply) => {
      // Protect all /docs/* routes
      if (request.url.startsWith('/docs')) {
        const auth = request.headers.authorization;
        
        if (!auth || !auth.startsWith('Basic ')) {
          reply.header('WWW-Authenticate', 'Basic realm="Swagger Documentation"');
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }

        const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
        const [username, password] = credentials.split(':');

        if (username !== env.SWAGGER_USERNAME || password !== env.SWAGGER_PASSWORD) {
          reply.header('WWW-Authenticate', 'Basic realm="Swagger Documentation"');
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }
      }
    });
  }

  app.get('/', async () => {
    return {
      name: 'Recta API',
      version: '1.0.0',
      documentation: '/docs',
      openApiSpec: '/docs/json',
    };
  });

  // ============================================================================
  // ROUTES
  // ============================================================================

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(authConfigRoutes, { prefix: '/auth' });
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(authConfigRoutes, { prefix: '/v1/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(userRoutes, { prefix: '/v1/users' });
  await app.register(householdRoutes, { prefix: '/households' });
  await app.register(householdRoutes, { prefix: '/v1/households' });
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.register(accountRoutes, { prefix: '/v1/accounts' });
  await app.register(categoryRoutes, { prefix: '/categories' });
  await app.register(categoryV1Routes, { prefix: '/v1/categories' });
  await app.register(transactionRoutes, { prefix: '/transactions' });
  await app.register(transactionV1Routes, { prefix: '/v1/transactions' });
  await app.register(syncRoutes, { prefix: '/v1/sync' });
  await app.register(budgetRoutes, { prefix: '/budgets' });
  await app.register(budgetV1Routes, { prefix: '/v1/budgets' });
  await app.register(savingsGoalRoutes, { prefix: '/savings-goals' });
  await app.register(savingsGoalRoutes, { prefix: '/v1/savings-goals' });
  await app.register(recurringTransactionRoutes, { prefix: '/recurring-transactions' });
  await app.register(recurringV1Routes, { prefix: '/v1/recurring-transactions' });
  await app.register(feedbackRoutes, { prefix: '/feedback' });
  await app.register(feedbackRoutes, { prefix: '/v1/feedback' });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.register(notificationRoutes, { prefix: '/v1/notifications' });
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.register(dashboardRoutes, { prefix: '/v1/dashboard' });

  return app;
}

/**
 * Start the server
 */
export async function startServer(): Promise<void> {
  let app: FastifyInstance | null = null;

  try {
    // Build app FIRST - this registers /health route immediately
    app = await buildApp();

    // Railway provides PORT via environment variable
    const port = Number(process.env.PORT) || env.PORT;
    
    console.log(`📡 Starting server on port ${port}...`);
    console.log(`   PORT env var: ${process.env.PORT || 'not set'}`);
    console.log(`   Using port: ${port}`);
    
    // Start server IMMEDIATELY so health check can respond
    await app.listen({
      port,
      host: '0.0.0.0',
    });

    console.log(`
🚀 Recta API is running!
   
   Port:       ${port}
   Health:     http://0.0.0.0:${port}/health
   Swagger UI: http://0.0.0.0:${port}/docs
   Environment: ${env.NODE_ENV}
`);

    // Initialize services AFTER server is listening (non-blocking)
    // This allows health check to work even if these fail
    setImmediate(async () => {
      // Run migrations automatically in production or when FIRST_RUN=true
      // This ensures new migrations are applied on every deploy
      const shouldRunMigrations = isProduction || process.env.FIRST_RUN === 'true';
      
      if (shouldRunMigrations) {
        try {
          console.log('🚀 Running database migrations...');
          await runMigrations();
          console.log('✅ Migrations completed successfully');
        } catch (error) {
          console.error('Migrations failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          // Don't exit - allow server to start and respond to health checks
          // Migrations can be retried manually or on next deploy
          console.warn('⚠️  Server will continue running despite migration failure');
          console.warn('⚠️  Health check will still respond, but some features may not work');
        }
      }

      try {
        console.log('🔧 Initializing Firebase...');
        initializeFirebase();
        console.log('✅ Firebase initialized');
      } catch (error) {
        console.error('Firebase initialization failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        // Don't exit - server can still respond to health checks
      }

      try {
        console.log('🔧 Connecting to database...');
        await connectDatabase();
        console.log('✅ Database connected');
      } catch (error) {
        console.error('Database connection failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        // Don't exit - server can still respond to health checks
      }
    });
  } catch (error) {
    console.error('Server startup failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\n📴 Shutting down gracefully...');

    if (app) {
      await app.close();
    }
    await disconnectDatabase();

    console.log('👋 Server stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

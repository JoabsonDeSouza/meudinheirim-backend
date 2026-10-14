import { spawnSync } from 'node:child_process';

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required; refusing to run migrations.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  const databaseName = url.pathname.replace(/^\//, '');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!loopback || !databaseName.startsWith('recta_') || /prod|production|staging/i.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL must target a loopback database named recta_*; refusing migration.');
  }
  return value;
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

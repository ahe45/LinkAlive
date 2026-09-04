import { createConnection, type Connection, type ConnectionOptions } from 'mysql2/promise';

import { readRetentionConfig } from './retention-config.js';
import { runRetention } from './retention-runner.js';

function safeErrorMessage(error: unknown, databaseUrl: string | undefined): string {
  const message = error instanceof Error ? error.message : 'Unknown retention error.';
  const exactUrlRedacted = databaseUrl
    ? message.replaceAll(databaseUrl, '[REDACTED_DATABASE_URL]')
    : message;
  const credentialsRedacted = exactUrlRedacted.replace(
    /mysql:\/\/[^@\s]+@/gi,
    'mysql://[REDACTED]@',
  );
  return credentialsRedacted.slice(0, 1_024);
}

function connectionOptions(databaseUrl: string): ConnectionOptions {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'mysql:') {
    throw new Error('DATABASE_URL must use the mysql:// protocol.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database) {
    throw new Error('DATABASE_URL must include a hostname and database name.');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    charset: parsed.searchParams.get('charset') ?? 'utf8mb4',
    timezone: 'Z',
    connectTimeout: 10_000,
  };
}

async function main(): Promise<void> {
  let connection: Connection | undefined;
  try {
    const config = readRetentionConfig();
    connection = await createConnection(connectionOptions(config.databaseUrl));
    await connection.query("SET time_zone = '+00:00'");
    const result = await runRetention(connection, config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'linkalive.retention.failed',
        status: 'failed',
        error: safeErrorMessage(error, process.env.DATABASE_URL),
        failedAt: new Date().toISOString(),
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end().catch(() => undefined);
  }
}

await main();

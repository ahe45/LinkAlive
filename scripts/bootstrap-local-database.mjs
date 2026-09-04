import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnv(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function findClient() {
  const candidates = [
    process.env.MARIADB_CLIENT,
    'C:\\Program Files\\MariaDB 11.4\\bin\\mariadb.exe',
    'mariadb',
    'mysql',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return candidate;
  }
  throw new Error('MariaDB/MySQL client was not found. Set MARIADB_CLIENT to its executable path.');
}

function safeClientError(result) {
  const combined = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
  return combined
    .replace(/(?:mysql|mariadb):\/\/[^@\s]+@/giu, 'mysql://[REDACTED]@')
    .replace(/password\s*[:=]\s*\S+/giu, 'password=[REDACTED]')
    .slice(0, 2_000);
}

function runClient(client, connection, sql) {
  const result = spawnSync(
    client,
    [
      '--protocol=TCP',
      `--host=${connection.host}`,
      `--port=${connection.port}`,
      `--user=${connection.user}`,
      '--connect-timeout=5',
      '--default-character-set=utf8mb4',
      '--batch',
      '--skip-column-names',
    ],
    {
      input: sql,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, MYSQL_PWD: connection.password },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Database client failed: ${safeClientError(result)}`);
  }
  return result.stdout.trim();
}

function replaceValue(contents, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'mu');
  return pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.trimEnd()}\n${line}\n`;
}

const defaultSource = resolve(projectRoot, '..', 'examcheck', '.env');
const sourcePath = resolve(
  argument('--source-env') ?? process.env.LINKALIVE_DB_SOURCE_ENV ?? defaultSource,
);
if (!existsSync(sourcePath)) {
  throw new Error(`Source environment file was not found: ${sourcePath}`);
}

const source = parseEnv(readFileSync(sourcePath, 'utf8'));
const bootstrap = {
  host: source.DB_HOST ?? '127.0.0.1',
  port: source.DB_PORT ?? '3306',
  user: source.DB_USER ?? '',
  password: source.DB_PASSWORD ?? '',
};
if (!bootstrap.user) throw new Error('The source environment does not define DB_USER.');
if (!/^\d{1,5}$/u.test(bootstrap.port)) throw new Error('The source DB_PORT is invalid.');

const database = 'linkalive';
const applicationUser = 'linkalive_app';
const applicationPassword = randomBytes(32).toString('hex');
const client = findClient();
const sql = `
CREATE DATABASE IF NOT EXISTS \`${database}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${applicationUser}'@'127.0.0.1' IDENTIFIED BY '${applicationPassword}';
ALTER USER '${applicationUser}'@'127.0.0.1' IDENTIFIED BY '${applicationPassword}';
CREATE USER IF NOT EXISTS '${applicationUser}'@'localhost' IDENTIFIED BY '${applicationPassword}';
ALTER USER '${applicationUser}'@'localhost' IDENTIFIED BY '${applicationPassword}';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${applicationUser}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${applicationUser}'@'localhost';
FLUSH PRIVILEGES;
`;
runClient(client, bootstrap, sql);

const applicationConnection = {
  host: '127.0.0.1',
  port: bootstrap.port,
  user: applicationUser,
  password: applicationPassword,
};
const serverIdentity = runClient(
  client,
  applicationConnection,
  `SELECT CONCAT(DATABASE(), '|', VERSION()); USE \`${database}\`; SELECT CONCAT(DATABASE(), '|', VERSION());`,
)
  .split(/\r?\n/u)
  .at(-1);
if (!serverIdentity?.startsWith(`${database}|`)) {
  throw new Error('The application account could not verify the new database.');
}

const templatePath = resolve(projectRoot, '.env.example');
const targetPath = resolve(projectRoot, '.env');
let target = existsSync(targetPath)
  ? readFileSync(targetPath, 'utf8')
  : readFileSync(templatePath, 'utf8');
const databaseUrl = `mysql://${applicationUser}:${applicationPassword}@127.0.0.1:${bootstrap.port}/${database}`;
target = replaceValue(target, 'DATABASE_URL', databaseUrl);
if (!existsSync(targetPath)) {
  target = replaceValue(target, 'ADMIN_PASSWORD', randomBytes(24).toString('base64url'));
  target = replaceValue(target, 'AUTH_SECRET', randomBytes(48).toString('base64url'));
  target = replaceValue(target, 'ENCRYPTION_KEY', randomBytes(32).toString('base64'));
}
writeFileSync(targetPath, target, { encoding: 'utf8', mode: 0o600 });

const [, version] = serverIdentity.split('|', 2);
console.log(
  JSON.stringify({
    ok: true,
    engineVersion: version,
    host: applicationConnection.host,
    port: Number(applicationConnection.port),
    database,
    applicationUser,
    environmentFile: targetPath,
    secretsPrinted: false,
  }),
);

import pgConnectionString from "pg-connection-string";
import postgres, { Sql } from "postgres";

function getPostgresConfig() {
  return {
    user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD ?? "postgres",
    host: process.env.PGHOST ?? "localhost",
    port: process.env.PGPORT ?? "5432",
  };
}

function getDefaultPostgresUrl(): string {
  const { user, password, host, port } = getPostgresConfig();
  const database = process.env.PGDATABASE ?? "postgres";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

export function getTestDatabaseUrl(databaseName: string): string {
  const { user, password, host, port } = getPostgresConfig();
  return `postgres://${user}:${password}@${host}:${port}/${databaseName}`;
}

export function generateTestDatabaseName(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function setupTestDatabase(params: {
  databaseName: string;
  postgresUrl?: string;
}): Promise<{ sql: Sql; databaseUrl: string; drop: () => Promise<void> }> {
  const { databaseName, postgresUrl = getDefaultPostgresUrl() } = params;

  const config = pgConnectionString.parse(postgresUrl);
  
  // Connect to default database to create test database
  const adminSql = postgres({
    host: config.host ?? "localhost",
    port: config.port ? parseInt(config.port, 10) : 5432,
    user: config.user ?? "postgres",
    password: config.password ?? "postgres",
    database: config.database ?? "postgres",
  });

  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
  await adminSql.end();

  // Connect to test database
  const databaseUrl = `postgres://${config.user ?? "postgres"}:${config.password ?? "postgres"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${databaseName}`;
  const sql = postgres(databaseUrl);

  const drop = async () => {
    await sql.end();
    const dropSql = postgres({
      host: config.host ?? "localhost",
      port: config.port ? parseInt(config.port, 10) : 5432,
      user: config.user ?? "postgres",
      password: config.password ?? "postgres",
      database: config.database ?? "postgres",
    });
    await dropSql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await dropSql.end();
  };

  return { sql, databaseUrl, drop };
}

export const typeColumnTsTypeEntries = [
  ["bigint", "bigint"],
  ["bigserial", "bigserial"],
  ["bit", "bit"],
  ["bool", "boolean"],
  ["boolean", "boolean"],
  ["box", "box"],
  ["bpchar", "bpchar"],
  ["bytea", "bytea"],
  ["char", "char"],
  ["character", "character"],
  ["character varying", "character varying"],
  ["cidr", "cidr"],
  ["circle", "circle"],
  ["date", "date"],
  ["double precision", "float8"],
  ["float4", "float4"],
  ["float8", "float8"],
  ["inet", "inet"],
  ["int", "int4"],
  ["int2", "int2"],
  ["int4", "int4"],
  ["int8", "int8"],
  ["integer", "int4"],
  ["interval", "interval"],
  ["json", "json"],
  ["jsonb", "jsonb"],
  ["line", "line"],
  ["lseg", "lseg"],
  ["macaddr", "macaddr"],
  ["macaddr8", "macaddr8"],
  ["money", "money"],
  ["numeric", "numeric"],
  ["path", "path"],
  ["pg_lsn", "pg_lsn"],
  ["pg_snapshot", "pg_snapshot"],
  ["point", "point"],
  ["polygon", "polygon"],
  ["real", "float4"],
  ["serial", "serial"],
  ["serial2", "serial2"],
  ["serial4", "serial4"],
  ["serial8", "serial8"],
  ["smallint", "int2"],
  ["smallserial", "smallserial"],
  ["text", "text"],
  ["time", "time"],
  ["time with time zone", "timetz"],
  ["time without time zone", "time"],
  ["timestamp", "timestamp"],
  ["timestamp with time zone", "timestamptz"],
  ["timestamp without time zone", "timestamp"],
  ["timestamptz", "timestamptz"],
  ["timetz", "timetz"],
  ["tsquery", "tsquery"],
  ["tsvector", "tsvector"],
  ["txid_snapshot", "txid_snapshot"],
  ["uuid", "uuid"],
  ["varbit", "varbit"],
  ["varchar", "varchar"],
  ["xml", "xml"],
] as const;

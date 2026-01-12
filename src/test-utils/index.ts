import postgres, { Sql } from "postgres";
import { mapConnectionOptionsToString, parseConnection } from "../utils/pg.utils";

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres";

function getPostgresConfig() {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  console.log("[test-utils] DATABASE_URL env:", process.env.DATABASE_URL);
  console.log("[test-utils] Using databaseUrl:", databaseUrl);
  const config = parseConnection(databaseUrl);
  console.log("[test-utils] Parsed config:", config);
  return config;
}

export function generateTestDatabaseName(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function setupTestDatabase(params: {
  databaseName: string;
}): Promise<{ sql: Sql; databaseUrl: string; drop: () => Promise<void> }> {
  const { databaseName } = params;
  const config = getPostgresConfig();
  
  // Connect to default database to create test database
  const adminSql = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });

  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
  await adminSql.end();

  // Connect to test database
  const databaseUrl = mapConnectionOptionsToString({ ...config, database: databaseName });
  const sql = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: databaseName,
  });

  const drop = async () => {
    await sql.end();
    const dropSql = postgres({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
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

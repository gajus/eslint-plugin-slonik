import postgres, { Sql } from "postgres";
import { match } from "ts-pattern";
import { RuleOptionConnection } from "../rules/RuleOptions";
import {
  ConnectionPayload,
  getConnectionStrategyByRuleOptionConnection,
} from "../rules/check-sql.utils";
import { O, pipe } from "./fp-ts";
import { mapConnectionOptionsToString, parseConnection } from "./pg.utils";

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export interface ConnectionOptions {
  postgresOptions?: postgres.Options<any>;
  connectionTimeout?: number;
}

export class ConnectionFailedError extends Error {
  readonly _tag = "ConnectionFailedError" as const;

  constructor(
    public readonly databaseUrl: string,
    public readonly originalError: Error,
  ) {
    super(`Connection to database failed: ${originalError.message}`);
    this.name = "ConnectionFailedError";
  }
}

export function createConnectionManager() {
   
  const connectionMap: Map<string, Sql<any>> = new Map();
  const failedConnections: Map<string, Error> = new Map();

  return {
     
    getOrCreate: (databaseUrl: string, options?: ConnectionOptions) =>
      getOrCreateConnection(databaseUrl, connectionMap, failedConnections, options),
    markFailed: (databaseUrl: string, error: Error) => {
      failedConnections.set(databaseUrl, error);
      // Clean up the connection if it exists
      const sql = connectionMap.get(databaseUrl);
      if (sql) {
        sql.end().catch(() => {});
        connectionMap.delete(databaseUrl);
      }
    },
    isConnectionFailed: (databaseUrl: string) => failedConnections.has(databaseUrl),
    getFailedError: (databaseUrl: string) => failedConnections.get(databaseUrl),
    close: (params: CloseConnectionParams) => closeConnection(params, connectionMap),
  };
}

function getOrCreateConnection(
  databaseUrl: string,
   
  connectionMap: Map<string, Sql<any>>,
  failedConnections: Map<string, Error>,
   
  options?: ConnectionOptions,
): ConnectionPayload {
  // Check if this connection has previously failed - bail out early
  const previousError = failedConnections.get(databaseUrl);
  if (previousError) {
    throw new ConnectionFailedError(databaseUrl, previousError);
  }

  return pipe(
    O.fromNullable(connectionMap.get(databaseUrl)),
    O.foldW(
      () => {
        // Parse URL to ensure credentials are extracted, not inferred from env
        const config = parseConnection(databaseUrl);
        const timeoutMs = options?.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS;
        const sql = postgres({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
          connect_timeout: Math.ceil(timeoutMs / 1_000),
          ...options?.postgresOptions,
        });
        connectionMap.set(databaseUrl, sql);
        return { sql, databaseUrl, isFirst: true };
      },
      (sql) => ({ sql, databaseUrl, isFirst: false }),
    ),
  );
}

export interface CloseConnectionParams {
  connection: RuleOptionConnection;
  projectDir: string;
}

 
function closeConnection(params: CloseConnectionParams, connectionMap: Map<string, Sql<any>>) {
  const { connection, projectDir } = params;
  const strategy = getConnectionStrategyByRuleOptionConnection({ connection, projectDir });

  match(strategy)
    .with({ type: "databaseUrl" }, ({ databaseUrl }) => {
      const sql = connectionMap.get(databaseUrl);
      if (sql) {
        sql.end();
        connectionMap.delete(databaseUrl);
      }
    })
    .with({ type: "migrations" }, ({ connectionUrl, databaseName }) => {
      const connectionOptions = { ...parseConnection(connectionUrl), database: databaseName };
      const databaseUrl = mapConnectionOptionsToString(connectionOptions);
      const sql = connectionMap.get(databaseUrl);
      const migrationSql = connectionMap.get(connectionUrl);
      if (sql) {
        sql.end();
        connectionMap.delete(databaseUrl);
      }
      if (migrationSql) {
        migrationSql.end();
        connectionMap.delete(connectionUrl);
      }
    })
    .exhaustive();
}
